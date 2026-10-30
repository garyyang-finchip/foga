import { keccak256 } from "ethers";

/** Solidity link references as emitted by solc / forge: { "<source path>": { "<LibName>": [{ start, length }] } }. */
export type LinkReferences = Record<string, Record<string, { start: number; length: number }[]>>;

function hexBody(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

/**
 * Remove the CBOR metadata trailer solc appends to runtime and creation code.
 * The last two bytes encode the trailer length (big-endian). We only strip when the
 * trailer parses as a CBOR map (0xa1..0xa5), which is what solc emits.
 */
export function stripMetadata(hex: string): string {
  const body = hexBody(hex);
  if (body.length < 4) return "0x" + body;
  const len = parseInt(body.slice(-4), 16);
  const total = (len + 2) * 2;
  if (!Number.isFinite(len) || total > body.length) return "0x" + body;
  const trailer = body.slice(body.length - total, body.length - 4);
  const first = trailer.slice(0, 2).toLowerCase();
  if (!["a1", "a2", "a3", "a4", "a5"].includes(first)) return "0x" + body;
  return "0x" + body.slice(0, body.length - total);
}

/**
 * Zero the content hash inside every CBOR metadata block found anywhere in the code, not only the
 * trailer. A contract that creates other contracts (TaskToken deploys a TaskVault per token) embeds
 * their creation code, including their metadata trailer; that nested hash depends on source names and
 * build paths, so two builds of identical code can differ there. Handles the `ipfs` form
 * (a2 64 "ipfs" 58 22 <34-byte multihash> ... ) and the legacy `bzzr0`/`bzzr1` form (a1/a2 65 "bzzr?" 58 20 <32 bytes>).
 * Metadata written with `bytecode_hash = none` carries no hash and is left untouched.
 */
export function maskEmbeddedMetadataHashes(hex: string): string {
  let body = hexBody(hex).toLowerCase();
  const patterns: { marker: string; hashHex: number }[] = [
    { marker: "a2646970667358" + "22", hashHex: 68 }, // a2 64 'ipfs' 58 22 + 34 bytes
    { marker: "a165627a7a72305820", hashHex: 64 }, // a1 65 'bzzr0' 58 20 + 32 bytes
    { marker: "a265627a7a72305820", hashHex: 64 },
    { marker: "a265627a7a72315820", hashHex: 64 }, // bzzr1
  ];
  for (const { marker, hashHex } of patterns) {
    let from = 0;
    for (;;) {
      const at = body.indexOf(marker, from);
      if (at < 0) break;
      if (at % 2 === 0 && at + marker.length + hashHex <= body.length) {
        const start = at + marker.length;
        body = body.slice(0, start) + "0".repeat(hashHex) + body.slice(start + hashHex);
      }
      from = at + 2;
    }
  }
  return "0x" + body;
}

/** Immutable value slots as emitted by solc / forge: { "<astId|library_deploy_address>": [{ start, length }] }. */
export type ImmutableReferences = Record<string, { start: number; length: number }[]>;

/** Zero out every immutable value slot (constructor-set immutables and a library's own deploy address). */
export function maskImmutables(hex: string, refs: ImmutableReferences | undefined): string {
  let body = hexBody(hex);
  if (!refs) return "0x" + body;
  for (const slots of Object.values(refs)) {
    for (const { start, length } of slots) {
      const a = start * 2;
      const b = a + length * 2;
      if (b <= body.length) body = body.slice(0, a) + "0".repeat(length * 2) + body.slice(b);
    }
  }
  return "0x" + body;
}

/** Zero out every linked-library address slot so linked and unlinked code compare equal. */
export function maskLinks(hex: string, refs: LinkReferences | undefined): string {
  if (!refs) return hex.startsWith("0x") ? hex : "0x" + hex;
  let body = hexBody(hex);
  for (const libs of Object.values(refs)) {
    for (const slots of Object.values(libs)) {
      for (const { start, length } of slots) {
        const a = start * 2;
        const b = a + length * 2;
        if (b <= body.length) body = body.slice(0, a) + "0".repeat(length * 2) + body.slice(b);
      }
    }
  }
  return "0x" + body;
}

/** Replace library placeholders with the deployed addresses. `resolve` returns a 0x address or undefined. */
export function linkBytecode(
  hex: string,
  refs: LinkReferences | undefined,
  resolve: (sourcePath: string, libName: string) => string | undefined,
): string {
  let body = hexBody(hex);
  if (!refs) return "0x" + body;
  for (const [sourcePath, libs] of Object.entries(refs)) {
    for (const [libName, slots] of Object.entries(libs)) {
      const address = resolve(sourcePath, libName);
      if (!address) throw new Error(`unlinked library ${sourcePath}:${libName}`);
      const addr = hexBody(address).toLowerCase().padStart(40, "0");
      if (addr.length !== 40) throw new Error(`bad library address for ${libName}: ${address}`);
      for (const { start, length } of slots) {
        if (length !== 20) throw new Error(`unexpected link slot length ${length} for ${libName}`);
        const a = start * 2;
        body = body.slice(0, a) + addr + body.slice(a + 40);
      }
    }
  }
  if (body.includes("__$")) throw new Error("bytecode still contains unresolved link placeholders");
  return "0x" + body;
}

/**
 * keccak256 of runtime code with the metadata trailer stripped, every embedded metadata hash zeroed and
 * every deployment-dependent slot (linked library addresses, immutables, a library's own address) masked:
 * the "code identity" the doctor compares between a build and a chain. Two builds of the same source with
 * the same compiler and settings share it whatever their source names or build paths were.
 */
export function runtimeIdentity(deployedBytecode: string, links?: LinkReferences, immutables?: ImmutableReferences): string {
  return keccak256(stripMetadata(maskEmbeddedMetadataHashes(maskImmutables(maskLinks(deployedBytecode, links), immutables))));
}

export function codeSize(hex: string): number {
  return hexBody(hex).length / 2;
}
