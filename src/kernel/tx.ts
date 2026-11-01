import { keccak256, type Provider, type TransactionReceipt, type TransactionRequest, type TransactionResponse, type Wallet } from "ethers";
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
  /** Milliseconds to wait for a broadcast transaction's receipt before replacing it or giving up (the op stays `sent`). */
  receiptTimeoutMs?: number;
  /** How many times a transaction still pending after the timeout is re-sent with higher fees (same nonce) before the run stops. */
  maxReplacements?: number;
  /**
   * After a receipt, wait until the endpoint reports the receipt's block twice in a row before returning: a public RPC
   * URL usually fronts a cluster whose nodes import a block at slightly different times, and a read or a gas estimate
   * made right after a receipt can land on a node that has not seen it yet (a roster read as not met one second after
   * the third join confirmed, for instance). Off on a local node.
   */
  awaitVisibility?: boolean;
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
 *
 * A transaction that is still pending when the receipt timeout passes (a public chain whose base fee rose after
 * the quote) is replaced: the same payload and nonce, signed again with fees raised by a third, up to
 * `maxReplacements` times. Every hash the operation ever had is in the journal, and inclusion of any of them
 * completes the operation — the nonce makes them mutually exclusive.
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
    let pendingBefore: TransactionResponse | null = null;
    if (rec.status === "sent" && rec.txHash && rec.nonce !== null) {
      const recovered = await this.recover(rec, wallet.address);
      if (recovered.confirmed) return recovered.confirmed;
      nonce = rec.nonce; // the nonce is still the operation's: either free (re-send) or held by its pending transaction (replace)
      pendingBefore = recovered.pending;
    } else {
      nonce = await this.provider.getTransactionCount(wallet.address, "pending");
    }

    const populated = await this.populate(req, wallet, nonce);
    if (pendingBefore) {
      // the recorded transaction is still in the pool: raise its fees and take its place rather than wait again
      const replaced = await this.replace(req, wallet, populated, pendingBefore, 0);
      await this.ensureVisible(replaced.blockNumber);
      return this.finish(req.key, replaced, true);
    }
    const signed = await wallet.signTransaction(populated);
    const txHash = keccak256(signed);
    this.store.markSent(req.key, txHash, nonce);
    this.store.journal("sent", { txHash, nonce, to: populated.to ?? null, kind: req.kind ?? "tx" }, req.key);
    if (this.options.crashBeforeBroadcast === req.key) this.crash(req.key, "before-broadcast");

    await this.provider.broadcastTransaction(signed);
    this.log(`${req.key}: sent ${txHash} (nonce ${nonce}, ${req.signer})`);
    if (this.options.crashAfterBroadcast === req.key) this.crash(req.key, "after-broadcast");

    const receipt = await this.awaitInclusion(req, wallet, populated, txHash);
    await this.ensureVisible(receipt.blockNumber);
    return this.finish(req.key, receipt, false);
  }

  /** With `awaitVisibility`: wait (up to 60 s) until two consecutive block-number reads are at or past `block`. */
  private async ensureVisible(block: number): Promise<void> {
    if (!this.options.awaitVisibility) return;
    const deadline = Date.now() + 60_000;
    let agreeing = 0;
    let lagged = false;
    while (agreeing < 2 && Date.now() < deadline) {
      const n = await this.provider.getBlockNumber();
      if (n >= block) agreeing++;
      else {
        agreeing = 0;
        lagged = true;
      }
      if (agreeing < 2) await new Promise((r) => setTimeout(r, 750));
    }
    if (lagged) this.store.journal("visibility-waited", { block, caughtUp: agreeing >= 2 });
  }

  /** Build, estimate and populate the request for a nonce; a failing estimate marks the operation failed. */
  private async populate(req: SendRequest, wallet: Wallet, nonce: number): Promise<TransactionRequest> {
    const base = await req.build({ nonce, from: wallet.address });
    try {
      // The estimate is taken on the pending state; the inclusion state differs by at least the block timestamp
      // (a heartbeat-style SSTORE that was a no-op during the estimate costs 2900 more when the second ticks),
      // so a margin is added to every estimate rather than trusting it to the unit.
      let gasLimit = base.gasLimit;
      if (gasLimit === undefined || gasLimit === null) {
        const estimate = await this.provider.estimateGas({ ...base, from: wallet.address, nonce });
        gasLimit = estimate + estimate / 4n + 20_000n;
      }
      return await wallet.populateTransaction({ ...base, from: wallet.address, nonce, gasLimit });
    } catch (e: any) {
      const data = RevertDecoder.revertData(e);
      const explained = this.decoder.explain(e);
      this.store.markFailed(req.key, explained);
      this.store.journal("estimate-failed", { error: explained }, req.key);
      throw new OperationReverted(req.key, `operation ${req.key} would revert: ${explained}`, data);
    }
  }

  /** Every hash this operation was ever broadcast under, oldest first (the store row holds only the latest). */
  private hashesOf(key: string, latest: string): string[] {
    const out: string[] = [];
    for (const j of this.store.journalEntries()) {
      if (j.opKey !== key || !j.detail) continue;
      const h = j.event === "sent" || j.event === "replaced" ? (j.detail.txHash as string | undefined) : undefined;
      if (h && !out.includes(h)) out.push(h);
    }
    if (!out.includes(latest)) out.push(latest);
    return out;
  }

  /**
   * Wait for the broadcast transaction's receipt. When the timeout passes and the transaction is still pending, it is
   * replaced with higher fees (same nonce), up to `maxReplacements` times; when it has vanished from the pool and the
   * nonce is free, it is broadcast again as it was; when any earlier hash of the operation was mined instead, that
   * receipt completes it. After the last attempt the row stays `sent` and the next run resolves it from the chain
   * (docs/kernel.md). A timeout on a local chain usually means the node is starved (another heavy process on the
   * machine) rather than a lost transaction.
   */
  private async awaitInclusion(req: SendRequest, wallet: Wallet, populated: TransactionRequest, txHash: string): Promise<TransactionReceipt> {
    const timeoutMs = this.options.receiptTimeoutMs ?? 120_000;
    const max = this.options.maxReplacements ?? 3;
    let current = populated;
    let hash = txHash;
    for (let attempt = 0; ; attempt++) {
      const receipt = await this.waitAny(req.key, hash, timeoutMs);
      if (receipt) return receipt;
      this.store.journal("receipt-timeout", { txHash: hash, timeoutMs, attempt }, req.key);
      const pending = await this.provider.getTransaction(hash);
      if (attempt >= max) {
        throw new Error(`operation ${req.key}: no receipt for ${hash} within ${timeoutMs / 1000} s${attempt ? ` after ${attempt} fee replacement${attempt === 1 ? "" : "s"}` : ""}${pending ? " (still pending)" : " (not in the pool)"}. The row stays 'sent' and is recovered on the next run (the receipt is read if a transaction of this operation was mined, otherwise it is sent again). If the node is local, check that nothing else is saturating the machine (a proving-key build, for instance) and run again.`);
      }
      if (pending) {
        const r = await this.replace(req, wallet, current, pending, attempt + 1);
        return r;
      }
      // not pending, not mined: either the nonce moved on (ambiguous) or the pool dropped it (send again as it was)
      const consumed = await this.provider.getTransactionCount(wallet.address, "latest");
      if (consumed > Number(current.nonce)) {
        const rec = this.store.get(req.key)!;
        this.store.journal("ambiguous", { txHash: hash, nonce: current.nonce, accountNonce: consumed }, req.key);
        throw new OperationAmbiguous(rec, `operation ${req.key}: tx ${hash} is unknown to the node but nonce ${current.nonce} of ${wallet.address} has been consumed by another transaction. The outcome cannot be decided automatically; inspect the chain and mark the operation by hand.`);
      }
      const signed = await wallet.signTransaction(current);
      this.store.journal("resend", { txHash: hash, nonce: current.nonce }, req.key);
      this.log(`${req.key}: ${hash} left the pool unmined and nonce ${current.nonce} is free; sending again`);
      await this.provider.broadcastTransaction(signed);
      hash = keccak256(signed);
    }
  }

  /**
   * Replace a pending transaction of the operation: the same payload and nonce with fees a third above the pending
   * ones (and above the current quote), recorded as the operation's new hash. Waits for it like a first send.
   */
  private async replace(req: SendRequest, wallet: Wallet, populated: TransactionRequest, pending: TransactionResponse, attempt: number): Promise<TransactionReceipt> {
    const bump = (v: bigint | null | undefined, floor: bigint | null | undefined) => {
      const a = BigInt(v ?? 0n);
      const b = BigInt(floor ?? 0n);
      const base = a > b ? a : b;
      return base + base / 3n + 1n;
    };
    const next: TransactionRequest = { ...populated };
    if (pending.maxFeePerGas !== null && pending.maxFeePerGas !== undefined) {
      next.maxFeePerGas = bump(pending.maxFeePerGas, populated.maxFeePerGas as bigint | undefined);
      next.maxPriorityFeePerGas = bump(pending.maxPriorityFeePerGas, populated.maxPriorityFeePerGas as bigint | undefined);
      if ((next.maxPriorityFeePerGas as bigint) > (next.maxFeePerGas as bigint)) next.maxFeePerGas = next.maxPriorityFeePerGas;
    } else {
      next.gasPrice = bump(pending.gasPrice, populated.gasPrice as bigint | undefined);
      delete next.maxFeePerGas;
      delete next.maxPriorityFeePerGas;
    }
    const signed = await wallet.signTransaction(next);
    const hash = keccak256(signed);
    this.store.markSent(req.key, hash, Number(next.nonce));
    this.store.journal("replaced", { txHash: hash, replaces: pending.hash, nonce: next.nonce, attempt, maxFeePerGas: next.maxFeePerGas?.toString() ?? null, maxPriorityFeePerGas: next.maxPriorityFeePerGas?.toString() ?? null, gasPrice: next.gasPrice?.toString() ?? null }, req.key);
    this.log(`${req.key}: ${pending.hash} still pending after the timeout; replaced by ${hash} with fees raised by a third (attempt ${attempt})`);
    try {
      await this.provider.broadcastTransaction(signed);
    } catch (e: any) {
      // the original was mined between the check and the broadcast, or the pool refuses the replacement: the wait decides
      this.store.journal("replace-rejected", { txHash: hash, error: String(e?.shortMessage ?? e?.message ?? e) }, req.key);
      this.log(`${req.key}: the node refused the replacement (${e?.shortMessage ?? e?.message}); waiting for whichever transaction is included`);
    }
    return this.awaitInclusion(req, wallet, next, hash);
  }

  /** The receipt of any hash the operation ever had, or null when none is mined within the timeout. */
  private async waitAny(key: string, latest: string, timeoutMs: number): Promise<TransactionReceipt | null> {
    const hashes = this.hashesOf(key, latest);
    const deadline = Date.now() + timeoutMs;
    const poll = (this.provider as { pollingInterval?: number }).pollingInterval ?? 4_000;
    for (;;) {
      for (const h of hashes) {
        const r = await this.provider.getTransactionReceipt(h);
        if (r) return r;
      }
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, Math.min(poll, Math.max(0, deadline - Date.now()))));
    }
  }

  /**
   * Decide what a `sent` row means by asking the chain about every hash the operation had: a receipt completes it;
   * a pending transaction is returned for replacement; an unknown hash with the nonce still free means re-send; an
   * unknown hash with the nonce consumed is ambiguous and is never retried automatically.
   */
  private async recover(rec: OpRecord, from: string): Promise<{ confirmed: Confirmed | null; pending: TransactionResponse | null }> {
    for (const h of this.hashesOf(rec.key, rec.txHash!)) {
      const receipt = await this.provider.getTransactionReceipt(h);
      if (receipt) {
        this.store.journal("recovered-receipt", { txHash: h, block: receipt.blockNumber }, rec.key);
        this.log(`${rec.key}: recovered receipt for ${h} from block ${receipt.blockNumber}; not re-sent`);
        await this.ensureVisible(receipt.blockNumber);
        return { confirmed: this.finish(rec.key, receipt, true), pending: null };
      }
    }
    const pending = await this.provider.getTransaction(rec.txHash!);
    if (pending) {
      this.store.journal("recovered-pending", { txHash: rec.txHash }, rec.key);
      this.log(`${rec.key}: ${rec.txHash} is still pending; replacing it with higher fees`);
      return { confirmed: null, pending };
    }
    const consumed = await this.provider.getTransactionCount(from, "latest");
    if (consumed > rec.nonce!) {
      this.store.journal("ambiguous", { txHash: rec.txHash, nonce: rec.nonce, accountNonce: consumed }, rec.key);
      throw new OperationAmbiguous(rec, `operation ${rec.key}: tx ${rec.txHash} is unknown to the node but nonce ${rec.nonce} of ${from} has been consumed by another transaction. The outcome cannot be decided automatically; inspect the chain and mark the operation by hand.`);
    }
    this.store.journal("resend", { txHash: rec.txHash, nonce: rec.nonce }, rec.key);
    this.log(`${rec.key}: ${rec.txHash} never reached the chain and nonce ${rec.nonce} is free; sending again`);
    return { confirmed: null, pending: null };
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
