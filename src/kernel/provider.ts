import { JsonRpcProvider, toQuantity, type JsonRpcApiProviderOptions, type Networkish } from "ethers";

/**
 * A JSON-RPC provider that reads what it has written. A public RPC URL usually fronts a cluster whose nodes import a
 * block at slightly different times; a read or a gas estimate made right after a receipt can reach a node that has not
 * seen the block yet and answer from the state before it (on Sepolia the roster of a swarm read as not met one second
 * after its third join confirmed; a call opened in one block was "unknown" to the estimate of its delivery in the next).
 *
 * The provider keeps a pin: the highest block it has seen in a receipt, a block header or a block number. Every state
 * read at "latest" (eth_call, eth_estimateGas, eth_getBalance, eth_getCode, eth_getStorageAt, eth_getTransactionCount at
 * "latest") is sent at that block instead, so a node behind the pin answers with an error rather than with stale state,
 * and the request is retried until a node that has the block answers. Explicit block tags, "pending" and everything that
 * is not a state read pass through unchanged. On a single local node the pin is always the node's own tip.
 *
 * The pin must start at the chain's head (the kernel reads the block number when it opens): the receipts a replayed
 * run reads back are old, and a pin seeded from them would make every read a read of the past — a document read as
 * its earlier version, a swarm read as still active — which is what the first Sepolia replays did.
 */
const BLOCK_PARAM: Record<string, number> = { eth_call: 1, eth_estimateGas: 1, eth_getBalance: 1, eth_getCode: 1, eth_getTransactionCount: 1, eth_getStorageAt: 2 };
// what the clients of a public cluster say when asked about a block they do not (yet) have the state of: geth ("header
// not found", "missing trie node"), erigon and reth ("block not found"), nethermind ("historical state ... is not
// available", which it also says for a block one behind its own head), besu ("Block not found"), and a few gateways
const BEHIND = /header not found|unknown block|block not found|missing trie node|cannot query|beyond|out of range|unknown header|no state|historical state|state (is )?not available|not available|pruned|too old|invalid block|resource not found/i;

export interface PinnedReadEvent {
  method: string;
  block: number;
  attempts: number;
  /** The node's own words for the last refusal. */
  nodeError: string;
  /** What happened after the retries: the pin was lowered to the head the endpoint reports and the read made there, or the error was raised. */
  outcome: "re-pinned" | "raised";
}

export class PinnedProvider extends JsonRpcProvider {
  /** The highest block seen; reads are made no earlier than this. */
  pin = 0;
  /** Milliseconds to keep retrying a read that a lagging node refused before re-sampling the head and, failing that, raising. */
  settleMs = 60_000;
  /** Told when a pinned read ran out of retries (the kernel journals it). */
  onLag?: (event: PinnedReadEvent) => void;

  constructor(url: string, network?: Networkish, options?: JsonRpcApiProviderOptions) {
    super(url, network, options);
  }

  override async send(method: string, params: Array<any>): Promise<any> {
    const idx = BLOCK_PARAM[method];
    const tag = idx === undefined ? undefined : params[idx];
    const pinnable = idx !== undefined && this.pin > 0 && (tag === undefined || tag === null || tag === "latest");
    if (!pinnable) {
      const result = await super.send(method, params);
      this.observe(method, params, result);
      return result;
    }
    const pinned = [...params];
    while (pinned.length <= idx) pinned.push("latest");
    const block = this.pin;
    pinned[idx] = toQuantity(block);
    const deadline = Date.now() + this.settleMs;
    for (let attempt = 1; ; attempt++) {
      try {
        return await super.send(method, pinned);
      } catch (e: any) {
        // ethers wraps a node's error (a call's as CALL_EXCEPTION, "missing revert data"); the node's own words are in info.error
        const text = [e?.info?.error?.message, e?.error?.message, e?.shortMessage, e?.message].filter(Boolean).join(" | ");
        // a contract's revert is an answer, not a lag: it is never retried
        const reverted = /execution reverted/i.test(text) || Boolean(e?.data) || Boolean(e?.revert);
        if (reverted) throw e;
        const behind = BEHIND.test(text);
        if (behind && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, Math.min(2_000, 250 * attempt)));
          continue;
        }
        // The lag outlasted the retries, or the refusal is one we do not recognize. A read at "latest" is not an
        // option: the node that refuses an explicit block may be the one that is hours behind, and a stale answer is
        // worse than no answer (it fails checks that hold on chain). Instead the head is sampled again: when the pin
        // came from a node ahead of the rest, it is lowered to what the endpoint reports now and the read made there,
        // once; otherwise the error is raised with the node's own words, and the run resumes from its store.
        const head = await this.sampleHead();
        if (head > 0 && head < block && pinned[idx] !== toQuantity(head)) {
          this.pin = head;
          pinned[idx] = toQuantity(head);
          try {
            const result = await super.send(method, pinned);
            this.onLag?.({ method, block, attempts: attempt, nodeError: text, outcome: "re-pinned" });
            return result;
          } catch (e2: any) {
            this.raise(e2, method, block, attempt, text);
          }
        }
        this.raise(e, method, block, attempt, text);
      }
    }
  }

  /** The highest block number three consecutive samples of the endpoint report (an outlier ahead is not followed twice). */
  private async sampleHead(): Promise<number> {
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      try {
        seen.push(parseInt(await super.send("eth_blockNumber", []), 16));
      } catch {
        /* a sample that fails is left out */
      }
      if (i < 2) await new Promise((r) => setTimeout(r, 300));
    }
    seen.sort((a, b) => a - b);
    return seen.length ? seen[Math.floor(seen.length / 2)] : 0;
  }

  private raise(e: any, method: string, block: number, attempts: number, text: string): never {
    this.onLag?.({ method, block, attempts, nodeError: text, outcome: "raised" });
    if (e && typeof e === "object" && typeof e.message === "string") e.message += ` [read at block ${block} refused ${attempts} time${attempts === 1 ? "" : "s"} by the endpoint: ${text}]`;
    throw e;
  }

  /** Move the pin forward from what the chain tells us. */
  private observe(method: string, params: Array<any>, result: any): void {
    let n: number | null = null;
    if (method === "eth_blockNumber" && typeof result === "string") n = parseInt(result, 16);
    else if (method === "eth_getTransactionReceipt" && result?.blockNumber) n = parseInt(result.blockNumber, 16);
    else if (method === "eth_getBlockByNumber" && result?.number && (params[0] === "latest" || params[0] === "pending")) n = parseInt(result.number, 16);
    if (n !== null && Number.isFinite(n) && n > this.pin) this.pin = n;
  }

  /** The kernel confirms a receipt: nothing is read before its block from now on. */
  advanceTo(block: number): void {
    if (block > this.pin) this.pin = block;
  }
}
