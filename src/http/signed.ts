import { getAddress, isHexString, keccak256, randomBytes, toUtf8Bytes, verifyTypedData, type Signer, type TypedDataDomain, type TypedDataField } from "ethers";

/**
 * Signed calls (design memo, Phase 3, sections 3 and 6, v0.2): a caller's credential is its own wallet's signature,
 * not a secret the node issued. The envelope is EIP-712 typed data over this cell — the domain's verifyingContract
 * is the cell's account, so a signature made for one cell means nothing to another — in one of two shapes:
 *
 *   Request  bound to one HTTP request (method, path, the hash of the body), valid for at most two minutes:
 *            the shape for an act, since whoever holds the header can replay nothing else with it;
 *   Session  not bound to a request, valid for at most ten minutes: the shape a client with static headers
 *            (an MCP client given `Authorization` once) can use; the policy decides how far it reaches.
 *
 * A request-bound envelope carries a nonce the node remembers until it expires, so a captured header is good once;
 * a session envelope is presented as many times as the session lasts (a captured one is a Bearer token's risk for
 * ten minutes at most, which is why it reaches build unless the configuration says otherwise). The node recovers
 * the address, and the address — with what the chain says about it (an ERC-8004 agent, a KYA standing) — is what
 * the access policy grants a level to. Bearer keys and anonymous reads are untouched: a signature is one more way
 * in, never a requirement.
 */
export const SIGNED_SCHEME = "FOGA-EIP712";
export const REQUEST_MAX_SECONDS = 120;
export const SESSION_MAX_SECONDS = 600;

