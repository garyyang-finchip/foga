import { createServer, type Server } from "node:http";
import { AbiCoder, Transaction, concat, keccak256, toBeHex, toQuantity, zeroPadValue } from "ethers";

/** A deterministic 32-byte hash for block `n`. */
function blockHash(n: number): string {
  return keccak256(zeroPadValue(toBeHex(Math.max(n, 0)), 8));
}

/**
 * An in-process JSON-RPC chain for the transaction manager's semantics: transactions are parsed, pooled and mined
 * on command (or automatically), receipts, nonces and fees behave as a node's do, and the test controls the edge
 * cases — a pool that never mines, a reverting inclusion, a receipt lookup that fails once. No keys beyond the
 * test's, no network beyond localhost.
 */
interface Pooled {
  raw: string;
  tx: Transaction;
  from: string;
  hash: string;
}

interface Mined extends Pooled {
  block: number;
  status: 0 | 1;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
}

export class MockChain {
  readonly chainId = 31337;
  block = 100;
  baseFee = 1_000_000_000n;
  priorityFee = 100_000_000n;
  gasEstimate = 50_000n;
  /** Mine every transaction as soon as it is sent. */
  autoMine = true;
  /** Mine the next transaction(s) with status 0 (reverted on chain). */
  revertNext = 0;
  /** Fail the next N receipt lookups with an RPC error (a flaky node). */
  failReceiptLookups = 0;
  /** Fail the next N estimates with a revert (a condition not met). */
  revertEstimates = 0;
  /** Answer block 0 with another hash (a chain that was reset since the store was written). */
  resetGenesis = false;
  readonly pool = new Map<string, Pooled>();
  readonly mined = new Map<string, Mined>();
  readonly calls: { method: string; params: unknown[] }[] = [];
  private server!: Server;
  url = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const batch = JSON.parse(body);
        const requests = Array.isArray(batch) ? batch : [batch];
        const answers = requests.map((r: any) => {
          this.calls.push({ method: r.method, params: r.params });
          try {
            return { jsonrpc: "2.0", id: r.id, result: this.handle(r.method, r.params ?? []) };
          } catch (e: any) {
            return { jsonrpc: "2.0", id: r.id, error: { code: e.code ?? -32000, message: e.message, data: e.data } };
          }
        });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(Array.isArray(batch) ? answers : answers[0]));
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", () => resolve()));
    this.url = `http://127.0.0.1:${(this.server.address() as any).port}`;
  }

  stop(): void {
    this.server.closeAllConnections();
    this.server.close();
  }

  /** Nonce `n` of `from` was consumed by a transaction this chain never saw in its pool (a foreign send). */
  consumeNonce(from: string): void {
    const n = this.minedCount(from);
    const tx = new Transaction();
    tx.nonce = n;
    this.block++;
    const hash = keccak256(zeroPadValue(toBeHex(this.block * 1_000_003 + n), 32));
    this.mined.set(hash, { raw: "0x", tx, from, hash, block: this.block, status: 1, gasUsed: 21_000n, effectiveGasPrice: this.baseFee + this.priorityFee });
  }

  minedCount(from: string): number {
    let n = 0;
    for (const m of this.mined.values()) if (m.from.toLowerCase() === from.toLowerCase()) n++;
    return n;
  }

  poolCount(from: string): number {
    let n = 0;
    for (const p of this.pool.values()) if (p.from.toLowerCase() === from.toLowerCase()) n++;
    return n;
  }

  /** Mine every pooled transaction (lowest nonce first per sender), one block. */
  mine(): Mined[] {
    const out: Mined[] = [];
    this.block++;
    const byNonce = [...this.pool.values()].sort((a, b) => Number(a.tx.nonce) - Number(b.tx.nonce));
    const seen = new Set<string>();
    for (const p of byNonce) {
      const key = `${p.from.toLowerCase()}:${p.tx.nonce}`;
      // of several transactions with the same nonce the highest-fee one is mined, the others are dropped
      if (seen.has(key)) continue;
      const same = byNonce.filter((q) => `${q.from.toLowerCase()}:${q.tx.nonce}` === key);
      const winner = same.sort((a, b) => Number((b.tx.maxFeePerGas ?? b.tx.gasPrice ?? 0n) - (a.tx.maxFeePerGas ?? a.tx.gasPrice ?? 0n)))[0];
      seen.add(key);
      for (const q of same) this.pool.delete(q.hash);
      const status = this.revertNext > 0 ? 0 : 1;
      if (this.revertNext > 0) this.revertNext--;
      const price = (winner.tx.maxFeePerGas ?? winner.tx.gasPrice ?? 0n) < this.baseFee + this.priorityFee ? (winner.tx.maxFeePerGas ?? winner.tx.gasPrice ?? 0n) : this.baseFee + this.priorityFee;
      const m: Mined = { ...winner, block: this.block, status, gasUsed: 21_000n, effectiveGasPrice: price };
      this.mined.set(winner.hash, m);
      out.push(m);
    }
    return out;
  }

  /** Drop everything from the pool without mining (a node that forgot the transactions). */
  dropPool(): void {
    this.pool.clear();
  }

  private handle(method: string, params: any[]): unknown {
    switch (method) {
      case "eth_chainId":
        return toQuantity(this.chainId);
      case "net_version":
        return String(this.chainId);
      case "eth_blockNumber":
        return toQuantity(this.block);
      case "eth_gasPrice":
        return toQuantity(this.baseFee + this.priorityFee);
      case "eth_maxPriorityFeePerGas":
        return toQuantity(this.priorityFee);
      case "eth_getBlockByNumber":
      case "eth_getBlockByHash": {
        const n = method === "eth_getBlockByNumber" && params[0] !== "latest" && params[0] !== "pending" ? parseInt(params[0], 16) : this.block;
        const hash = n === 0 && this.resetGenesis ? blockHash(999_999) : blockHash(n);
        return { number: toQuantity(n), hash, parentHash: blockHash(n - 1), timestamp: toQuantity(1_700_000_000 + n * 12), baseFeePerGas: toQuantity(this.baseFee), gasLimit: toQuantity(30_000_000), gasUsed: "0x0", miner: "0x" + "00".repeat(20), nonce: "0x0000000000000000", difficulty: "0x0", extraData: "0x", transactions: [] };
      }
      case "eth_estimateGas": {
        if (this.revertEstimates > 0) {
          this.revertEstimates--;
          const e: any = new Error("execution reverted: not yet");
          e.code = 3;
          e.data = concat(["0x08c379a0", AbiCoder.defaultAbiCoder().encode(["string"], ["not yet"])]);
          throw e;
        }
        return toQuantity(this.gasEstimate);
      }
      case "eth_getTransactionCount": {
        const from = String(params[0]).toLowerCase();
        const mined = this.minedCount(from);
        return toQuantity(params[1] === "pending" ? mined + this.poolCount(from) : mined);
      }
      case "eth_sendRawTransaction": {
        const raw = String(params[0]);
        const tx = Transaction.from(raw);
        const hash = keccak256(raw);
        const from = tx.from!;
        const nonce = Number(tx.nonce);
        const minedNonce = this.minedCount(from);
        if (nonce < minedNonce) throw Object.assign(new Error("nonce too low"), { code: -32000 });
        // a replacement must raise the fee by at least 10 %
        for (const p of this.pool.values()) {
          if (p.from.toLowerCase() === from.toLowerCase() && Number(p.tx.nonce) === nonce) {
            const old = p.tx.maxFeePerGas ?? p.tx.gasPrice ?? 0n;
            const fee = tx.maxFeePerGas ?? tx.gasPrice ?? 0n;
            if (fee < old + old / 10n) throw Object.assign(new Error("replacement transaction underpriced"), { code: -32000 });
            this.pool.delete(p.hash);
          }
        }
        this.pool.set(hash, { raw, tx, from, hash });
        if (this.autoMine) this.mine();
        return hash;
      }
      case "eth_getTransactionByHash": {
        const h = String(params[0]);
        const m = this.mined.get(h);
        if (m) return this.txObject(m, m.block);
        const p = this.pool.get(h);
        return p ? this.txObject(p, null) : null;
      }
      case "eth_getTransactionReceipt": {
        if (this.failReceiptLookups > 0) {
          this.failReceiptLookups--;
          throw Object.assign(new Error("internal error: receipt lookup failed"), { code: -32603 });
        }
        const m = this.mined.get(String(params[0]));
        if (!m) return null;
        return {
          transactionHash: m.hash,
          transactionIndex: "0x0",
          blockHash: blockHash(m.block),
          blockNumber: toQuantity(m.block),
          from: m.from,
          to: m.tx.to,
          cumulativeGasUsed: toQuantity(m.gasUsed),
          gasUsed: toQuantity(m.gasUsed),
          effectiveGasPrice: toQuantity(m.effectiveGasPrice),
          contractAddress: null,
          logs: [],
          logsBloom: "0x" + "00".repeat(256),
          status: toQuantity(m.status),
          type: toQuantity(m.tx.type ?? 2),
        };
      }
      case "eth_call":
        return "0x";
      case "eth_getCode":
        return "0x";
      default:
        throw Object.assign(new Error(`mock chain: unsupported ${method}`), { code: -32601 });
    }
  }

  private txObject(p: Pooled, block: number | null) {
    const t = p.tx;
    return {
      hash: p.hash,
      nonce: toQuantity(t.nonce),
      blockHash: block === null ? null : blockHash(block),
      blockNumber: block === null ? null : toQuantity(block),
      transactionIndex: block === null ? null : "0x0",
      from: p.from,
      to: t.to,
      value: toQuantity(t.value),
      gas: toQuantity(t.gasLimit),
      gasPrice: toQuantity(t.gasPrice ?? t.maxFeePerGas ?? 0n),
      maxFeePerGas: t.maxFeePerGas === null ? undefined : toQuantity(t.maxFeePerGas),
      maxPriorityFeePerGas: t.maxPriorityFeePerGas === null ? undefined : toQuantity(t.maxPriorityFeePerGas),
      input: t.data,
      chainId: toQuantity(this.chainId),
      type: toQuantity(t.type ?? 2),
      accessList: [],
      v: toQuantity(t.signature!.v),
      r: t.signature!.r,
      s: t.signature!.s,
    };
  }
}
