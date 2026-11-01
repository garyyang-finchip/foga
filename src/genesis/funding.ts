import { formatEther, parseEther, parseUnits, type Provider } from "ethers";
import type { Kernel } from "../kernel/kernel.js";
import { CELLS, ROLE_ORDER, type Role } from "./roles.js";
import type { StepName } from "./scenario.js";

/**
 * Who pays for what. Every role pays its own gas; the cells hold working capital (rewards they fund, deposits
 * they make) and receive what they earn. W is the treasury of the genesis: it tops the other roles up to a floor
 * before every step and gives each cell its capital at birth.
 *
 * On anvil the first ten accounts are pre-funded, so only the judges beyond them (J1-J3) and the cells need
 * anything. On a public chain the floors come from the gas each role spent in the Sepolia run of 2026-11-01
 * (docs/genesis.md, "Running on a public chain"), with a margin, at the fee the chain quotes when the step starts:
 * a floor is a budget in gas, priced when it is checked, so a rising base fee raises the top-up rather than
 * starving a role. A role is refilled to its floor once it has fallen below half of it. The quote is never taken
 * below a floor of its own (FOGA_FEE_FLOOR_GWEI, default 0.1 gwei): a testnet quotes fractions of a wei when it is
 * quiet, and a role funded at that price would be stranded by the first busy block.
 */

/**
 * Gas a role spends over T0-T9 on a public chain, rounded up with a margin of about one half. Measured on Sepolia
 * (deployments/sepolia.genesis.example.json, 203 operations, 475 M gas in all): W 131 M, G 0.8 M, owner.A 44.7 M,
 * owner.B and owner.C 21.9 M each, operator.A 85.7 M, operator.B 103.5 M, operator.C 32.2 M, E 31.8 M, J1 0.8 M,
 * J2 0.4 M, J3 nothing (the council decides with two of three). Sepolia's gas schedule prices the same operations
 * 4.4 times higher than anvil's (a plain transfer 204,600 gas, code deposit about 1,500 gas per byte: deployments
 * cost 6.5-7 times, calls 2-5 times), which is what a public chain costs from now on. The judges share one budget
 * so that whichever two of them decide are funded.
 */
export const ROLE_GAS_BUDGET: Record<Role, bigint> = {
  W: 200_000_000n, // the genesis only; what `foga world deploy` spends before it is budgeted in src/world/deploy.ts (DEPLOY_GAS_PER_STEP)
  G: 1_250_000n,
  "owner.A": 67_000_000n,
  "owner.B": 33_000_000n,
  "owner.C": 33_000_000n,
  "operator.A": 130_000_000n,
  "operator.B": 156_000_000n,
  "operator.C": 49_000_000n,
  E: 48_000_000n,
  J1: 1_250_000n,
  J2: 1_250_000n,
  J3: 1_250_000n,
};

/** Working capital of the cells: what they fund, deposit and keep (B funds 0.003 ETH of rewards over T3 and T7, C deposits 0.002). */
export const CELL_CAPITAL = { local: parseEther("0.05"), public: parseEther("0.005") };
export const SUCCESSOR_CAPITAL = { local: parseEther("0.01"), public: parseEther("0.001") };
/** What W itself pays into tenders (the T4 reward and the T5 no-decision reward), on top of its gas. */
export const W_VALUE_OUTLAY = parseEther("0.003");
/** The least fee per gas a budget is priced at: FOGA_FEE_FLOOR_GWEI, default 0.1 gwei. */
export function feeFloor(): bigint {
  const v = process.env.FOGA_FEE_FLOOR_GWEI?.trim();
  return parseUnits(v && /^\d+(\.\d+)?$/.test(v) ? v : "0.1", "gwei");
}

/** anvil pre-funds its first ten accounts with 10 000 ETH; the judges are beyond them. */
const LOCAL_FLOORS: Partial<Record<Role, bigint>> = { J1: parseEther("1"), J2: parseEther("1"), J3: parseEther("1") };

export interface FundingLine {
  role: Role;
  address: string;
  balance: bigint;
  floor: bigint;
  topUp: bigint;
}

export interface FundingPlan {
  /** The fee per gas the floors were priced at (wei). */
  price: bigint;
  lines: FundingLine[];
  /** What W must hold to cover every top-up of this plan plus its own budget. */
  needW: bigint;
  balanceW: bigint;
}

/** The fee per gas used to price a budget: the chain's current maxFeePerGas quote, at least the fee floor. */
export async function quotePriceOf(provider: Provider): Promise<bigint> {
  const fee = await provider.getFeeData();
  const quoted = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  const floor = feeFloor();
  return quoted > floor ? quoted : floor;
}

export function quotePrice(k: Kernel): Promise<bigint> {
  return quotePriceOf(k.world.provider);
}

