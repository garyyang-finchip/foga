import { keccak256, type Provider, type TransactionReceipt, type TransactionRequest, type Wallet } from "ethers";
import { RevertDecoder } from "./errors.js";
import type { OperationStore, OpRecord } from "./store.js";

/** A transaction the kernel intends to send, identified by an idempotency key. */
export interface SendRequest {
  key: string;
  signer: string;
  kind?: string;
  /** Builds the request once the nonce is fixed (a deployment may need it to predict its own address). */
  build: (ctx: { nonce: number; from: string }) => TransactionRequest | Promise<TransactionRequest>;
}

export interface Confirmed {
  key: string;
  txHash: string;
  receipt: TransactionReceipt;
  /** True when no transaction was broadcast by this call: the store already held the answer. */
  replayed: boolean;
  /** True when the receipt was found on the chain for an operation the store only knew as sent. */
  recovered: boolean;
}

export class OperationAmbiguous extends Error {
  constructor(
    readonly op: OpRecord,
    message: string,
  ) {
    super(message);
    this.name = "OperationAmbiguous";
  }
}

export class OperationReverted extends Error {
  constructor(
    readonly key: string,
    message: string,
    readonly data: string | null,
  ) {
    super(message);
    this.name = "OperationReverted";
  }
}

export interface TxManagerOptions {
  /** Milliseconds to wait for a broadcast transaction's receipt before giving up (the op stays `sent`). */
  receiptTimeoutMs?: number;
  /** Fault injection: exit the process right after this op's hash is recorded, before the broadcast. */
  crashBeforeBroadcast?: string;
  /** Fault injection: exit the process right after this op is broadcast, before its receipt is read. */
  crashAfterBroadcast?: string;
  log?: (line: string) => void;
}

/** Exit code of an injected crash (EX_TEMPFAIL): the run is incomplete and must be resumed. */
export const CRASH_EXIT_CODE = 75;

/**
 * Sends transactions exactly once per key. The sequence for a new operation is: fix the nonce, build, sign,
 * write the hash to the store, broadcast, wait, write the receipt. A resumed run finds the row and asks the chain
 * before deciding: a receipt means done; a pending transaction is waited for; an unknown hash with the nonce
 * still unconsumed is re-sent with that same nonce; an unknown hash with the nonce consumed is ambiguous and is
 * never retried automatically.
 */
export class TxManager {
  readonly decoder = new RevertDecoder();
  private readonly log: (line: string) => void;

  constructor(
    readonly provider: Provider,
    readonly store: OperationStore,
    readonly signers: Record<string, Wallet>,
    readonly options: TxManagerOptions = {},
  ) {
    this.log = options.log ?? (() => {});
  }

  signer(name: string): Wallet {
    const w = this.signers[name];
    if (!w) throw new Error(`unknown signer ${name}`);
    return w;
  }

  async send(req: SendRequest): Promise<Confirmed> {
    const wallet = this.signer(req.signer);
    const rec = this.store.prepare(req.key, req.kind ?? "tx", req.signer);

    if (rec.status === "confirmed" && rec.txHash) {
      const receipt = await this.provider.getTransactionReceipt(rec.txHash);
      if (!receipt) {
        throw new OperationAmbiguous(rec, `operation ${req.key} is confirmed in the store (tx ${rec.txHash}) but the chain has no receipt for it: the store and the chain have diverged (was the chain reset?). Start from a fresh store or point at the right world.`);
      }
      this.store.journal("replayed", { txHash: rec.txHash }, req.key);
      return { key: req.key, txHash: rec.txHash, receipt, replayed: true, recovered: false };
    }

    let nonce: number;
    if (rec.status === "sent" && rec.txHash && rec.nonce !== null) {
      const recovered = await this.recover(rec, wallet.address);
      if (recovered) return recovered;
      nonce = rec.nonce; // unknown to the node and the nonce is still free: send again with the same nonce
    } else {
      nonce = await this.provider.getTransactionCount(wallet.address, "pending");
    }

    const base = await req.build({ nonce, from: wallet.address });
    let populated: TransactionRequest;
    try {
      // The estimate is taken on the pending state; the inclusion state differs by at least the block timestamp
      // (a heartbeat-style SSTORE that was a no-op during the estimate costs 2900 more when the second ticks),
      // so a margin is added to every estimate rather than trusting it to the unit.
      let gasLimit = base.gasLimit;
      if (gasLimit === undefined || gasLimit === null) {
        const estimate = await this.provider.estimateGas({ ...base, from: wallet.address, nonce });
        gasLimit = estimate + estimate / 4n + 20_000n;
      }
      populated = await wallet.populateTransaction({ ...base, from: wallet.address, nonce, gasLimit });
    } catch (e: any) {
      const data = RevertDecoder.revertData(e);
      const explained = this.decoder.explain(e);
      this.store.markFailed(req.key, explained);
      this.store.journal("estimate-failed", { error: explained }, req.key);
      throw new OperationReverted(req.key, `operation ${req.key} would revert: ${explained}`, data);
    }
    const signed = await wallet.signTransaction(populated);
    const txHash = keccak256(signed);
    this.store.markSent(req.key, txHash, nonce);
    this.store.journal("sent", { txHash, nonce, to: populated.to ?? null, kind: req.kind ?? "tx" }, req.key);
    if (this.options.crashBeforeBroadcast === req.key) this.crash(req.key, "before-broadcast");

    await this.provider.broadcastTransaction(signed);
    this.log(`${req.key}: sent ${txHash} (nonce ${nonce}, ${req.signer})`);
    if (this.options.crashAfterBroadcast === req.key) this.crash(req.key, "after-broadcast");

    const receipt = await this.provider.waitForTransaction(txHash, 1, this.options.receiptTimeoutMs ?? 120_000);
    if (!receipt) throw new Error(`operation ${req.key}: no receipt for ${txHash} within the timeout; it stays 'sent' and will be recovered on the next run`);
    return this.finish(req.key, receipt, false);
  }

