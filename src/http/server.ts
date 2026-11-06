import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createMcpHandler, type AuthInfo, type McpHttpHandler } from "@modelcontextprotocol/server";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { A2AServer } from "../a2a/server.js";
import { A2A_ERRORS, A2A_WELL_KNOWN } from "../a2a/types.js";
import { buildMcpServer } from "../mcp/server.js";
import { DOCUMENT_FILES, documentsDir, readManifest } from "../node/documents.js";
import { buildPropagationManifest, servicesCatalogOf } from "../node/propagation.js";
import type { Node } from "../node/node.js";
import type { Watchers } from "../node/watchers.js";
import { PUBLIC_CALLER, type Caller, type Catalog, type Mode } from "../tools/index.js";
import { resolveCaller } from "./access.js";
import { NonceCache } from "./signed.js";

export { callerFromAuthorization, newApiKey } from "./access.js";

/**
 * The HTTP entrance (design memo, Phase 3, section 5): a `node:http` server with the JSON API (`POST /api/<capability>`),
 * MCP over Streamable HTTP (`/mcp`, both protocol eras, stateless), the health and status pages, and the public
 * documents' paths (3d). It adds no rule of its own: a request becomes a caller — the public (read and build) or
 * the holder of an API key (what the key's grant says) — and the catalog decides. Boundaries at the edge: a request
 * body is capped, a browser's Origin must be allowed, the Host header must be one this server answers for, each
 * address has a request budget per minute, no CORS headers, no cookies, and nothing of a key ever reaches a log.
 * A third way in beside no credential and a Bearer key: `Authorization: FOGA-EIP712 <envelope>`, an address proving
 * itself with its wallet (src/http/signed.ts, src/http/access.ts); what it is granted is the configuration's.
 */
export interface HttpServerOptions {
  node: Node;
  catalog: Catalog;
  version: string;
  watchers?: Watchers;
  log?: (line: string) => void;
}

export interface RunningHttpServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

/** A token bucket per client address: `limit` requests per minute, refilled continuously. */
class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly perMinute: number) {}
  take(key: string): boolean {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.perMinute, at: now };
    b.tokens = Math.min(this.perMinute, b.tokens + ((now - b.at) / 60_000) * this.perMinute);
    b.at = now;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) for (const [k, v] of this.buckets) if (now - v.at > 120_000) this.buckets.delete(k);
    return true;
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function hostnameOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(`http://${value}`).hostname;
  } catch {
    return null;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** The client address: the socket's, or the first X-Forwarded-For entry when the socket is the loopback (a reverse proxy on this host). */
function clientAddress(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? "unknown";
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded && (remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1")) {
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded).split(",")[0].trim();
    if (first) return first;
  }
  return remote;
}

