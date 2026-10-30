import { concat, getAddress, sha256, toUtf8Bytes, type Contract, type ContractRunner } from "ethers";
import { eventArgs, type World } from "./world.js";

/** ERC-8414 Token-Bound Task Tenders: the work a cell takes or offers. */
export interface TenderTerms {
  asset: string;
  rewardPerCompletion: bigint;
  maxCompletions: bigint;
  submitBy: bigint;
  settleBy: bigint;
  epochLength: bigint;
  maxCompletionsPerEpoch: bigint;
  judgmentWindow: bigint;
}

export const SubmissionStatus = { Pending: 0, Accepted: 1, Rejected: 2 } as const;

export interface Submission {
  fulfiller: string;
  resultHash: string;
  taskVersion: bigint;
  submittedAt: bigint;
  machineSettled: boolean;
  status: number;
}

export function nativeTerms(reward: bigint, overrides: Partial<TenderTerms> = {}): TenderTerms {
  return {
    asset: "0x0000000000000000000000000000000000000000",
    rewardPerCompletion: reward,
    maxCompletions: 1n,
    submitBy: 0n,
    settleBy: 0n,
    epochLength: 0n,
    maxCompletionsPerEpoch: 0n,
    judgmentWindow: 7n * 86400n,
    ...overrides,
  };
}

/** HashlockVerifier profile (x-hashlock-v1): the demander commits sha256(answer); the solver submits sha256(answer ‖ fulfiller). */
export const hashlock = {
  answerHash(answer: Uint8Array | string): string {
    return sha256(typeof answer === "string" ? toUtf8Bytes(answer) : answer);
  },
  resultHash(answer: Uint8Array | string, fulfiller: string): string {
    const a = typeof answer === "string" ? toUtf8Bytes(answer) : answer;
    return sha256(concat([a, getAddress(fulfiller)]));
  },
};

export interface MintParams {
  to: string;
  updateAuthority: string;
  acceptanceAuthority: string;
  tdHash: string;
  taskHash: string;
  taskURI: string;
  terms: TenderTerms;
}

export class Tenders {
  readonly address: string;
  constructor(readonly world: World) {
    this.address = world.address("8414/TaskToken");
  }

  contract(runner?: ContractRunner): Contract {
    return this.world.contract("8414/TaskToken", runner);
  }

  hashlockVerifier(runner?: ContractRunner): Contract {
    return this.world.contract("8414/HashlockVerifier", runner);
  }

  get hashlockAddress(): string {
    return this.world.address("8414/HashlockVerifier");
  }

  // ---- calldata builders (for calls routed through a cell account)

  encodeMint(p: MintParams): string {
    return this.contract().interface.encodeFunctionData("mintTask", [p.to, p.updateAuthority, p.acceptanceAuthority, p.tdHash, p.taskHash, p.taskURI, p.terms]);
  }

  /** fundTask for a native-asset tender: the call must carry `amount` as value. */
  encodeFund(tokenId: bigint, amount: bigint): string {
    return this.contract().interface.encodeFunctionData("fundTask", [tokenId, amount]);
  }

  encodeCommitAnswer(tokenId: bigint, answerHash: string): string {
    return this.hashlockVerifier().interface.encodeFunctionData("commitAnswer", [this.address, tokenId, answerHash]);
  }

  tokenIdFromReceipt(receipt: any): bigint {
    return BigInt(eventArgs(this.contract().interface, receipt, "TaskUpdated", this.address).tokenId);
  }

  encodeSubmit(tokenId: bigint, resultHash: string, resultURI: string): string {
    return this.contract().interface.encodeFunctionData("submitFulfillment", [tokenId, resultHash, resultURI]);
  }

  encodeSettle(tokenId: bigint, submissionId: bigint, proof: Uint8Array | string): string {
    return this.contract().interface.encodeFunctionData("settleFulfillment", [tokenId, submissionId, proof]);
  }

  encodeWithdrawCredit(tokenId: bigint, account: string): string {
    return this.contract().interface.encodeFunctionData("withdrawCredit", [tokenId, account]);
  }

  selectors() {
    const i = this.contract().interface;
    return {
      submitFulfillment: i.getFunction("submitFulfillment")!.selector,
      settleFulfillment: i.getFunction("settleFulfillment")!.selector,
      withdrawCredit: i.getFunction("withdrawCredit")!.selector,
      fundTask: i.getFunction("fundTask")!.selector,
    };
  }

  // ---- demander side (EOA signer)

  async mint(signer: ContractRunner, p: MintParams): Promise<{ tokenId: bigint; receipt: any }> {
    const tx = await this.contract(signer).mintTask(p.to, p.updateAuthority, p.acceptanceAuthority, p.tdHash, p.taskHash, p.taskURI, p.terms);
    const receipt = await tx.wait();
    const tokenId = BigInt(eventArgs(this.contract().interface, receipt, "TaskUpdated", this.address).tokenId);
    return { tokenId, receipt };
  }

  async fundNative(signer: ContractRunner, tokenId: bigint, amount: bigint): Promise<any> {
    const tx = await this.contract(signer).fundTask(tokenId, amount, { value: amount });
    return tx.wait();
  }

  async commitAnswer(signer: ContractRunner, tokenId: bigint, answerHash: string): Promise<any> {
    const tx = await this.hashlockVerifier(signer).commitAnswer(this.address, tokenId, answerHash);
    return tx.wait();
  }

  // ---- views

  async submissionOf(tokenId: bigint, submissionId: bigint): Promise<Submission> {
    const s = await this.contract().submissionOf(tokenId, submissionId);
    return { fulfiller: s.fulfiller, resultHash: s.resultHash, taskVersion: BigInt(s.taskVersion), submittedAt: BigInt(s.submittedAt), machineSettled: Boolean(s.machineSettled), status: Number(s.status) };
  }

  async submissionCount(tokenId: bigint): Promise<bigint> {
    return BigInt(await this.contract().submissionCountOf(tokenId));
  }

  async terms(tokenId: bigint): Promise<TenderTerms> {
    const t = await this.contract().tenderTermsOf(tokenId);
    return { asset: t.asset, rewardPerCompletion: BigInt(t.rewardPerCompletion), maxCompletions: BigInt(t.maxCompletions), submitBy: BigInt(t.submitBy), settleBy: BigInt(t.settleBy), epochLength: BigInt(t.epochLength), maxCompletionsPerEpoch: BigInt(t.maxCompletionsPerEpoch), judgmentWindow: BigInt(t.judgmentWindow) };
  }

  async acceptanceAuthorityOf(tokenId: bigint): Promise<string> {
    return this.contract().acceptanceAuthorityOf(tokenId);
  }

  async escrowBalanceOf(tokenId: bigint): Promise<bigint> {
    return BigInt(await this.contract().escrowBalanceOf(tokenId));
  }

  async creditOf(tokenId: bigint, account: string): Promise<bigint> {
    return BigInt(await this.contract().creditOf(tokenId, account));
  }

  async isCancelled(tokenId: bigint): Promise<boolean> {
    return this.contract().isTenderCancelled(tokenId);
  }

  async nextId(): Promise<bigint> {
    return BigInt(await this.contract().nextId());
  }

  /** Submission id of a FulfillmentSubmitted event in a receipt (receipts of execute() calls carry the token's logs). */
  submissionIdFromReceipt(receipt: any): bigint {
    return BigInt(eventArgs(this.contract().interface, receipt, "FulfillmentSubmitted", this.address).submissionId);
  }
}
