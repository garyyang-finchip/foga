import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (the directory that holds package.json). */
export function repoRoot(): string {
  // src/util/fs.ts -> repo root is two levels up; dist/util/fs.js -> same shape.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..");
}

export function readJson<T = any>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function rmrf(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export function copyTree(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

export function exists(path: string): boolean {
  return existsSync(path);
}

/** Recursively list files under `dir` (absolute paths). */
export function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Deterministic JSON: keys sorted at every level, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: any): any {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}
