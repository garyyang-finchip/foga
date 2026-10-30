import { Contract, type ContractRunner } from "ethers";
import { eventArgs, type World } from "./world.js";

/**
 * ERC-8004 Identity Registry surface: the official registry on public chains, the local stub on Anvil.
 * Both expose register(string) / ownerOf / getAgentWallet / setMetadata / transferFrom.
 */
export const ERC8004_ABI = [
  "function register() returns (uint256)",
  "function register(string agentURI) returns (uint256)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function tokenURI(uint256 agentId) view returns (string)",
  "function getMetadata(uint256 agentId, string metadataKey) view returns (bytes)",
  "function setMetadata(uint256 agentId, string metadataKey, bytes metadataValue)",
  "function transferFrom(address from, address to, uint256 agentId)",
  "function safeTransferFrom(address from, address to, uint256 agentId)",
  "function balanceOf(address owner) view returns (uint256)",
  "function supportsInterface(bytes4) view returns (bool)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue)",
];

export class Identity8004 {
  readonly address: string;
  constructor(readonly world: World) {
    this.address = world.address("identity8004");
  }

  contract(runner?: ContractRunner): Contract {
    return new Contract(this.address, ERC8004_ABI, runner ?? this.world.provider);
  }

  /** Calldata for register(agentURI) — used when a contract account registers through `execute`. */
  encodeRegister(agentURI: string): string {
    return this.contract().interface.encodeFunctionData("register(string)", [agentURI]);
  }

  encodeTransfer(from: string, to: string, agentId: bigint): string {
    return this.contract().interface.encodeFunctionData("transferFrom", [from, to, agentId]);
  }

  /** The agent id minted by a register() call, from the Transfer(0, owner, id) event in the receipt. */
  agentIdFromReceipt(receipt: any): bigint {
    const args = eventArgs(this.contract().interface, receipt, "Transfer", this.address);
    return BigInt(args.tokenId);
  }

  async ownerOf(agentId: bigint): Promise<string> {
    return this.contract().ownerOf(agentId);
  }

  async agentWallet(agentId: bigint): Promise<string> {
    return this.contract().getAgentWallet(agentId);
  }
}
