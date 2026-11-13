/**
 * `--world` names a deployed world's address book by path or, since 1.0.9, by `https://` URL — the chain-neutral way
 * to reach a world FOGA's chain table knows nothing about: a project publishes its address book (a `foga.world/1`
 * file) and a cell anywhere joins it with `foga join --world https://… --rpc <its rpc>`, no FOGA release in between.
 *
 * A URL is fetched once per command, checked to be a world file, and kept as a plain file under `~/.foga/worlds/`
 * (`FOGA_HOME` honoured, `FOGA_WORLDS_DIR` overrides) named by chain id, worldId and the hash of its content — two
 * projects that chose the same worldId on two chains, or two revisions of one address book, are two files and never
 * overwrite each other. The command then runs on that file exactly as it runs on a path, so everything downstream —
 * the copy `foga join` makes into the cell directory, the genesis store, the doctor's report — is unchanged; the
 * sha256 of the bytes received is logged and returned, so a record can say which file it was.
 *
 * Only `https://` is accepted: the file names every contract a cell will trust, and a plain-http fetch can be rewritten
 * on the way. `http://127.0.0.1` and `http://localhost` are the one exception (a local server in a test or a rehearsal).
 * The fields a remote file contributes to local paths (`worldId`, `network`, `name`) are checked against a strict
 * character set before anything is written.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const WORLD_SCHEMA = "foga.world/1";
const FETCH_TIMEOUT_MS = 30_000;
const MAX_BYTES = 4 * 1024 * 1024;
/** One path segment: letters, digits, `.`, `_`, `-`; no separators, no leading dot. */
export const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export interface WorldSource {
  /** The local file the command reads: the path given, or the cached copy of the URL. */
  path: string;
  /** The URL the file came from, when it did. */
  url: string | null;
  /** sha256 of the bytes received, when fetched. */
  sha256: string | null;
  worldId: string | null;
  chainId: number | null;
}

export function isWorldUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** True when a world-file field is safe to use as one segment of a local path. */
export function safeSegment(value: unknown): value is string {
  return typeof value === "string" && SEGMENT.test(value);
}

export function sha256Of(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function worldsDir(): string {
  return process.env.FOGA_WORLDS_DIR ?? join(process.env.FOGA_HOME ?? join(homedir(), ".foga"), "worlds");
}

/** The checks every address book passes before a command trusts it, whatever it came from. */
export function checkWorldJson(text: string, from: string): { worldId: string; chainId: number; network: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${from} is not JSON`);
  }
  const w = parsed as { schema?: unknown; worldId?: unknown; chainId?: unknown; network?: unknown; contracts?: unknown };
  if (w.schema !== WORLD_SCHEMA) throw new Error(`${from} is not a world file (schema ${String(w.schema)}; a deployed world's address book has schema ${WORLD_SCHEMA})`);
  if (!safeSegment(w.worldId)) throw new Error(`${from}: the world file has no usable worldId (letters, digits, '.', '_' and '-' only)`);
  if (typeof w.chainId !== "number" || !Number.isInteger(w.chainId) || w.chainId <= 0) throw new Error(`${from}: the world file has no chainId`);
  if (w.network !== undefined && !safeSegment(w.network)) throw new Error(`${from}: the world file's network is not a usable name (letters, digits, '.', '_' and '-' only)`);
  if (!w.contracts || typeof w.contracts !== "object") throw new Error(`${from}: the world file lists no contracts`);
  return { worldId: w.worldId, chainId: w.chainId, network: typeof w.network === "string" ? w.network : null };
}

/**
 * Resolve a `--world` value. A path comes back resolved and untouched; a URL comes back as the path of its cached
 * copy. `log` gets one line for a fetch. `fetchImpl` is for tests.
 */
export async function resolveWorldSource(value: string, o: { log?: (line: string) => void; fetchImpl?: typeof fetch; dir?: string } = {}): Promise<WorldSource> {
  if (!isWorldUrl(value)) return { path: resolve(value), url: null, sha256: null, worldId: null, chainId: null };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`--world: ${value} is not a URL`);
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !local) throw new Error(`--world: ${value} must be https:// (the file names every contract the cell will trust; plain http is refused)`);
  const doFetch = o.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let text: string;
  try {
    const res = await doFetch(url, { signal: controller.signal, redirect: "follow", headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_BYTES) throw new Error(`more than ${MAX_BYTES} bytes`);
    text = buf.toString("utf8");
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(`--world: could not fetch ${value} (${why})`);
  } finally {
    clearTimeout(timer);
  }
  const { worldId, chainId } = checkWorldJson(text, value);
  const sha256 = sha256Of(text);
  const dir = o.dir ?? worldsDir();
  mkdirSync(dir, { recursive: true });
  // named by chain, world and content: the same name means the same bytes, so nothing here is ever overwritten
  const path = join(dir, `${chainId}-${worldId}-${sha256.slice(0, 12)}.json`);
  const same = existsSync(path) && readFileSync(path, "utf8") === text;
  if (!same) writeFileSync(path, text);
  o.log?.(`world ${worldId} (chain ${chainId}) from ${value} (sha256 ${sha256.slice(0, 16)}…) ${same ? "unchanged at" : "kept at"} ${path}`);
  return { path, url: value, sha256, worldId, chainId };
}
