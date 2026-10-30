import { sha256Bytes } from "../canonical.js";

/**
 * The deterministic DAG-CBOR encoder of ERC-8338 / ERC-8414 packages, ported from the reference
 * `tools/skill-pack/som.py` (and the identical `tools/task-pack/tom.py`):
 *   - definite lengths only, shortest-form integer heads;
 *   - map keys MUST be strings and are sorted by the bytes of their ENCODED form;
 *   - links are CBOR tag 42 over a byte string of 0x00 (identity multibase) + the binary CID;
 *   - CIDs are CIDv1 with sha2-256 multihash: 0x01 <codec varint> 0x12 0x20 <32-byte digest>;
 *   - no floats, booleans, null or other tags.
 */

export const RAW_CODEC = 0x55;
export const DAG_CBOR_CODEC = 0x71;

export class Link {
  constructor(public readonly cid: Uint8Array) {
    if (cid.length !== 36) throw new Error("Link: binary CID must be 36 bytes");
  }
}

export type Encodable = Link | Uint8Array | string | number | bigint | Encodable[] | { [key: string]: Encodable };

function head(major: number, arg: bigint): Uint8Array {
  if (arg < 24n) return Uint8Array.of((major << 5) | Number(arg));
  const sizes: [number, number][] = [
    [24, 1],
    [25, 2],
    [26, 4],
    [27, 8],
  ];
  for (const [ai, size] of sizes) {
    if (arg < 1n << BigInt(8 * size)) {
      const out = new Uint8Array(1 + size);
      out[0] = (major << 5) | ai;
      let v = arg;
      for (let i = size; i >= 1; i--) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
      }
      return out;
    }
  }
  throw new Error("integer too large");
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

export function encode(obj: Encodable): Uint8Array {
  if (obj instanceof Link) {
    const body = new Uint8Array(1 + obj.cid.length);
    body[0] = 0x00;
    body.set(obj.cid, 1);
    return concat([head(6, 42n), encode(body)]);
  }
  if (obj instanceof Uint8Array) return concat([head(2, BigInt(obj.length)), obj]);
  if (typeof obj === "string") {
    const raw = Buffer.from(obj, "utf8");
    return concat([head(3, BigInt(raw.length)), raw]);
  }
  if (typeof obj === "boolean") throw new TypeError("booleans are not supported in SkillRoot");
  if (typeof obj === "number" || typeof obj === "bigint") {
    const v = BigInt(obj);
    if (typeof obj === "number" && !Number.isInteger(obj)) throw new TypeError("floats are not supported in SkillRoot");
    return v >= 0n ? head(0, v) : head(1, -1n - v);
  }
  if (Array.isArray(obj)) return concat([head(4, BigInt(obj.length)), ...obj.map(encode)]);
  if (obj && typeof obj === "object") {
    const items = Object.entries(obj).map(([k, v]) => [encode(k), encode(v)] as [Uint8Array, Uint8Array]);
    items.sort((x, y) => compareBytes(x[0], y[0]));
    return concat([head(5, BigInt(items.length)), ...items.flatMap(([k, v]) => [k, v])]);
  }
  throw new TypeError(`unsupported type in SkillRoot: ${typeof obj}`);
}

export function makeCid(digest: Uint8Array, codec: number): Uint8Array {
  if (digest.length !== 32) throw new Error("makeCid: sha2-256 digest expected");
  if (codec >= 128) throw new Error("makeCid: codec varint > 1 byte not needed here");
  const out = new Uint8Array(36);
  out[0] = 0x01;
  out[1] = codec;
  out[2] = 0x12;
  out[3] = 0x20;
  out.set(digest, 4);
  return out;
}

export function leafLink(content: Uint8Array): Link {
  return new Link(makeCid(sha256Bytes(content), RAW_CODEC));
}

export function dagLink(digest: Uint8Array): Link {
  return new Link(makeCid(digest, DAG_CBOR_CODEC));
}

/** "b" + lowercase base32 (RFC 4648, no padding) of the binary CID. */
export function cidString(cid: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let out = "b";
  for (const byte of cid) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

export function cidDigestHex(cid: Uint8Array): string {
  return "0x" + Buffer.from(cid.subarray(4)).toString("hex");
}
