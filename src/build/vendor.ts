import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ensureDir, exists, readJson, repoRoot, rmrf } from "../util/fs.js";
import { log } from "../util/log.js";

export interface LockSource {
  erc: number;
  title: string;
  repo: string;
  url: string;
  commit: string;
  contractsRoot: string;
  upstreamToolchain: string;
  spec: { status: string; where: string; discussion: string };
}

export interface VendorLock {
  schema: "foga.vendor-lock/1";
  lockedAt: string;
  note: string;
  sources: LockSource[];
}

export function loadLock(path?: string): VendorLock {
  const p = path ?? join(repoRoot(), "vendor", "LOCK.json");
  const lock = readJson<VendorLock>(p);
  if (lock.schema !== "foga.vendor-lock/1") throw new Error(`unsupported lock schema in ${p}`);
  return lock;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function headCommit(dir: string): string | null {
  try {
    return git(dir, ["rev-parse", "HEAD"]);
  } catch {
    return null;
  }
}

/**
 * Materialize every locked source under vendor/<repo>/ at exactly the locked commit.
 * Existing directories already at the right commit are left untouched; anything else is replaced.
 */
export function syncVendor(opts: { lockPath?: string; vendorDir?: string; only?: string[] } = {}): void {
  const lock = loadLock(opts.lockPath);
  const vendorDir = opts.vendorDir ?? join(repoRoot(), "vendor");
  ensureDir(vendorDir);
  for (const src of lock.sources) {
    if (opts.only && !opts.only.includes(src.repo)) continue;
    const dir = join(vendorDir, src.repo);
    const have = exists(dir) ? headCommit(dir) : null;
    if (have === src.commit) {
      log.step(`${src.repo} already at ${src.commit.slice(0, 7)}`);
      continue;
    }
    if (exists(dir)) {
      log.step(`${src.repo}: replacing ${have ? have.slice(0, 7) : "non-git directory"} with ${src.commit.slice(0, 7)}`);
      rmrf(dir);
    } else {
      log.step(`${src.repo}: fetching ${src.commit.slice(0, 7)}`);
    }
    ensureDir(dir);
    git(dir, ["init", "-q"]);
    git(dir, ["remote", "add", "origin", src.url]);
    // GitHub serves fetches by commit id, so this is a one-commit shallow fetch of exactly the lock.
    git(dir, ["-c", "advice.detachedHead=false", "fetch", "-q", "--depth", "1", "origin", src.commit]);
    git(dir, ["-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD"]);
    const now = headCommit(dir);
    if (now !== src.commit) throw new Error(`${src.repo}: expected ${src.commit}, got ${now}`);
  }
}

/** Verify that every vendored tree is present and at the locked commit; returns the problems found. */
export function verifyVendor(opts: { lockPath?: string; vendorDir?: string } = {}): string[] {
  const lock = loadLock(opts.lockPath);
  const vendorDir = opts.vendorDir ?? join(repoRoot(), "vendor");
  const problems: string[] = [];
  for (const src of lock.sources) {
    const dir = join(vendorDir, src.repo);
    if (!exists(dir)) {
      problems.push(`${src.repo}: missing (run \`foga vendor sync\`)`);
      continue;
    }
    const have = headCommit(dir);
    if (have !== src.commit) problems.push(`${src.repo}: at ${have ?? "unknown"}, lock says ${src.commit}`);
  }
  return problems;
}