export function floorOf(role: Role, local: boolean, price: bigint): bigint {
  if (local) return LOCAL_FLOORS[role] ?? 0n;
  return ROLE_GAS_BUDGET[role] * price;
}

/**
 * The gas an operator must still hold for its cell to take on work (the kernel's pre-commitment check): a quarter of
 * the role's budget at the current price on a public chain; 0.01 ETH on anvil, where the operators are pre-funded.
 */
export async function operatorGasFloor(k: Kernel, role: Role): Promise<bigint> {
  if (k.isLocalChain) return parseEther("0.01");
  return (ROLE_GAS_BUDGET[role] * (await quotePrice(k))) / 4n;
}

/** Balances against floors for every role but W, and W's own requirement. */
export async function fundingPlan(k: Kernel, price?: bigint): Promise<FundingPlan> {
  const local = k.isLocalChain;
  const p = price ?? (await quotePrice(k));
  const lines: FundingLine[] = [];
  for (const role of ROLE_ORDER) {
    if (role === "W") continue;
    const address = k.address(role);
    const balance = await k.balance(address);
    const floor = floorOf(role, local, p);
    // refilled to the floor once below half of it: a role that merely spent a little is not topped up at every step
    lines.push({ role, address, balance, floor, topUp: balance < floor / 2n ? floor - balance : 0n });
  }
  const capital = local ? CELL_CAPITAL.local * BigInt(CELLS.length) + SUCCESSOR_CAPITAL.local : CELL_CAPITAL.public * BigInt(CELLS.length) + SUCCESSOR_CAPITAL.public;
  const own = local ? 0n : ROLE_GAS_BUDGET.W * p + W_VALUE_OUTLAY;
  const needW = lines.reduce((a, l) => a + l.topUp, 0n) + capital + own;
  return { price: p, lines, needW, balanceW: await k.balance(k.address("W")) };
}

/**
 * Before a step: W tops up every role that has fallen below its floor. Keyed per step and role, so a run that
 * resumes finds the transfers it made and a role that stayed funded costs nothing. Fails before any transfer when W
 * itself cannot cover the step, naming the shortfall.
 */
export async function fundRoles(k: Kernel, step: StepName, log: (line: string) => void): Promise<FundingLine[]> {
  // facts hold bigints as decimal strings: a resumed run reads the price back as a string
  const price = BigInt(await k.memo<string>(`${step}.fund.price`, async () => (await quotePrice(k)).toString()));
  const plan = await fundingPlan(k, price);
  const due = plan.lines.filter((l) => l.topUp > 0n || k.store.get(`${step}.fund.${l.role}`)?.status === "confirmed");
  if (!due.length) return [];
  const total = due.reduce((a, l) => a + l.topUp, 0n);
  if (plan.balanceW < total) {
    throw new Error(`W ${k.address("W")} holds ${formatEther(plan.balanceW)} ETH but ${step} needs ${formatEther(total)} ETH of top-ups at ${Number(price) / 1e9} gwei (${due.map((l) => `${l.role} ${formatEther(l.topUp)}`).join(", ")}). Fund W and run again; \`foga genesis preflight\` prints the full plan.`);
  }
  for (const l of due) {
    // the amount is fixed the first time (a resumed run must rebuild the same transfer), so a replayed row costs nothing new
    const amount = await k.memo<string>(`${step}.fund.${l.role}.amount`, () => l.topUp.toString());
    if (BigInt(amount) === 0n) continue;
    await k.transfer(`${step}.fund.${l.role}`, "W", l.address, BigInt(amount));
    log(`  fund: W -> ${l.role} ${formatEther(BigInt(amount))} ETH (floor ${formatEther(l.floor)} at ${Number(price) / 1e9} gwei)`);
  }
  return due;
}

export function formatPlan(plan: FundingPlan, local: boolean): string[] {
  const out = [`fee per gas used for the floors: ${Number(plan.price) / 1e9} gwei${local ? " (local chain: fixed floors)" : plan.price === feeFloor() ? ` (the floor, FOGA_FEE_FLOOR_GWEI; the chain quotes less)` : " (the chain's quote)"}`];
  for (const l of plan.lines) out.push(`  ${l.role.padEnd(11)} ${l.address}  balance ${formatEther(l.balance).padStart(10)}  floor ${formatEther(l.floor).padStart(10)}  ${l.topUp > 0n ? `top-up ${formatEther(l.topUp)}` : "ok"}`);
  out.push(`  W needs ${formatEther(plan.needW)} ETH for the top-ups, the cells' capital (${formatEther(local ? CELL_CAPITAL.local : CELL_CAPITAL.public)} each) and its own budget; it holds ${formatEther(plan.balanceW)} ETH${plan.balanceW < plan.needW ? ` — short by ${formatEther(plan.needW - plan.balanceW)} ETH` : ""}`);
  return out;
}