export function createHttpServer(o: HttpServerOptions): { server: Server; listen(hostPort: string): Promise<RunningHttpServer> } {
  const { node, catalog } = o;
  const cfg = node.config;
  const http = cfg.runtime.http;
  const log = o.log ?? node.log;
  const limiter = new RateLimiter(http.rateLimitPerMinute);
  const nonces = new NonceCache();
  const a2a = new A2AServer(node, catalog, log);
  let loopback = false;

  const mcp: McpHttpHandler = createMcpHandler(
    (ctx) => {
      const caller = (ctx.authInfo?.extra?.caller as Caller | undefined) ?? { ...PUBLIC_CALLER, entrance: "http" };
      return buildMcpServer({ node, catalog, caller, version: o.version });
    },
    { legacy: "stateless", maxRequestBodySize: http.maxBodyBytes, onerror: (e) => log(`mcp: ${e.message}`) },
  );

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = req.method ?? "GET";

    // the edge: budget per address, the Host this server answers for, the Origin a browser sends
    if (!limiter.take(clientAddress(req))) return json(res, 429, { ok: false, gate: "rate", reason: `more than ${http.rateLimitPerMinute} requests a minute from this address` });
    const host = hostnameOf(req.headers.host);
    const allowedHosts = http.allowedHosts.length ? http.allowedHosts : loopback ? [...LOCAL_HOSTS] : null;
    if (allowedHosts && (!host || !allowedHosts.includes(host))) return json(res, 403, { ok: false, gate: "host", reason: "this server does not answer for that Host" });
    const origin = req.headers.origin;
    if (origin) {
      const originHost = hostnameOf(origin.replace(/^https?:\/\//, ""));
      const allowedOrigins = [...http.allowedOrigins, ...(loopback ? LOCAL_HOSTS : [])];
      if (!originHost || !allowedOrigins.includes(originHost)) return json(res, 403, { ok: false, gate: "origin", reason: "Origin not allowed" });
    }

    // the body first (a signature may be bound to it), then who is calling
    const bodyless = method === "GET" || method === "HEAD" || method === "DELETE";
    const body = bodyless ? null : await readBody(req, http.maxBodyBytes);
    if (body === null && !bodyless) return json(res, 413, { ok: false, gate: "input", reason: `request body over ${http.maxBodyBytes} bytes` });
    const resolved = await resolveCaller({ node, authorization: req.headers.authorization, method, path: url.pathname + url.search, body: body ? new Uint8Array(body) : null, nonces });
    if (!resolved.caller) return json(res, resolved.status, { ok: false, gate: "permission", reason: resolved.reason });
    const caller = resolved.caller;

    if (url.pathname === "/mcp") {
      // headers pass through, the caller rides in authInfo
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && k !== "authorization") headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      const request = new Request(url, { method, headers, body: body ? new Uint8Array(body) : undefined });
      const authInfo: AuthInfo = { token: caller.id, clientId: caller.id, scopes: [caller.level], extra: { caller } };
      const response = await mcp.fetch(request, { authInfo });
      const out: Record<string, string> = {};
      response.headers.forEach((v, k) => (out[k] = v));
      out["cache-control"] = "no-store";
      res.writeHead(response.status, out);
      if (response.body) for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
      res.end();
      return;
    }

    // A2A 1.0, the JSON-RPC binding: the version as a header (or the A2A-Version query parameter), JSON in and out
    if (url.pathname === "/a2a") {
      if (method !== "POST") return json(res, 405, { jsonrpc: "2.0", id: null, error: { code: A2A_ERRORS.InvalidRequestError, message: "POST a JSON-RPC 2.0 request" } });
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return json(res, 415, { jsonrpc: "2.0", id: null, error: { code: A2A_ERRORS.InvalidRequestError, message: "Content-Type must be application/json" } });
      let rpc: unknown;
      try {
        rpc = body && body.length ? JSON.parse(body.toString("utf8")) : null;
      } catch {
        return json(res, 200, { jsonrpc: "2.0", id: null, error: { code: A2A_ERRORS.JSONParseError, message: "Invalid JSON payload" } });
      }
      const versionHeader = req.headers["a2a-version"];
      const version = (Array.isArray(versionHeader) ? versionHeader[0] : versionHeader) ?? url.searchParams.get("A2A-Version") ?? undefined;
      // A2A-Extensions a client declares are ignored: this agent requires none and offers none
      return json(res, 200, await a2a.handle(rpc, caller, version));
    }

    if (method === "GET" && url.pathname === "/healthz") {
      let block: number | null = null;
      try {
        block = await node.kernel.blockNumber();
      } catch {
        block = null;
      }
      return json(res, block === null ? 503 : 200, { ok: block !== null, cell: cfg.name, account: node.cell?.address ?? null, worldId: node.world.file.worldId, chainId: node.chainId, block, version: o.version });
    }
    if (method === "GET" && url.pathname === "/") {
      const r = await catalog.invoke(node, "cell_status", {}, caller);
      const decisions = node.store.summary().decisions;
      return json(res, 200, { foga: o.version, cell: cfg.name, status: r.ok ? r.output : null, decisions, endpoints: { mcp: "/mcp", api: "/api/<capability>", a2a: "/a2a", agentCard: A2A_WELL_KNOWN, manifest: "/.well-known/foga-cell.json", documents: "/documents/<file>", health: "/healthz" } });
    }
    if (method === "GET" && url.pathname === "/api/capabilities") return json(res, 200, { caller: { id: caller.id, level: caller.level, visibility: caller.visibility, via: resolved.via }, capabilities: catalog.list(caller) });
    const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && jobMatch) return answer(res, await catalog.invoke(node, "job_status", { jobId: decodeURIComponent(jobMatch[1]) }, caller));
    const opMatch = /^\/api\/operations\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && opMatch) return answer(res, await catalog.invoke(node, "operation_status", { operationId: decodeURIComponent(opMatch[1]) }, caller));
    if (method === "GET" && url.pathname === "/api/decisions") return answer(res, await catalog.invoke(node, "decision_list", Object.fromEntries(url.searchParams), caller));
    const capMatch = /^\/api\/([a-z][a-z0-9_]*)$/.exec(url.pathname);
    if (capMatch) {
      const name = capMatch[1];
      const cap = catalog.get(name);
      if (!cap) return json(res, 404, { ok: false, gate: "input", reason: `unknown capability ${name}` });
      if (method !== "POST" && !(method === "GET" && cap.action === "read")) return json(res, 405, { ok: false, gate: "input", reason: "POST the input as JSON (GET for a read with query parameters)" });
      let input: unknown = {};
      if (method === "POST") {
        if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return json(res, 415, { ok: false, gate: "input", reason: "Content-Type must be application/json" });
        try {
          input = body && body.length ? JSON.parse(body.toString("utf8")) : {};
        } catch {
          return json(res, 400, { ok: false, gate: "input", reason: "the body is not JSON" });
        }
      } else input = Object.fromEntries(url.searchParams);
      const mode = (url.searchParams.get("mode") ?? "act") as Mode;
      if (!["simulate", "build", "act"].includes(mode)) return json(res, 400, { ok: false, gate: "input", reason: "mode must be simulate, build or act" });
      return answer(res, await catalog.invoke(node, name, input, caller, { mode }));
    }
    // the propagation manifest: free, built live from the configuration, answered even before any document is published
    if (method === "GET" && url.pathname === "/.well-known/foga-cell.json") {
      const text = Buffer.from(JSON.stringify(buildPropagationManifest(node, { version: o.version }), null, 2) + "\n");
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300", "content-length": text.length });
      res.end(text);
      return;
    }
    // the services catalog, when the one this cell's manifest points at is its own (the reference cell: the maintainer's list);
    // a static file at this path on the host, answered by the proxy before the node, is how the list changes without a release
    if (method === "GET" && url.pathname === "/services.json") {
      const doc = servicesCatalogOf(node, { version: o.version });
      if (!doc) return json(res, 404, { ok: false, reason: "this cell's services pointer names another catalog; read it from the manifest at /.well-known/foga-cell.json" });
      const text = Buffer.from(JSON.stringify(doc, null, 2) + "\n");
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300", "content-length": text.length });
      res.end(text);
      return;
    }
    // the published documents (foga cell docs build): served as built, by their file names, and at the well-known paths
    if (method === "GET" && (url.pathname.startsWith("/.well-known/") || url.pathname.startsWith("/documents/"))) {
      const dir = documentsDir(node);
      const manifest = readManifest(dir);
      if (!manifest) return json(res, 404, { ok: false, reason: "not published yet" });
      let file: string | null = null;
      if (url.pathname === A2A_WELL_KNOWN) file = DOCUMENT_FILES.agentCard;
      else if (url.pathname === "/.well-known/agent-registration.json") file = DOCUMENT_FILES.registration;
      else if (url.pathname.startsWith("/documents/")) {
        const name = basename(decodeURIComponent(url.pathname.slice("/documents/".length)));
        if (name === "manifest.json" || Object.values(DOCUMENT_FILES).includes(name as (typeof DOCUMENT_FILES)[keyof typeof DOCUMENT_FILES])) file = name;
      }
      const path = file ? join(dir, file) : null;
      if (!path || !existsSync(path)) return json(res, 404, { ok: false, reason: "no such document" });
      const text = readFileSync(path);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300", "content-length": text.length });
      res.end(text);
      return;
    }
    json(res, 404, { ok: false, reason: "no such path" });
  }

  function answer(res: ServerResponse, r: Awaited<ReturnType<Catalog["invoke"]>>): void {
    if (r.ok) return json(res, 200, r);
    // credentials and permission are HTTP's business; a business refusal is an ordinary answer with ok: false
    if (r.gate === "permission") return json(res, 403, r);
    if (r.gate === "input") return json(res, 400, r);
    json(res, 200, r);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      log(`http: ${req.method} ${req.url}: ${(e as Error).message}`);
      if (!res.headersSent) json(res, 500, { ok: false, reason: "internal error" });
      else res.end();
    });
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;

  return {
    server,
    listen(hostPort: string) {
      const [hostRaw, portRaw] = splitHostPort(hostPort);
      loopback = LOCAL_HOSTS.has(hostRaw);
      return new Promise<RunningHttpServer>((resolve, reject) => {
        server.once("error", reject);
        server.listen(Number(portRaw), hostRaw === "[::1]" ? "::1" : hostRaw, () => {
          const addr = server.address();
          const port = typeof addr === "object" && addr ? addr.port : Number(portRaw);
          const url = `http://${hostRaw.includes(":") && !hostRaw.startsWith("[") ? `[${hostRaw}]` : hostRaw}:${port}`;
          resolve({ server, url, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
        });
      });
    },
  };
}

function splitHostPort(hostPort: string): [string, string] {
  const i = hostPort.lastIndexOf(":");
  if (i < 0) return ["127.0.0.1", hostPort];
  return [hostPort.slice(0, i) || "127.0.0.1", hostPort.slice(i + 1)];
}

/** Run the watchers on the poll interval beside the server; returns a stop function. */
export function startWatchLoop(watchers: Watchers, intervalMs: number, log: (line: string) => void): () => void {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const r = await watchers.tick();
      log(`${r.at} block ${r.block}: anchor ${r.anchor}, heartbeat ${r.heartbeat.sent ? "sent" : "not sent"} (${r.heartbeat.reason}); ${r.discovered.length} new tender(s); ${r.settled.filter((x) => x.outcome === "settled").length} settled${r.settled.some((x) => x.outcome !== "settled") ? ` (${r.settled.filter((x) => x.outcome !== "settled").map((x) => `${x.tokenId}: ${x.outcome}`).join("; ")})` : ""}, ${r.withdrawn.length} withdrawn; safety ${r.safety.verdict}${r.safety.changed ? " (changed)" : ""}`);
    } catch (e) {
      log(`watch: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
