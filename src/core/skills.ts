import type { Contract, ContractRunner } from "ethers";
import { eventArgs, type World } from "./world.js";
import { buildSkillPackage, readSkillDir, type SkillPackage } from "./pack/skillpack.js";

/** ERC-8338 Token-Bound Executable Skills: the cell's capabilities as hash-verified packages. */
export class Skills {
  readonly address: string;
  constructor(readonly world: World) {
    this.address = world.address("8338/SkillToken");
  }

  contract(runner?: ContractRunner): Contract {
    return this.world.contract("8338/SkillToken", runner);
  }

  /** Build a package from a directory (pack.py semantics). */
  packageFromDir(dir: string, opts?: { primaryPath?: string; version?: number; previousPackageHash?: string }): SkillPackage {
    return buildSkillPackage(readSkillDir(dir), opts);
  }

  encodeMint(to: string, updateAuthority: string, pkg: SkillPackage, packageURI: string): string {
    return this.contract().interface.encodeFunctionData("mintSkill", [to, updateAuthority, pkg.mdHash, pkg.packageHash, packageURI]);
  }

  encodeUpdate(tokenId: bigint, pkg: SkillPackage): string {
    return this.contract().interface.encodeFunctionData("updateSkill", [tokenId, pkg.mdHash, pkg.packageHash]);
  }

  encodeSafeTransfer(from: string, to: string, tokenId: bigint): string {
    return this.contract().interface.encodeFunctionData("safeTransferFrom(address,address,uint256)", [from, to, tokenId]);
  }

  tokenIdFromReceipt(receipt: any): bigint {
    return BigInt(eventArgs(this.contract().interface, receipt, "SkillUpdated", this.address).tokenId);
  }

  async skillOf(tokenId: bigint): Promise<{ mdHash: string; packageHash: string; version: bigint }> {
    const b = await this.contract().skillOf(tokenId);
    return { mdHash: b.mdHash, packageHash: b.packageHash, version: BigInt(b.version) };
  }

  async ownerOf(tokenId: bigint): Promise<string> {
    return this.contract().ownerOf(tokenId);
  }

  async skillURI(tokenId: bigint): Promise<string> {
    return this.contract().skillURI(tokenId);
  }
}
