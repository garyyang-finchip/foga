import { getAddress } from "ethers";
import type { Node } from "./node.js";
import { newCellConfig } from "./config.js";

/**
 * Advice for a cell that already runs (design memo, section 10, the progressive-hardening refinement). The first run
 * is kept to what it takes to be a cell and nothing more — one key, the defaults, no public face — so that becoming a
 * cell is never a project. What a cell should do *next* is this module's business, and it is advice: state-aware
 * (only what applies to this cell is said), never required, never a gate. Nothing here reads the chain or holds a
 * key; it looks at the configuration and the world's network, so it answers in milliseconds and offline.
 */
export interface Advice {
  id: string;
  /** `recommended` is what a cell that will hold value or run unattended should do; `optional` is good to know. */
  level: "recommended" | "optional";
  title: string;
  why: string;
  how: string;
}

const FREE_PUBLIC_RPC = /publicnode\.com|rpc\.sepolia\.org|1rpc\.io|drpc\.org|ankr\.com\/eth_sepolia|public\.blastapi\.io|gateway\.tenderly\.co|rpc\.ankr\.com\/eth/i;

const same = (a: string, b: string) => getAddress(a) === getAddress(b);

/** The advice that applies to this cell, recommended first, in the order a reader should act on it. */
export function adviseCell(node: Node): Advice[] {
  const cfg = node.config;
  const local = node.world.network === "anvil";
  const chain = local ? "a local chain" : "a public chain";
  const out: Advice[] = [];
  const id = cfg.identity;
  const oneKey = same(id.owner, id.operator) && same(id.owner, id.guardian);

  if (oneKey) {
    out.push({
      id: "separate-roles",
      level: "recommended",
      title: "One key fills owner, operator and guardian; separate them before this cell holds value or runs unattended.",
      why: "The key that serves — always online, on the box — is the one most likely to leak. With the roles separated the box holds only the operator (bounded by the owner's allow-list and the policy; it cannot transfer ownership or move assets outside its scope), the owner stays cold and offline, and an independent guardian can suspend the cell without either. One key gives up all of that for convenience, which is right for a first run and wrong for a cell that matters.",
      how: "Next cell: `foga wallet new --cell` makes the three keys and `foga cell new --wallet` / `foga cell init --wallet` births with them. This cell: `foga cell owner operator_rotate --config <cfg> --operator <a fresh operator address> --wallet <dir>` separates the roles in place (the account, the identity, the skills and the documents stay; the node then runs with the new operator key, and the owner key leaves the serving machine). `foga cell migrate --config <cfg> --to <new.config.json> --operator <address>` is the way when the account itself must change — and a one-key cell on a revision-2 account (born before 1.0.3) rotates first, because that account refuses the owner's asset moves while the owner is also its operator.",
    });
  } else {
    out.push({
      id: "owner-offline",
      level: "recommended",
      title: "Keep the owner key off the serving machine.",
      why: "Serving needs the operator key alone (`foga node serve --wallet` reads operator.key; `FOGA_OPERATOR_KEY_FILE` names it). The owner key is for birth, configuration changes and recovery, and a node refuses to start with it in its environment on purpose.",
      how: "Move owner.key (and guardian.key) to cold storage; leave operator.key on the box, mode 0600, owned by the service user.",
    });
  }

  const defaults = newCellConfig({ name: "x", world: "w", store: "s", owner: id.owner, operator: id.operator, guardian: id.guardian });
  const b = cfg.policy.budget, db = defaults.policy.budget, t = cfg.policy.tenders, dt = defaults.policy.tenders;
  if (b.dailyValueWei === db.dailyValueWei && b.perOperationValueWei === db.perOperationValueWei && b.dailyGasWei === db.dailyGasWei && t.minRewardWei === dt.minRewardWei) {
    out.push({
      id: "tune-policy",
      level: "recommended",
      title: "The policy is at its defaults; set the budget and the tender floor to this cell's own risk.",
      why: "The defaults are sized for a demonstration. `policy.budget` is the most the cell may move per day and per operation and the gas its operator may burn; `policy.tenders` is the least it works for and the deadlines it accepts. Every act is held to them before anything is sent, so they are the cell's real limits.",
      how: "Edit `policy.budget` (dailyValueWei, perOperationValueWei, dailyGasWei, maxConcurrentCommitments) and `policy.tenders` (minRewardWei, the windows, counterpartyMinLevel) in the configuration, then `foga node preflight --config <cfg>`.",
    });
  }

  if (!id.standing) {
    out.push({
      id: "standing",
      level: local ? "optional" : "recommended",
      title: "No standing yet: have an issuer attest the cell under a KYA scheme.",
      why: "A tender may require a KYA level of its fulfiller, and the cell cannot attest itself (ERC-8419). Without standing it takes only the tenders that ask for none.",
      how: "Name the scheme and its issuers in `identity.standing` once an issuer has attested the cell's account; `kya_check` reads it back. On the OG's world the FOGA scheme is registered and the maintainer attests (see the services in /.well-known/foga-cell.json).",
    });
  }

  if (!cfg.runtime.http.publicUrl) {
    out.push({
      id: "public-face",
      level: local ? "optional" : "recommended",
      title: "No public URL: the cell's documents commit as data: URIs and nothing can find it by address.",
      why: "With `runtime.http.publicUrl` set and `allowedHosts` naming it, `foga cell docs publish` commits the ERC-8004 registration, the AID document and the descriptor as URLs the chain points at, the agent card and this manifest answer at /.well-known/*, and the MCP registry can list the remote.",
      how: "Set `runtime.http.publicUrl` and `runtime.http.allowedHosts` (and `presence.provider`), put TLS in front (deploy/Caddyfile), then `foga cell docs publish --config <cfg> --wallet <dir>`.",
    });
  }

  if (!local) {
    out.push({
      id: "supervise",
      level: "recommended",
      title: "Run the node as a service, not in a terminal.",
      why: "A foreground `foga node serve` ends with the session; a reboot or a dropped SSH leaves the cell unreachable and its heartbeat unsent. A supervisor restarts it and keeps it up.",
      how: "deploy/foga-og.service (systemd, host mode) with deploy/og.env.example, and deploy/Caddyfile for TLS — docs/og-deployment.md walks through it.",
    });
    out.push({
      id: "backup",
      level: "recommended",
      title: "Back up the three files; the key is the identity.",
      why: "A cell is its configuration, its store and its key. Config and store restore a node anywhere; the key cannot be regenerated — losing it is losing the cell.",
      how: "Copy cell.config.json and the store (with its -wal/-shm siblings while the node is stopped) to a backup; keep the key file where server backups do not reach. docs/og-deployment.md, \"Backup, restore, move\".",
    });
    if (FREE_PUBLIC_RPC.test(node.rpc)) {
      out.push({
        id: "dedicated-rpc",
        level: "recommended",
        title: "The node runs on a free public RPC; give a cell that matters a dedicated endpoint.",
        why: "Shared endpoints are load-balanced clusters whose nodes lag each other, cap log ranges and rate-limit: the watchers see block-range errors, a skill's log scan can time out, and a transaction can be dropped silently.",
        how: "Set `rpc` in the configuration (or FOGA_RPC_URL) to an endpoint with a key of your own; `foga node preflight` confirms it serves the world's chain.",
      });
    }
  }

  if (cfg.access.keys.length === 0) {
    out.push({
      id: "partner-keys",
      level: "optional",
      title: "No API keys: partners and your own integrations get the public's level only.",
      why: "The public reads and builds; an act — taking a tender for the cell — needs a credential. A key names a caller and bounds what it may do.",
      how: "`foga node key new --config <cfg> --id <name> --level act` mints one (the hash is kept, the key shown once); or grant a wallet by address or ERC-8004 id in `access.signers`.",
    });
  }

  if (!local && cfg.runtime.http.publicUrl) {
    out.push({
      id: "list-registry",
      level: "optional",
      title: "List the cell in the MCP registry so agents find it by search.",
      why: "The registry is the free discovery route beside this manifest and the card; a listing names the npm package and this cell's remote.",
      how: "`foga cell docs build` writes this cell's server.json; `mcp-publisher login github` then `mcp-publisher publish` from that directory (docs/og-deployment.md).",
    });
  }

  out.push({
    id: "onchain-discovery",
    level: "optional",
    title: "On-chain discovery (ERC-8444) is the one route that costs gas; the manifest and the card are the free one.",
    why: "`docs_publish` commits the ARD descriptor so the cell is findable on chain by anyone who never reads this manifest. It is worth doing for a cell that wants to be found that way, and strictly optional.",
    how: "`foga cell docs publish --config <cfg> --wallet <dir>` (sends only what differs from the chain).",
  });

  return out.sort((a, b) => Number(a.level === "optional") - Number(b.level === "optional"));
}

/** The advice as text: the full list, or the short block printed after a success (recommended only, at most five). */
export function formatAdvice(advice: Advice[], o: { brief?: boolean; config?: string } = {}): string {
  if (o.brief) {
    const top = advice.filter((a) => a.level === "recommended").slice(0, 5);
    if (!top.length) return "";
    const lines = ["Next (advice, nothing required):", ...top.map((a) => `  - ${a.title}`)];
    lines.push(`  foga cell advise${o.config ? ` --config ${o.config}` : ""} explains each and lists the rest.`);
    return lines.join("\n");
  }
  if (!advice.length) return "Nothing to advise: this cell is set up as a cell that holds value should be.";
  const lines: string[] = [];
  for (const a of advice) {
    lines.push(`${a.level === "recommended" ? "RECOMMENDED" : "optional   "}  ${a.id}`);
    lines.push(`  ${a.title}`);
    lines.push(`  why: ${a.why}`);
    lines.push(`  how: ${a.how}`);
    lines.push("");
  }
  lines.push("Advice, not requirements: a cell is complete without any of it. Do what fits the value this cell will hold.");
  return lines.join("\n");
}
