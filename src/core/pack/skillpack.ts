import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { sha256Hex, sha256Bytes } from "../canonical.js";
import { Link, cidDigestHex, dagLink, encode, leafLink, type Encodable } from "./cbor.js";

/**
 * ERC-8338 skill packages, following the reference `tools/skill-pack/pack.py`:
 *   mdHash      = sha256(plaintext primary document)
 *   packageHash = sha256(DAG-CBOR(SkillRoot))
 *   SkillRoot   = { md: {path, cid}, manifest: <raw link>, entry: {path, cid, profile}, license?: {path, cid},
 *                   files: {path: <raw link>}, prev?: <dag-cbor link to the previous packageHash> }
 */

export interface SkillManifest {
  schemaVersion: string;
  name: string;
  skillVersion: string;
  summary: string;
  entrypoint: string;
  [k: string]: unknown;
}

export interface SkillPackage {
  mdHash: string;
  packageHash: string;
  rootCid: string;
  version: number;
  primaryPath: string;
  manifest: SkillManifest;
  root: Encodable;
  rootBytes: Uint8Array;
  /** path -> sha256 hex of the leaf object */
  leaves: Record<string, string>;
  /** sha256 hex -> bytes (content-addressed objects) */
  objects: Record<string, Uint8Array>;
}

const LICENSE_NAMES = new Set(["license", "LICENSE", "license.json"]);

function validatePath(p: string): void {
  if (!p || p.startsWith("/") || p.includes("\\")) throw new Error(`invalid package path: ${p}`);
  for (const seg of p.split("/")) if (seg === "" || seg === "." || seg === "..") throw new Error(`invalid package path: ${p}`);
}

/** Read a directory into a path -> bytes map (POSIX relative paths, sorted). */
export function readSkillDir(dir: string): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else files[posix.normalize(relative(dir, p).split("\\").join("/"))] = new Uint8Array(readFileSync(p));
    }
  };
  walk(dir);
  return files;
}

export function detectPrimary(files: Record<string, Uint8Array>): string {
  if (files["SKILL.md"]) return "SKILL.md";
  if (files["README.md"]) return "README.md";
  const mds = Object.keys(files).filter((p) => !p.includes("/") && /\.(md|markdown)$/i.test(p));
  if (mds.length === 1) return mds[0];
  throw new Error("cannot detect the primary document; pass primaryPath");
}

export interface BuildOptions {
  primaryPath?: string;
  version?: number;
  previousPackageHash?: string;
}

export function buildSkillPackage(files: Record<string, Uint8Array>, opts: BuildOptions = {}): SkillPackage {
  for (const p of Object.keys(files)) validatePath(p);
  const primaryPath = opts.primaryPath ?? detectPrimary(files);
  const md = files[primaryPath];
  if (!md) throw new Error(`primary document ${primaryPath} missing`);
  Buffer.from(md).toString("utf8"); // must be text

  let manifestBytes = files["manifest.json"];
  let manifest: SkillManifest;
  if (manifestBytes) {
    manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
  } else {
    const firstLine = Buffer.from(md).toString("utf8").split("\n")[0].replace(/^#+\s*/, "").trim();
    manifest = { schemaVersion: "1.0", name: "skill", skillVersion: "0.0.1", summary: firstLine, entrypoint: primaryPath };
    manifestBytes = new Uint8Array(Buffer.from(JSON.stringify(manifest, null, 2)));
  }
  for (const k of ["schemaVersion", "name", "skillVersion", "summary", "entrypoint"]) {
    if (!(k in manifest)) throw new Error(`manifest.json lacks required field ${k}`);
  }
  const entryPath = manifest.entrypoint;
  validatePath(entryPath);
  const profile = typeof manifest["x-entry-profile"] === "string" ? (manifest["x-entry-profile"] as string) : "llm-markdown-v1";

  const leaves: Record<string, string> = {};
  const objects: Record<string, Uint8Array> = {};
  const leafOf = (path: string, bytes: Uint8Array): Link => {
    const hex = sha256Hex(bytes);
    leaves[path] = hex;
    objects[hex.slice(2)] = bytes;
    return leafLink(bytes);
  };

  const mdLink = leafOf(primaryPath, md);
  const manifestLink = leafOf("manifest.json", manifestBytes);
  let license: { path: string; cid: Link } | undefined;
  const fileLinks: Record<string, Link> = {};
  for (const [path, bytes] of Object.entries(files)) {
    if (path === primaryPath || path === "manifest.json") continue;
    if (!path.includes("/") && LICENSE_NAMES.has(path)) {
      license = { path, cid: leafOf(path, bytes) };
      continue;
    }
    fileLinks[path] = leafOf(path, bytes);
  }
  let entryCid: Link;
  if (entryPath === primaryPath) entryCid = mdLink;
  else if (fileLinks[entryPath]) entryCid = fileLinks[entryPath];
  else throw new Error(`entrypoint ${entryPath} is not a file of the package`);

  const version = opts.version ?? 1;
  const root: Record<string, Encodable> = {
    md: { path: primaryPath, cid: mdLink },
    manifest: manifestLink,
    entry: { path: entryPath, cid: entryCid, profile },
    files: fileLinks,
  };
  if (license) root.license = { path: license.path, cid: license.cid };
  if (version > 1) {
    if (!opts.previousPackageHash) throw new Error("version > 1 needs previousPackageHash");
    root.prev = dagLink(Uint8Array.from(Buffer.from(opts.previousPackageHash.replace(/^0x/, ""), "hex")));
  } else if (opts.previousPackageHash) {
    throw new Error("version 1 must not carry prev");
  }
  const rootBytes = encode(root);
  const packageHash = sha256Hex(rootBytes);
  const rootCid = cidDigestHex(dagLink(sha256Bytes(rootBytes)).cid);
  return { mdHash: sha256Hex(md), packageHash, rootCid, version, primaryPath, manifest, root, rootBytes, leaves, objects };
}

/** Verify a set of files against on-chain commitments; returns the problems found (empty = verified). */
export function verifySkillPackage(files: Record<string, Uint8Array>, expected: { mdHash: string; packageHash: string; version?: number; previousPackageHash?: string }, primaryPath?: string): string[] {
  const problems: string[] = [];
  let pkg: SkillPackage;
  try {
    pkg = buildSkillPackage(files, { primaryPath, version: expected.version ?? 1, previousPackageHash: expected.previousPackageHash });
  } catch (e: any) {
    return [`package does not build: ${e.message}`];
  }
  if (pkg.mdHash.toLowerCase() !== expected.mdHash.toLowerCase()) problems.push(`mdHash ${pkg.mdHash} != ${expected.mdHash}`);
  if (pkg.packageHash.toLowerCase() !== expected.packageHash.toLowerCase()) problems.push(`packageHash ${pkg.packageHash} != ${expected.packageHash}`);
  return problems;
}

/** The vector.json shape the reference tooling writes next to skillroot.cbor. */
export function vectorOf(pkg: SkillPackage): Record<string, unknown> {
  return {
    standard: "KERNEL v4.3",
    mdHash: pkg.mdHash,
    packageHash: pkg.packageHash,
    rootCID_digest: pkg.rootCid,
    version: pkg.version,
    confidential: false,
    encryptedPaths: [],
    leaves: pkg.leaves,
  };
}
