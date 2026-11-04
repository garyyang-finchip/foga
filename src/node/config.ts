import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { ensureDir } from "../util/fs.js";

/**
 * `cell.config.json` (schema `foga.cell-config/1`): the one file a node maintains (design memo, Phase 3, section 7).
 * Six blocks: identity (the world, the account and its roles, what `foga cell init` writes back), presence (how the
 * cell describes itself to the world), skills (what it holds and offers), policy (the business authorization the
 * policy engine applies to every act), runtime (how the node runs, the HTTP server among it) and access (the API
 * keys the HTTP entrance accepts, as their hashes, and what a signer proving itself with its wallet is granted).
 * Amounts in wei are decimal strings so the file stays plain JSON.
 */
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "an address (0x + 40 hex digits)");
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "a 32-byte hex value");
const wei = z.string().regex(/^\d+$/, "a decimal amount in wei");
const uint = z.string().regex(/^\d+$/, "a decimal integer");

export const SafetySchema = z.object({
  /** The ASF specification the cell adopts; `foga cell init` publishes FOGA-Cell-v1 and fills this in when absent. */
  specId: bytes32.optional(),
  version: z.number().int().positive().default(1),
  contentHash: bytes32.optional(),
});

export const StandingSchema = z.object({
  /** The attested KYA scheme and issuers the cell cites for its own standing and requires of counterparties. */
  schemeId: bytes32,
  issuers: z.array(address).min(1),
});

export const IdentitySchema = z.object({
  account: address.optional(),
  agentId: uint.optional(),
  owner: address,
  operator: address,
  guardian: address,
  recovery: address.optional(),
  bindingId: bytes32.optional(),
  recordId: bytes32.optional(),
  unitId: uint.optional(),
  documentDigest: bytes32.optional(),
  safety: SafetySchema.prefault({}),
  standing: StandingSchema.optional(),
  /** The ERC-8434 liveness window the account keeps (seconds); the registry's default when absent. */
  livenessWindow: z.number().int().positive().optional(),
});

export const PresenceSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(""),
  image: z.string().url().optional(),
  homepage: z.string().url().optional(),
  /** The organization behind the cell, for the A2A agent card. */
  provider: z.object({ organization: z.string().min(1).max(120), url: z.string().url() }).optional(),
  /** The public endpoints; when absent they are derived from runtime.http.publicUrl (/mcp, /a2a, the URL itself). */
  endpoints: z
    .object({
      mcp: z.string().url().optional(),
      a2a: z.string().url().optional(),
      web: z.string().url().optional(),
    })
    .prefault({}),
  /**
   * The `services` block of the propagation manifest (docs/propagation.md): absent, the program maintainer's catalog
   * and offers; `catalog: null` drops the block from this cell's manifest; a catalog and offers of one's own replace it.
   */
  services: z
    .object({
      catalog: z.string().url().nullable().optional(),
      offers: z
        .array(
          z.object({
            id: z.string().min(1).max(64),
            name: z.string().min(1).max(120),
            kind: z.enum(["free", "paid"]),
            status: z.enum(["available", "planned"]).default("available"),
            url: z.string().url(),
            description: z.string().max(400).default(""),
          }),
        )
        .optional(),
    })
    .optional(),
});

export const HeldSkillSchema = z.object({
  tokenId: uint,
  recordId: bytes32.optional(),
  unitId: uint.optional(),
  packageHash: bytes32.optional(),
});

export const SkillsSchema = z.object({
  /** Directory holding the skill packages (one subdirectory per skill name). */
  dir: z.string().default("scenarios/skills"),
  /** The only directory a skill run may read documents from (a task's document is written here when it arrives inline). */
  inputDir: z.string().default("scenarios/fixtures"),
  /** Skills the cell holds on chain, by name (written by `skill_mint`). */
  held: z.record(z.string(), HeldSkillSchema).default({}),
  /** Skills the cell offers to run for others; a tender for a skill not listed here is refused (gate: skill). */
  offered: z.array(z.string()).default([]),
  /** The skill worker's time budget per run (ms). Absent: a minute on a local chain, three on a public one. */
  timeoutMs: z.number().int().positive().optional(),
});