export const SIGNED_TYPES: Record<string, TypedDataField[]> = {
  Request: [
    { name: "method", type: "string" },
    { name: "path", type: "string" },
    { name: "bodyHash", type: "bytes32" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
  Session: [
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

export interface SignedEnvelope {
  v: 1;
  signer: string;
  /** The ERC-8004 agent id the signer claims to act for (the node checks the registry); optional. */
  agentId?: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  /** Present for a request-bound envelope; absent for a session. */
  request?: { method: string; path: string; bodyHash: string };
  signature: string;
}

export function signedDomain(chainId: number, cell: string): TypedDataDomain {
  return { name: "FOGA", version: "1", chainId, verifyingContract: getAddress(cell) };
}

/** keccak256 of the request body (the empty body for a GET). */
export function bodyHashOf(body: Uint8Array | string | null | undefined): string {
  if (body === null || body === undefined) return keccak256(new Uint8Array());
  return keccak256(typeof body === "string" ? toUtf8Bytes(body) : body);
}

function message(e: Omit<SignedEnvelope, "signature" | "v" | "signer" | "agentId">): { primaryType: "Request" | "Session"; types: Record<string, TypedDataField[]>; value: Record<string, unknown> } {
  if (e.request) return { primaryType: "Request", types: { Request: SIGNED_TYPES.Request }, value: { method: e.request.method, path: e.request.path, bodyHash: e.request.bodyHash, issuedAt: e.issuedAt, expiresAt: e.expiresAt, nonce: e.nonce } };
  return { primaryType: "Session", types: { Session: SIGNED_TYPES.Session }, value: { issuedAt: e.issuedAt, expiresAt: e.expiresAt, nonce: e.nonce } };
}

export interface SignOptions {
  chainId: number;
  cell: string;
  /** Bind the signature to one request; omit for a session. */
  request?: { method: string; path: string; body?: Uint8Array | string | null };
  /** Seconds of validity (default: the maximum of the shape). */
  ttlSeconds?: number;
  agentId?: string;
  now?: number;
}

/** Sign an envelope with a wallet (ethers Signer with signTypedData) and return the Authorization header value. */
export async function signAuthorization(signer: Signer & { signTypedData(domain: TypedDataDomain, types: Record<string, TypedDataField[]>, value: Record<string, unknown>): Promise<string> }, o: SignOptions): Promise<string> {
  const now = o.now ?? Math.floor(Date.now() / 1000);
  const max = o.request ? REQUEST_MAX_SECONDS : SESSION_MAX_SECONDS;
  const ttl = Math.min(o.ttlSeconds ?? max, max);
  const base = { issuedAt: now, expiresAt: now + ttl, nonce: keccak256(randomBytes(32)), request: o.request ? { method: o.request.method.toUpperCase(), path: o.request.path, bodyHash: bodyHashOf(o.request.body) } : undefined };
  const m = message(base);
  const signature = await signer.signTypedData(signedDomain(o.chainId, o.cell), m.types, m.value);
  const envelope: SignedEnvelope = { v: 1, signer: getAddress(await signer.getAddress()), ...(o.agentId ? { agentId: o.agentId } : {}), issuedAt: base.issuedAt, expiresAt: base.expiresAt, nonce: base.nonce, ...(base.request ? { request: base.request } : {}), signature };
  return `${SIGNED_SCHEME} ${Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url")}`;
}

export type SignedVerdict = { ok: true; envelope: SignedEnvelope; bound: boolean } | { ok: false; reason: string };

/** Remembers the nonces of request-bound envelopes until they expire: a captured one is good once. */
export class NonceCache {
  private readonly seen = new Map<string, number>();
  private lastSweep = 0;
  take(signer: string, nonce: string, expiresAt: number, now: number): boolean {
    if (now - this.lastSweep > 30) {
      for (const [k, exp] of this.seen) if (exp < now) this.seen.delete(k);
      this.lastSweep = now;
    }
    const key = `${signer.toLowerCase()}:${nonce.toLowerCase()}`;
    if (this.seen.has(key)) return false;
    this.seen.set(key, expiresAt);
    if (this.seen.size > 100_000) this.seen.delete(this.seen.keys().next().value as string);
    return true;
  }
}

/** Parse and verify an Authorization header of the FOGA-EIP712 scheme against this cell and this request. */
export function verifyAuthorization(header: string, o: { chainId: number; cell: string; method: string; path: string; body?: Uint8Array | null; now?: number; nonces?: NonceCache }): SignedVerdict {
  const m = new RegExp(`^${SIGNED_SCHEME}\\s+(\\S+)$`, "i").exec(header.trim());
  if (!m) return { ok: false, reason: "not a FOGA-EIP712 envelope" };
  let e: SignedEnvelope;
  try {
    e = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8")) as SignedEnvelope;
  } catch {
    return { ok: false, reason: "the envelope is not base64url JSON" };
  }
  if (e?.v !== 1 || typeof e.signer !== "string" || typeof e.issuedAt !== "number" || typeof e.expiresAt !== "number" || !isHexString(e.nonce, 32) || typeof e.signature !== "string") return { ok: false, reason: "the envelope lacks a field (v, signer, issuedAt, expiresAt, nonce, signature)" };
  const now = o.now ?? Math.floor(Date.now() / 1000);
  const bound = Boolean(e.request);
  const max = bound ? REQUEST_MAX_SECONDS : SESSION_MAX_SECONDS;
  if (e.expiresAt <= e.issuedAt || e.expiresAt - e.issuedAt > max) return { ok: false, reason: `the envelope's validity must be 1 to ${max} seconds (${bound ? "request" : "session"})` };
  if (e.issuedAt > now + 60) return { ok: false, reason: "the envelope is issued in the future" };
  if (e.expiresAt < now) return { ok: false, reason: "the envelope has expired" };
  if (bound) {
    const r = e.request!;
    if (typeof r.method !== "string" || typeof r.path !== "string" || !isHexString(r.bodyHash, 32)) return { ok: false, reason: "the request binding lacks method, path or bodyHash" };
    if (r.method.toUpperCase() !== o.method.toUpperCase()) return { ok: false, reason: `the envelope is bound to ${r.method}, this request is ${o.method}` };
    if (r.path !== o.path) return { ok: false, reason: `the envelope is bound to ${r.path}, this request is ${o.path}` };
    if (r.bodyHash.toLowerCase() !== bodyHashOf(o.body).toLowerCase()) return { ok: false, reason: "the envelope is bound to another body" };
  }
  let recovered: string;
  try {
    const msg = message({ issuedAt: e.issuedAt, expiresAt: e.expiresAt, nonce: e.nonce, request: e.request });
    recovered = verifyTypedData(signedDomain(o.chainId, o.cell), msg.types, msg.value, e.signature);
  } catch {
    return { ok: false, reason: "the signature does not verify" };
  }
  let claimed: string;
  try {
    claimed = getAddress(e.signer);
  } catch {
    return { ok: false, reason: "signer is not an address" };
  }
  if (recovered !== claimed) return { ok: false, reason: "the signature was not made by the signer it names" };
  if (bound && o.nonces && !o.nonces.take(claimed, e.nonce, e.expiresAt, now)) return { ok: false, reason: "the envelope was presented before (nonce reused)" };
  return { ok: true, envelope: { ...e, signer: claimed }, bound };
}
