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
 */
const BLOCK_PARAM: Record<string, number> = { eth_call: 1, eth_estimateGas: 1, eth_getBalance: 1, eth_getCode: 1, eth_getTransactionCount: 1, eth_getStorageAt: 2 };
const BEHIND = /header not found|unknown block|block not found|missing trie node|cannot query|beyond|out of range|unknown header|no state|state (is )?not available|pruned|too old|invalid block|resource not found/i;

export class PinnedProvider extends JsonRpcProvider {
  /** The highest block seen; reads are made no earlier than this. */
  pin = 0;
  /** Milliseconds to keep retrying a read that a lagging node refused before giving up. */
  settleMs = 30_000;

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
    pinned[idx] = toQuantity(this.pin);
    const deadline = Date.now() + this.settleMs;
    for (let attempt = 0; ; attempt++) {
      try {
        return await super.send(method, pinned);
      } catch (e: any) {
        // ethers wraps a node's error (a call's as CALL_EXCEPTION); the node's own words are in info.error
        const text = [e?.info?.error?.message, e?.error?.message, e?.shortMessage, e?.message].filter(Boolean).join(" | ");
        // a contract's revert is an answer, not a lag: it is never retried
        const reverted = /execution reverted/i.test(text) || Boolean(e?.data) || Boolean(e?.revert);
        if (reverted || !BEHIND.test(text) || Date.now() >= deadline) throw e;
        await new Promise((r) => setTimeout(r, Math.min(2_000, 250 * (attempt + 1))));
      }
    }
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