export const BudgetSchema = z.object({
  /** Native value the cell may move out per day (settlements paid in count as income, not spend). */
  dailyValueWei: wei.default("2000000000000000"),
  /** The most one operation may move. */
  perOperationValueWei: wei.default("1000000000000000"),
  /** Fees the operator key may pay per day (gas), replacements included. */
  dailyGasWei: wei.default("5000000000000000"),
  /** Tenders taken and not yet settled at the same time. */
  maxConcurrentCommitments: z.number().int().min(1).default(2),
});

export const TenderPolicySchema = z.object({
  minRewardWei: wei.default("100000000000000"),
  /** A tender whose submitBy is closer than this is refused (gate: policy). */
  minSubmitWindowSeconds: z.number().int().min(0).default(600),
  minSettleWindowSeconds: z.number().int().min(0).default(600),
  /** Acceptance authorities the cell works under: "hashlock" (the world's HashlockVerifier) or an address. */
  acceptance: z.array(z.string()).default(["hashlock"]),
  /** What the cell requires of a demander: a KYA level under the standing scheme, 0 = nothing. */
  counterpartyMinLevel: z.number().int().min(0).default(0),
  /** How far back tender discovery scans (blocks). */
  lookbackBlocks: z.number().int().min(1).default(9000),
});

export const PolicySchema = z.object({
  budget: BudgetSchema.prefault({}),
  tenders: TenderPolicySchema.prefault({}),
});

export const HttpSchema = z.object({
  /** host:port the HTTP server binds (loopback by default; a reverse proxy terminates TLS in front of it). */
  listen: z.string().default("127.0.0.1:8787"),
  /** Origins (hostnames) a browser-sent request may carry; a request with another Origin is refused. Requests without an Origin pass. */
  allowedOrigins: z.array(z.string()).default([]),
  /** Host names this server answers for (the reverse proxy's and the loopback ones). Empty: any Host. */
  allowedHosts: z.array(z.string()).default([]),
  /** The URL the public reaches the node at (for its documents and card). */
  publicUrl: z.string().url().optional(),
  /** Where `foga cell docs build` writes and the node serves the documents from (relative to the config's directory). */
  documentsDir: z.string().default("documents"),
  rateLimitPerMinute: z.number().int().min(1).default(60),
  maxBodyBytes: z.number().int().min(1024).default(256 * 1024),
});

export const RuntimeSchema = z.object({
  heartbeatEverySeconds: z.number().int().positive().default(3600),
  pollSeconds: z.number().int().positive().default(12),
  http: HttpSchema.prefault({}),
  /** The runner's model (3c): the provider, the model name (required for anthropic), and the limits the runner holds it to. */
  model: z
    .object({
      provider: z.enum(["stub", "anthropic"]).default("stub"),
      model: z.string().optional(),
      /** Model calls per UTC day; a tick that would exceed it is skipped and journaled. */
      dailyCalls: z.number().int().min(0).default(20),
      /** Tool calls the runner carries out in one tick. */
      maxToolCallsPerTick: z.number().int().min(1).max(100).default(12),
      /** Acts (pre-checks not counted) the runner carries out in one tick. */
      maxActsPerTick: z.number().int().min(0).max(20).default(2),
    })
    .prefault({}),
});

/** An API key the HTTP entrance accepts: only its hash is kept; the key itself is shown once by `foga node key new`. */
export const AccessKeySchema = z.object({
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/, "a key id: letters, digits, _ . -"),
  sha256: bytes32,
  level: z.enum(["read", "build", "act"]).default("act"),
  visibility: z.enum(["public", "caller", "operator"]).default("caller"),
  note: z.string().max(200).optional(),
});

