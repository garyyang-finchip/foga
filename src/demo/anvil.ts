import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";

/**
 * A local chain for the demos (`foga demo`, `foga quickstart`): finding anvil, starting it with its output in a log
 * file, waiting for its RPC, and saying what is wrong in the words a first run needs — the binary missing (with the
 * install path per platform), the port taken, the glibc too old for the dynamic build.
 */

/** The anvil binary this machine offers: FOGA_FOUNDRY_DIR/anvil (scripts/install-foundry.sh) or anvil on PATH. */
export function anvilBinary(): { path: string; fromDir: string | null } {
  const dir = process.env.FOGA_FOUNDRY_DIR;
  return { path: dir ? join(dir, "anvil") : "anvil", fromDir: dir ?? null };
}

/** anvil's version line, or null when the binary cannot be run from here. */
export function anvilVersion(path: string): string | null {
  try {
    return execFileSync(path, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n")[0];
  } catch {
    return null;
  }
}

export const ANVIL_INSTALL_HINT = [
  "anvil (Foundry) is not installed, or not where FOGA_FOUNDRY_DIR says.",
  "  Linux, macOS:  curl -L https://foundry.sh | bash && foundryup   (an older glibc: scripts/install-foundry.sh, then export FOGA_FOUNDRY_DIR=~/.foga/foundry)",
  "  Windows:       download the win32_amd64 zip of a release from https://github.com/foundry-rs/foundry/releases, unzip it, and put the folder",
  "                 holding anvil.exe on PATH (or set FOGA_FOUNDRY_DIR to that folder); then open a new terminal",
  "  any platform:  docker compose (docker/) runs the toolchain with anvil inside",
].join("\n");

/** True when something accepts TCP connections on 127.0.0.1:port. */
export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (v: boolean) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export async function rpcAnswers(rpc: string): Promise<boolean> {
  try {
    const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function waitForRpc(rpc: string, timeoutMs: number, giveUp?: () => boolean): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await rpcAnswers(rpc)) return;
    if (giveUp?.()) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`RPC at ${rpc} did not come up within ${timeoutMs} ms`);
}

/** Why a port cannot be used for a new anvil: another RPC already answers there, or something else holds it. */
export async function portProblem(port: number): Promise<string | null> {
  if (!(await portInUse(port))) return null;
  const rpc = `http://127.0.0.1:${port}`;
  return (await rpcAnswers(rpc))
    ? `${rpc} already answers JSON-RPC (another anvil or node is running). Stop it, or pass --port <n> to use another port.`
    : `port ${port} is in use by something that does not speak JSON-RPC. Free it, or pass --port <n>.`;
}

export interface LaunchAnvilOptions {
  port: number;
  /** anvil's output goes to a file rather than a pipe: a Rust program whose stderr pipe has gone away dies on its next write. */
  logPath: string;
  /** Start anvil in its own process group so it survives this process (`foga demo --keep`). */
  detached?: boolean;
  /** Extra anvil arguments. */
  args?: string[];
  timeoutMs?: number;
}

/**
 * Start anvil and wait until its RPC answers. Rejects with a message fit to print when the binary is missing, when
 * anvil stops before serving (its output quoted, the glibc case named) or when it does not come up in time.
 */
export async function launchAnvil(o: LaunchAnvilOptions): Promise<ChildProcess> {
  const { path: bin, fromDir } = anvilBinary();
  const rpc = `http://127.0.0.1:${o.port}`;
  mkdirSync(dirname(o.logPath), { recursive: true });
  const logFd = openSync(o.logPath, "w");
  const child = spawn(bin, ["--port", String(o.port), "--silent", ...(o.args ?? [])], { stdio: ["ignore", logFd, logFd], detached: Boolean(o.detached) });
  closeSync(logFd);
  let exited: string | null = null;
  child.on("exit", (code, signal) => {
    exited = code !== null ? `exit code ${code}` : `signal ${signal}`;
  });
  const spawnError = new Promise<never>((_, reject) => {
    child.once("error", (e: NodeJS.ErrnoException) => {
      reject(new Error(e.code === "ENOENT" ? (fromDir ? `${bin} not found (FOGA_FOUNDRY_DIR=${fromDir}). Run scripts/install-foundry.sh ${fromDir} first, or unset FOGA_FOUNDRY_DIR to use anvil on PATH.\n${ANVIL_INSTALL_HINT}` : `anvil not found on PATH.\n${ANVIL_INSTALL_HINT}`) : `could not start anvil: ${e.message}`));
    });
  });
  const timeoutMs = o.timeoutMs ?? 20_000;
  try {
    await Promise.race([waitForRpc(rpc, timeoutMs, () => exited !== null), spawnError]);
  } catch (e) {
    if (!child.killed && child.exitCode === null) child.kill("SIGTERM");
    if ((e as NodeJS.ErrnoException).message?.startsWith("RPC at ")) {
      let output = "";
      try {
        output = readFileSync(o.logPath, "utf8").slice(-8000);
      } catch {
        /* no log */
      }
      const why = exited ? `anvil stopped (${exited}) before serving ${rpc}` : `anvil did not serve ${rpc} within ${timeoutMs / 1000} s`;
      const glibc = /GLIBC_[0-9.]+' not found/.test(output)
        ? "\nThis anvil is the glibc build and this machine's glibc is older than it needs (GLIBC >= 2.35: Ubuntu 22.04 or newer). Install the static build next to it: `scripts/install-foundry.sh` then `export FOGA_FOUNDRY_DIR=~/.foga/foundry` (or put that directory first on PATH)."
        : "";
      throw new Error(`${why}.${output.trim() ? `\n--- anvil output ---\n${output.trim()}\n--------------------` : ""}${glibc}\nRun \`${bin} --port ${o.port}\` by hand to see its output; \`${bin} --version\` shows the installed version (CI uses Foundry v1.7.1).`);
    }
    throw e;
  }
  return child;
}

/** Stop a child and wait for it to be gone (SIGTERM, then SIGKILL after a grace period). */
export async function stopChild(child: ChildProcess, graceMs = 5000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill("SIGTERM");
  await Promise.race([gone, new Promise((r) => setTimeout(r, graceMs))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([gone, new Promise((r) => setTimeout(r, 2000))]);
  }
}
