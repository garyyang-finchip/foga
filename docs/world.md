# Worlds

A **world** is one deployed (or attached) instance of the ten-ERC stack on one chain, described by a world file in `deployments/`. World files are the address books every later phase reads.

## World configs (`worlds/*.json`)

`worlds/local.json` (mode `deploy`) describes what to deploy on a local Anvil: names and symbols for the skill and task tokens, AID liveness windows, the Groth16 adapter parameters, ARD kind URIs, the deployer key (anvil account #0 by default, overridable with `FOGA_DEPLOYER_PK`) and the ERC-8004 stand-in.

`worlds/sepolia.json` (mode `attach`) describes the stack that already exists on Sepolia: every reference deployment at its deployed revision, the official ERC-8004 Identity Registry, layer-4 expectations that record the upstream wiring as it is, and notes on the seams. Attaching deploys nothing; it produces a world file from the config.

## Deployment plan

`src/world/plan.ts` lists the steps in dependency order. Libraries are deployed before the contracts that link them and linked by name within a repository; constructor arguments are computed from the config and from earlier steps:

1. `identity8004` — `Identity8004Stub` (local only; attached worlds skip it)
2. ERC-8338 `SkillToken(name, symbol)`
3. ERC-8414 `TaskToken(name, symbol)`, `HashlockVerifier()`
4. ERC-8419 `KYASchemeRegistry()` → `KYARegistry(schemes)` → `KYAPolicyRegistry(kya)` → `ValidationRegistry8004(identity)` → `KYABridge8004(kya, validation, deployer)` → `Groth16Verifier()` → `Groth16KYAVerifierAdapter(groth16, issuerSetRoot, epochLength, epochGrace)`
5. ERC-8434 `AIDRegistry(defaultWindow, maxWindow)`
6. ERC-8436 `ACDFPolicyRegistry()` → `ACDFRegistry(policies)`
7. ERC-8444 `ARDOnchainRegistry()`, `SkillAdapter()`, `TaskAdapter()`, `AgentAdapter(aidRegistry)`, `RegistryAdapter()`; wiring: `registerKind` × 4
8. ERC-8447 `SpecValidator`, `LifecycleLib` (links SpecValidator), `MembershipLib`, `ResourceLib`, `SwarmRegistry([], [])` (links the three), `AllowlistEligibility(deployer)`, `ERC8004Eligibility(identity)`, `IdentityStateEligibility(aidRegistry)`, `SwarmTenderAdapter(swarms, taskToken)`
9. ERC-8454 `AUFUnitRegistry()` → `AUFAssertionRegistry(units)`
10. ERC-8468 `ASFEvaluation`, `ASFLifecycle` (links ASFEvaluation), `ASFSpecificationRegistry()`, `ASFBindingRegistry()` (links both)
11. ERC-8471 `ADRFPolicyRegistry()` → six modules `(policies)` → `ADRFDisputeRegistry(policies, binding, filing, resolution, decision, record, outcome)` → `DuplicateSettlementVerifier()`, `DeclaredVersionVerifier()`, `AttestorQuorumRule()` → `ADRFACDFBridge(adrf, acdf)` → `ADRFServiceEscrow(adrf)`

Scenario-dependent components are deliberately **not** part of a world: KYA schemes, ASF specifications, ACDF and ADRF policies, the eligibility modules that need a scheme id (AssertionLevelEligibility, CompositeEligibility), adapters bound to a policy (ACDFTaskTenderAdapter, SwarmDecisionAdapter, ASFTaskTenderAdapter) and per-cell accounts. The genesis runner creates them in T0/T1 (Phase 2).

## Resumability

The world file is written after every step. `foga world deploy --resume` re-reads it and skips every step whose address still holds code, so an interrupted run (or a public-chain run that stopped on a transient error) continues where it stopped instead of redeploying.

## World ids

`worldId` = `<network>-<chainId>-<batch timestamp>`; the file also carries `bundleHash` and, for forks, `forkSourceBlock`. Two local chain-id-31337 worlds therefore remain distinguishable.

## The ERC-8004 stand-in

`contracts/src/Identity8004Stub.sol` implements the surface the ten reference implementations call on the Identity Registry — `register()` / `register(string)` / `register(string, MetadataEntry[])`, `ownerOf`, `getAgentWallet`, `setAgentWallet(agentId, newWallet, deadline, signature)`, `unsetAgentWallet`, `getMetadata`, `setMetadata`, `setAgentURI`, `tokenURI`, ERC-721 transfers and approvals, ERC-165 — with these documented choices:

- agent ids start at 1 and never repeat;
- `setAgentWallet` requires a signature by the new wallet (ECDSA, or ERC-1271 for contract wallets) over an EIP-712 digest in the stub's own domain (`Identity8004Stub`, version `1`), which is not the official domain;
- the agent wallet is exposed as metadata key `agentWallet` (`abi.encode(address)`), and every change — including the clear on transfer — emits `MetadataSet`, so ERC-8434 resolvers can reconstruct binding intervals;
- transfers clear the agent wallet.

It is tested with Foundry (`contracts/test/Identity8004Stub.t.sol`, no external library needed). Public worlds never use it.

## Public chains

Sepolia runs are read-only in Phase 1 (doctor). Phase 2c deploys FOGA-owned components on Sepolia — eligibility modules, FOGA's own ACDF adapter and revision-4 escrow, per-cell accounts — with the same orchestrator, a gas multiplier (`--gas-multiplier 1.5`) and `--resume`, following the lessons of the upstream runs: take every gas limit from the live `eth_estimateGas`, never from a local chain.
