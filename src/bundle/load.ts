import { join } from "node:path";
import { readJson, repoRoot, exists } from "../util/fs.js";
import type { Bundle, BundleContract } from "./types.js";

export function defaultBundlePath(): string {
  return join(repoRoot(), "artifacts", "bundle.json");
}

export function loadBundle(path?: string): Bundle {
  const p = path ?? defaultBundlePath();
  if (!exists(p)) throw new Error(`bundle not found at ${p}; run \`foga build\` (needs \`foga vendor sync\` first)`);
  const bundle = readJson<Bundle>(p);
  if (bundle.schema !== "foga.bundle/1") throw new Error(`unsupported bundle schema ${String(bundle.schema)}`);
  return bundle;
}

export function getContract(bundle: Bundle, key: string): BundleContract {
  const c = bundle.contracts[key];
  if (!c) throw new Error(`bundle has no contract ${key}`);
  return c;
}

/** Find a bundle contract by repo and name (libraries are resolved this way when linking). */
export function findByName(bundle: Bundle, repo: string, name: string): BundleContract | undefined {
  return bundle.contracts[`${repo}:${name}`];
}
