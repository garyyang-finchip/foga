import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createMcpHandler, type AuthInfo, type McpHttpHandler } from "@modelcontextprotocol/server";
import { buildMcpServer } from "../mcp/server.js";
import type { CellConfig } from "../node/config.js";
import type { Node } from "../node/node.js";
import type { Watchers } from "../node/watchers.js";
import { PUBLIC_CALLER, type Caller, type Catalog, type Mode } from "../tools/index.js";

/**
 * The HTTP entrance (design memo, Phase 3, section 5): a `node:http` server with the JSON API (`POST /api/<capability>`),
 * MCP over Streamable HTTP (`/mcp`, both protocol eras, stateless), the health and status pages, and the public
 * documents' paths (3d). It adds no rule of its own: a request becomes a caller — the public (read and build) or
 * the holder of an API key (what the key's grant says) — and the catalog decides. Boundaries at the edge: a request
 * body is capped, a browser's Origin must be allowed, the Host header must be one this server answers for, each
 * address has a request budget per minute, no CORS headers, no cookies, and nothing of a key ever reaches a log.
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

const KEY_PREFIX = "foga";

/** Make an API key for a grant: shown once, stored only as its hash. */
export function newApiKey(id: string): { key: string; sha256: string } {
  const key = `${KEY_PREFIX}.${id}.${randomBytes(24).toString("base64url")}`;
  return { key, sha256: "0x" + createHash("sha256").update(key).digest("hex") };
}

/** The caller an Authorization header establishes: the public without one, the grant of a valid key, or null for an invalid key. */
export function callerFromAuthorization(cfg: CellConfig, header: string | undefined): Caller | null {
  if (!header) return { ...PUBLIC_CALLER, entrance: "http" };
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!m) return null;
  const key = m[1];
  const parts = key.split(".");
  if (parts.length !== 3 || parts[0] !== KEY_PREFIX) return null;
  const grant = cfg.access.keys.find((k) => k.id === parts[1]);
  if (!grant) return null;
  const given = Buffer.from(createHash("sha256").update(key).digest("hex"), "hex");
  const stored = Buffer.from(grant.sha256.slice(2), "hex");
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) return null;
  return { id: grant.id, entrance: "http", level: grant.level, visibility: grant.visibility };
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

    // who is calling
    const caller = callerFromAuthorization(cfg, req.headers.authorization);
    if (!caller) return json(res, 401, { ok: false, gate: "permission", reason: "the Authorization header carries no key this node knows" });

    if (url.pathname === "/mcp") {
      // the SDK reads and bounds the body itself; headers pass through, the caller rides in authInfo
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && k !== "authorization") headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      const body = method === "GET" || method === "HEAD" || method === "DELETE" ? undefined : await readBody(req, http.maxBodyBytes);
      if (body === null) return json(res, 413, { ok: false, gate: "input", reason: `request body over ${http.maxBodyBytes} bytes` });
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
      return json(res, 200, { foga: o.version, cell: cfg.name, status: r.ok ? r.output : null, decisions, endpoints: { mcp: "/mcp", api: "/api/<capability>", health: "/healthz" } });
    }
    if (method === "GET" && url.pathname === "/api/capabilities") return json(res, 200, { caller: { id: caller.id, level: caller.level, visibility: caller.visibility }, capabilities: catalog.list(caller) });
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
        const body = await readBody(req, http.maxBodyBytes);
        if (body === null) return json(res, 413, { ok: false, gate: "input", reason: `request body over ${http.maxBodyBytes} bytes` });
        try {
          input = body.length ? JSON.parse(body.toString("utf8")) : {};
        } catch {
          return json(res, 400, { ok: false, gate: "input", reason: "the body is not JSON" });
        }
      } else input = Object.fromEntries(url.searchParams);
      const mode = (url.searchParams.get("mode") ?? "act") as Mode;
      if (!["simulate", "build", "act"].includes(mode)) return json(res, 400, { ok: false, gate: "input", reason: "mode must be simulate, build or act" });
      return answer(res, await catalog.invoke(node, name, input, caller, { mode }));
    }
    if (url.pathname.startsWith("/.well-known/") || url.pathname.startsWith("/documents/")) return json(res, 404, { ok: false, reason: "not published yet" });
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
      log(`${r.at} block ${r.block}: anchor ${r.anchor}, heartbeat ${r.heartbeat.sent ? "sent" : "not sent"} (${r.heartbeat.reason}); ${r.discovered.length} new tender(s); ${r.settled.length} settled, ${r.withdrawn.length} withdrawn; safety ${r.safety.verdict}${r.safety.changed ? " (changed)" : ""}`);
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
