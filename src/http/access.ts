import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getAddress } from "ethers";
import { accountSubject } from "../core/kya.js";
import type { CellConfig } from "../node/config.js";
import type { Node } from "../node/node.js";
import { ACTION_RANK, PUBLIC_CALLER, type Caller } from "../tools/index.js";
import { NonceCache, SIGNED_SCHEME, verifyAuthorization, type SignedEnvelope } from "./signed.js";

const KEY_PREFIX = "foga";

/** Make an API key for a grant: shown once, stored only as its hash. */
export function newApiKey(id: string): { key: string; sha256: string } {
  const key = `${KEY_PREFIX}.${id}.${randomBytes(24).toString("base64url")}`;
  return { key, sha256: "0x" + createHash("sha256").update(key).digest("hex") };
}

/** The caller an Authorization header establishes: the public without one, the grant of a valid key, or null for an invalid key. */
export function callerFromAuthorization(cfg: CellConfig, header: string | undefined): Caller | null {
  if (!header) return { ...PUBLIC_CALLER, entrance: "http" };
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!m) return null;
  const key = m[1];
  const parts = key.split(".");
  if (parts.length !== 3 || parts[0] !== KEY_PREFIX) return null;
  const grant = cfg.access.keys.find((k) => k.id === parts[1]);
  if (!grant) return null;
  const given = Buffer.from(createHash("sha256").update(key).digest("hex"), "hex");
  const stored = Buffer.from(grant.sha256.slice(2), "hex");
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) return null;
  return { id: grant.id, entrance: "http", level: grant.level, visibility: grant.visibility };
}

/**
 * Who an HTTP request is from (design memo, Phase 3, section 3): nobody (the public: reads and builds), the holder of
 * an API key the operator issued (the grant the key names), or an address proving itself with its wallet's
 * signature — the cell's own roles, a signer the configuration names by address or by the ERC-8004 agent it acts
 * for, one whose KYA standing under the cell's scheme reaches the configured level, or any valid signer at the
 * default level. The signature's shape matters for acts: a session envelope, which a client with static headers
 * can present, reaches build unless the configuration says otherwise; an act wants an envelope bound to its request.
 */
export type Resolved = { caller: Caller; via: "anonymous" | "key" | "signature"; signer?: SignedEnvelope } | { caller: null; status: 401 | 403; reason: string };

export interface ResolveInput {
  node: Node;
  authorization: string | undefined;
  method: string;
  path: string;
  body: Uint8Array | null;
  nonces: NonceCache;
  now?: number;
}

export async function resolveCaller(i: ResolveInput): Promise<Resolved> {
  const { node } = i;
  const cfg = node.config;
  const header = i.authorization?.trim();
  if (!header) return { caller: { ...PUBLIC_CALLER, entrance: "http" }, via: "anonymous" };
  if (/^bearer\s/i.test(header)) {
    const caller = callerFromAuthorization(cfg, header);
    if (!caller) return { caller: null, status: 401, reason: "the Authorization header carries no key this node knows" };
    return { caller, via: "key" };
  }
  if (new RegExp(`^${SIGNED_SCHEME}\\s`, "i").test(header)) {
    if (!node.cell) return { caller: null, status: 403, reason: "this node has no cell to sign for yet" };
    const v = verifyAuthorization(header, { chainId: node.chainId, cell: node.cell.address, method: i.method, path: i.path, body: i.body, now: i.now, nonces: i.nonces });
    if (!v.ok) return { caller: null, status: 401, reason: `signature refused: ${v.reason}` };
    const grant = await grantFor(node, v.envelope);
    if (!grant) return { caller: null, status: 403, reason: "this node does not accept signatures (access.signers.default is none)" };
    let level = grant.level;
    if (!v.bound && cfg.access.signers.actsNeedRequestBinding && ACTION_RANK[level] >= ACTION_RANK.act) level = "build";
    return { caller: { id: v.envelope.signer, entrance: "http", level, visibility: grant.visibility }, via: "signature", signer: v.envelope };
  }
  return { caller: null, status: 401, reason: `the Authorization scheme is not one this node accepts (Bearer <key> or ${SIGNED_SCHEME} <envelope>)` };
}

type Grant = { level: Caller["level"]; visibility: Caller["visibility"]; why: string };

/** The grant a verified signer gets, from the cell's roles, the configuration's grants, its standing, or the default. */
export async function grantFor(node: Node, e: SignedEnvelope): Promise<Grant | null> {
  const cfg = node.config;
  const signer = getAddress(e.signer);
  const roles: [string, string][] = [
    ["operator", cfg.identity.operator],
    ["owner", cfg.identity.owner],
  ];
  for (const [name, address] of roles) if (getAddress(address) === signer) return { level: "act", visibility: "operator", why: `the cell's ${name}` };
  const s = cfg.access.signers;
  const byAddress = s.allow.find((g) => g.address && getAddress(g.address) === signer);
  if (byAddress) return { level: byAddress.level, visibility: byAddress.visibility, why: `granted by address${byAddress.note ? ` (${byAddress.note})` : ""}` };
  if (e.agentId) {
    const byAgent = s.allow.find((g) => g.agentId && g.agentId === e.agentId);
    if (byAgent && (await actsForAgent(node, signer, e.agentId))) return { level: byAgent.level, visibility: byAgent.visibility, why: `granted as ERC-8004 agent ${e.agentId}` };
  }
  if (s.standing && cfg.identity.standing) {
    try {
      const subject = accountSubject(node.chainId, signer);
      const meets = await node.kernel.kya.check(subject, cfg.identity.standing.schemeId, s.standing.minLevel, cfg.identity.standing.issuers);
      if (meets) return { level: s.standing.level, visibility: s.standing.visibility, why: `KYA standing at level ${s.standing.minLevel} or above` };
    } catch {
      /* no standing readable: the default applies */
    }
  }
  if (s.default === "none") return null;
  return { level: s.default, visibility: "caller", why: "any valid signer" };
}

/** Whether `signer` is the owner or the agent wallet of ERC-8004 agent `agentId` on this world's registry. */
export async function actsForAgent(node: Node, signer: string, agentId: string): Promise<boolean> {
  try {
    const id = BigInt(agentId);
    const [owner, wallet] = await Promise.all([node.kernel.identity.ownerOf(id).catch(() => null), node.kernel.identity.agentWallet(id).catch(() => null)]);
    return [owner, wallet].some((a) => a && getAddress(a) === getAddress(signer));
  } catch {
    return false;
  }
}
