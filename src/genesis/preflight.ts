import { formatEther, getAddress } from "ethers";
import { readJson } from "../util/fs.js";
import type { WorldFile } from "../world/types.js";
import { Kernel } from "../kernel/kernel.js";
import { formatPlan, fundingPlan } from "./funding.js";
import { ROLE_ORDER, roleKeys } from "./roles.js";
import { LOCAL_TIMING, PUBLIC_TIMING, LIVENESS_DEMO_WINDOW } from "./scenario.js";
import { predicateAvailability, zkAvailability } from "./zk.js";

export interface PreflightOptions {
  worldPath: string;
  rpc: string;
  bundlePath?: string;
  log: (line: string) => void;
}

/**
 * `foga genesis preflight`: everything a run on a public chain needs, checked before the first transaction — the
 * RPC and its chain, the twelve keys, every role's balance against its floor and what W must hold, the escrow's
 * admin, the proving material, and how long the waits will take. Nothing is sent. Returns the problems found.
 */
export async function preflight(opts: PreflightOptions): Promise<string[]> {
  const problems: string[] = [];
  const say = opts.log;
  const world = readJson<WorldFile>(opts.worldPath);
  if (world.schema !== "foga.world/1") throw new Error(`${opts.worldPath} is not a deployed world file (run foga world deploy first)`);
  const keys = roleKeys(world);
  const k = await Kernel.open({ worldPath: opts.worldPath, rpc: opts.rpc, bundlePath: opts.bundlePath, storePath: ":memory:", keys });
  try {
    const net = await k.world.provider.getNetwork();
    const block = await k.world.provider.getBlock("latest");
    say(`world ${world.worldId} (${world.network}, chain ${world.chainId}, ${world.mode}) via ${opts.rpc}: chain ${net.chainId}, block ${block?.number} at ${new Date(Number(block?.timestamp) * 1000).toISOString()}`);

    say("roles:");
    for (const role of ROLE_ORDER) say(`  ${role.padEnd(11)} ${k.address(role)}`);

    const plan = await fundingPlan(k);
    say("funding:");
    for (const line of formatPlan(plan, k.isLocalChain)) say(line);
    if (plan.balanceW < plan.needW) problems.push(`W ${k.address("W")} is short by ${formatEther(plan.needW - plan.balanceW)} ETH (holds ${formatEther(plan.balanceW)}, needs ${formatEther(plan.needW)} at ${Number(plan.price) / 1e9} gwei)`);

    const admin: string = await k.adrf.escrow().admin();
    const adminOk = getAddress(admin) === getAddress(k.address("W"));
    say(`escrow: ${k.adrf.escrowAddress} administered by ${admin}${adminOk ? " (W)" : " (NOT W)"}`);
    if (!adminOk) problems.push(`the world's ADRFServiceEscrow is administered by ${admin}, not by W: deploy the world with W's key`);

    say(`AID: primary registry ${k.aid.address}${k.aid.backing ? `; backing registry ${k.aid.backing.address} (${k.aid.backing.id}): cells bind, heartbeat and retire in both` : " (no backing registry)"}`);
    const defaultWindow = await k.aid.defaultLivenessWindow();
    say(`  default liveness window ${defaultWindow} s; T7 shortens A's window to ${LIVENESS_DEMO_WINDOW} s and waits for it`);

    const zk = zkAvailability();
    const pred = predicateAvailability();
    say(`zk: credential path ${zk.ok ? "available" : "not available (" + zk.missing.join("; ") + ")"}; predicate path ${pred.ok ? "available" : "not available (" + pred.missing.join("; ") + ")"}`);

    const t = k.isLocalChain ? LOCAL_TIMING : PUBLIC_TIMING;
    const waits = t.appealWindow + t.councilWindow + t.noDecisionJudgmentWindow + t.appealWindow + t.service.reviewWindow + t.service.disputePeriod + LIVENESS_DEMO_WINDOW;
    say(`timing: ${k.isLocalChain ? "local profile (the clock is moved)" : `public profile: about ${Math.round(waits / 60)} minutes of waiting over T5-T7 (council ${t.councilWindow} s, appeal ${t.appealWindow} s, judgment ${t.noDecisionJudgmentWindow} s, review ${t.service.reviewWindow} s, dispute period ${t.service.disputePeriod} s), plus one block per operation (about 190 operations)`}`);
  } finally {
    k.close();
    k.world.provider.destroy();
  }
  return problems;
}