/** What a signer (an address proving itself with an EIP-712 envelope) is granted: by address, or by the ERC-8004 agent id it acts for. */
export const SignerGrantSchema = z
  .object({
    address: address.optional(),
    agentId: uint.optional(),
    level: z.enum(["read", "build", "act"]).default("act"),
    visibility: z.enum(["public", "caller", "operator"]).default("caller"),
    note: z.string().max(200).optional(),
  })
  .refine((g) => g.address || g.agentId, { message: "a signer grant names an address or an agentId" });

export const SignersSchema = z.object({
  /** What any valid signature is granted without a grant of its own: the public's level (build) by default; none refuses signatures outright. */
  default: z.enum(["none", "read", "build"]).default("build"),
  allow: z.array(SignerGrantSchema).default([]),
  /** A signer whose KYA standing under the cell's scheme reaches minLevel is granted this level. */
  standing: z
    .object({
      minLevel: z.number().int().min(1),
      level: z.enum(["read", "build", "act"]).default("act"),
      visibility: z.enum(["public", "caller", "operator"]).default("caller"),
    })
    .optional(),
  /** An act by signature needs an envelope bound to its request (a session envelope reaches build at most). */
  actsNeedRequestBinding: z.boolean().default(true),
});

export const AccessSchema = z.object({
  keys: z.array(AccessKeySchema).default([]),
  /** Signed calls (FOGA-EIP712): what an address proving itself with its wallet is granted. */
  signers: SignersSchema.prefault({}),
});

export const CellConfigSchema = z.object({
  schema: z.literal("foga.cell-config/1"),
  name: z.string().min(1).max(64),
  world: z.string().min(1),
  rpc: z.string().url().optional(),
  bundle: z.string().optional(),
  /** The operation store of this cell (operations, jobs, decisions, facts). */
  store: z.string().min(1),
  identity: IdentitySchema,
  presence: PresenceSchema,
  skills: SkillsSchema.prefault({}),
  policy: PolicySchema.prefault({}),
  runtime: RuntimeSchema.prefault({}),
  access: AccessSchema.prefault({}),
});

export type CellConfig = z.infer<typeof CellConfigSchema>;
export type CellConfigInput = z.input<typeof CellConfigSchema>;

export interface LoadedConfig {
  path: string;
  /** Directory the config's relative paths resolve against. */
  dir: string;
  config: CellConfig;
}

export function loadCellConfig(path: string): LoadedConfig {
  const abs = resolve(path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    throw new Error(`cannot read cell config ${abs}: ${(e as Error).message}`);
  }
  const parsed = CellConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`cell config ${abs} is not a valid foga.cell-config/1 document:\n${issues}`);
  }
  return { path: abs, dir: dirname(abs), config: parsed.data };
}

/** Write the config back (after `init`, `migrate` or `skill_mint` filled in what the chain decided). */
export function saveCellConfig(path: string, config: CellConfig): void {
  const abs = resolve(path);
  ensureDir(dirname(abs));
  writeFileSync(abs, JSON.stringify(config, null, 2) + "\n");
}

/** Resolve a path in the config against the config's directory, unless absolute. */
export function configPath(loaded: LoadedConfig, p: string): string {
  return resolve(loaded.dir, p);
}

/** A starting config for a new cell: the roles and the world, nothing the chain has decided yet. */
export function newCellConfig(p: { name: string; world: string; store: string; owner: string; operator: string; guardian: string; rpc?: string; skillsDir?: string; inputDir?: string; description?: string }): CellConfig {
  return CellConfigSchema.parse({
    schema: "foga.cell-config/1",
    name: p.name,
    world: p.world,
    rpc: p.rpc,
    store: p.store,
    identity: { owner: p.owner, operator: p.operator, guardian: p.guardian, safety: { version: 1 } },
    presence: { name: `FOGA cell ${p.name}`, description: p.description ?? `Cell ${p.name}: an address acting under the ten-ERC stack`, endpoints: {} },
    skills: { dir: p.skillsDir ?? "scenarios/skills", inputDir: p.inputDir ?? "scenarios/fixtures", held: {}, offered: [] },
    policy: {},
    runtime: {},
    access: {},
  });
}
