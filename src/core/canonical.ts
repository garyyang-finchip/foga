import { createHash } from "node:crypto";
import { AbiCoder, getAddress, keccak256, toUtf8Bytes } from "ethers";

/**
 * RFC 8785 JSON Canonicalization Scheme (the subset the ten ERCs use): object keys sorted by UTF-16 code
 * units, no whitespace, strings and finite numbers serialized as JSON.stringify does, `undefined`
 * properties skipped. Throws on non-finite numbers, bigints and functions.
 */
export function jcs(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("JCS: non-finite number");
      return JSON.stringify(value);
    case "bigint":
      throw new Error("JCS: bigint is not JSON; stringify it first");
    case "undefined":
      throw new Error("JCS: undefined is not JSON");
    case "object": {
      if (Array.isArray(value)) return "[" + value.map((v) => (v === undefined ? "null" : jcs(v))).join(",") + "]";
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + jcs(obj[k])).join(",") + "}";
    }
    default:
      throw new Error(`JCS: unsupported type ${typeof value}`);
  }
}

export function sha256Hex(data: Uint8Array | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  return "0x" + createHash("sha256").update(buf).digest("hex");
}

export function sha256Bytes(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(Buffer.from(data)).digest());
}

/** keccak256 over the UTF-8 bytes of a string (identifier ids, AID / AUF / ASF content hashes). */
export function keccakUtf8(s: string): string {
  return keccak256(toUtf8Bytes(s));
}

/** keccak256(UTF-8(JCS(doc))) — AID documents, ASF documents, AUF definitions and companions. */
export function keccakJcs(doc: unknown): string {
  return keccakUtf8(jcs(doc));
}

/** SHA-256(UTF-8(JCS(doc))) — ARD descriptors (content members) and SAI pack hashes. */
export function sha256Jcs(doc: unknown): string {
  return sha256Hex(jcs(doc));
}

export function dataUri(doc: unknown): string {
  return "data:application/json;base64," + Buffer.from(JSON.stringify(doc)).toString("base64");
}

export function dataUriJcs(doc: unknown): string {
  return "data:application/json;base64," + Buffer.from(jcs(doc)).toString("base64");
}

export function parseDataUri(uri: string): unknown {
  const m = /^data:application\/json(;base64)?,(.*)$/s.exec(uri);
  if (!m) throw new Error("not a JSON data: URI");
  const body = m[1] ? Buffer.from(m[2], "base64").toString("utf8") : decodeURIComponent(m[2]);
  return JSON.parse(body);
}

/** "eip155:<chainId>:<0x + lowercase hex>" — CAIP-10 account reference used by AID, ASF and AUF. */
export function accountRef(chainId: number | bigint, address: string): string {
  return `eip155:${chainId}:${getAddress(address).toLowerCase()}`;
}

/** "eip155:<chainId>/erc721:<0x lowercase>/<id>" — CAIP-19 token reference used by ARD and AUF. */
export function erc721Ref(chainId: number | bigint, collection: string, id: bigint | number): string {
  return `eip155:${chainId}/erc721:${getAddress(collection).toLowerCase()}/${id}`;
}

export const abi = AbiCoder.defaultAbiCoder();

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