  /** Decide what a `sent` row means by asking the chain. Returns null when the transaction must be re-sent. */
  private async recover(rec: OpRecord, from: string): Promise<Confirmed | null> {
    const receipt = await this.provider.getTransactionReceipt(rec.txHash!);
    if (receipt) {
      this.store.journal("recovered-receipt", { txHash: rec.txHash, block: receipt.blockNumber }, rec.key);
      this.log(`${rec.key}: recovered receipt for ${rec.txHash} from block ${receipt.blockNumber}; not re-sent`);
      return this.finish(rec.key, receipt, true);
    }
    const pending = await this.provider.getTransaction(rec.txHash!);
    if (pending) {
      this.store.journal("recovered-pending", { txHash: rec.txHash }, rec.key);
      this.log(`${rec.key}: ${rec.txHash} is still pending; waiting`);
      const r = await this.provider.waitForTransaction(rec.txHash!, 1, this.options.receiptTimeoutMs ?? 120_000);
      if (!r) throw new Error(`operation ${rec.key}: ${rec.txHash} stayed pending beyond the timeout`);
      return this.finish(rec.key, r, true);
    }
    const consumed = await this.provider.getTransactionCount(from, "latest");
    if (consumed > rec.nonce!) {
      this.store.journal("ambiguous", { txHash: rec.txHash, nonce: rec.nonce, accountNonce: consumed }, rec.key);
      throw new OperationAmbiguous(rec, `operation ${rec.key}: tx ${rec.txHash} is unknown to the node but nonce ${rec.nonce} of ${from} has been consumed by another transaction. The outcome cannot be decided automatically; inspect the chain and mark the operation by hand.`);
    }
    this.store.journal("resend", { txHash: rec.txHash, nonce: rec.nonce }, rec.key);
    this.log(`${rec.key}: ${rec.txHash} never reached the chain and nonce ${rec.nonce} is free; sending again`);
    return null;
  }

  private finish(key: string, receipt: TransactionReceipt, recovered: boolean): Confirmed {
    if (receipt.status === 0) {
      this.store.markFailed(key, `reverted on chain in tx ${receipt.hash}`);
      this.store.journal("reverted", { txHash: receipt.hash, block: receipt.blockNumber }, key);
      throw new OperationReverted(key, `operation ${key} reverted on chain (tx ${receipt.hash})`, null);
    }
    this.store.markConfirmed(key, receipt.hash, receipt.blockNumber, {
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      gasUsed: receipt.gasUsed.toString(),
      from: receipt.from,
      to: receipt.to,
      contractAddress: receipt.contractAddress,
      logs: receipt.logs.length,
    });
    this.store.journal("confirmed", { txHash: receipt.hash, block: receipt.blockNumber, gasUsed: receipt.gasUsed.toString() }, key);
    return { key, txHash: receipt.hash, receipt, replayed: false, recovered };
  }

  private crash(key: string, where: string): never {
    this.store.journal("crash-injected", { where }, key);
    this.log(`${key}: injected crash (${where}); exiting with code ${CRASH_EXIT_CODE}`);
    process.exit(CRASH_EXIT_CODE);
  }
}
