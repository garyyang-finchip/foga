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
 * keccak256 of runtime code with the metadata trailer stripped and every deployment-dependent slot
 * (linked library addresses, immutables, a library's own address) masked: the "code identity" the doctor
 * compares between a build and a chain.
 */
export function runtimeIdentity(deployedBytecode: string, links?: LinkReferences, immutables?: ImmutableReferences): string {
  return keccak256(stripMetadata(maskImmutables(maskLinks(deployedBytecode, links), immutables)));
}

export function codeSize(hex: string): number {
  return hexBody(hex).length / 2;
}
