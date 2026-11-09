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
12. ERC-8490 `AgentMeditationRegistry()` — an extension (0.8.0, docs/meditation.md): no constructor arguments, clock `mode=timestamp`; attach-mode configs name the upstream instance (Sepolia: `0x184dF595404414f91aD11986C47B9a539eF9559f`)
13. ERC-8489 — an extension (0.9.0, docs/flows.md): `AIFPParadigmRegistry()`, `AIFPCompositeVerifier()`, `AIFPChannelRegistry(paradigms)`, `AIFPParticipationRegistry(channels, paradigms, verifier)`, `AIFPEventAnchor(channels, participation)`, `AIFPObjectionWindow(channels, participation)`, `AIFPSubjectSet(deployer)`, and FOGA's own `FogaIdentityVerifier(identity8004, aidRegistry)`; wiring: `setParticipationRegistry` on the channel registry; then the deployer registers FOGA's two paradigms in the family `foga` and opens the default market channel (`flows` in the world file; `--no-flows` leaves that to a cell's `foga flow bootstrap`). Attach-mode configs name the upstream Sepolia instances (`0xe5CC5dc0…`, `0x59c42e47…`, `0x6d0d5A58…`, `0x0Eb8923f…`, `0xCcdf6647…`, `0x8ea02f7c…`, `0x4D72639C…`); the identity verifier (`0x7d5301B3…`, deployed by the OG cell's owner key) and the `flows` block (the family's paradigms, the market `0x32643288…`, bootstrapped by the OG cell on 2026-11-09) are the maintainer's bootstrap on that chain, recorded in the config since 0.9.1

Scenario-dependent components are deliberately **not** part of a world: KYA schemes, ASF specifications, ACDF and ADRF policies, the eligibility modules that need a scheme id (AssertionLevelEligibility, CompositeEligibility), adapters bound to a policy (ACDFTaskTenderAdapter, SwarmDecisionAdapter, ASFTaskTenderAdapter) and per-cell accounts. The genesis runner creates them in T0/T1 (`foga genesis run`, docs/genesis.md); scheme-dependent eligibility modules and policy-bound adapters follow in T4/T5.

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

## Verifying the sources (Sourcify)

```
npm run bundle:verify                                                     # rebuilds the bundle; leaves .foga-build/out/<repo>/build-info/
foga world verify --world deployments/sepolia.json --sourcify             # submits every FOGA-deployed contract of the world
foga world verify --world deployments/local.json --sourcify --dry-run     # writes what would be sent (a local chain is always a dry run)
```

A contract a world deployed from the bundle is verified on Sourcify (`src/world/sourcify.ts`, the 2c leftover the memo's section 9 lists) with the very compiler run that produced it: `forge build` leaves a build-info file per run beside the artifacts — the standard JSON input (sources at the locked commits, settings, remappings) and the output — and `npm run bundle:verify` (or `foga build`) writes them under `.foga-build/out/<repo>/build-info/`. For each `deployed` step of the world file, the request is the build-info of the step's repository whose output holds a contract of the bundle key's name with the bundle's runtime code, the identifier `<path solc saw>:<Name>`, the compiler's long version from the contract's own metadata (`0.8.28+commit.7893614a`), and the creation transaction the world file recorded. Nothing is recompiled, flattened or rewritten for the verifier: what Sourcify checks is what the bundle was built from, and a contract the build-info does not hold is reported `missing` with the reason (an upstream contract attached rather than deployed, a bundle rebuilt without `--build-info`).

The live path is Sourcify's v2 API: `GET /v2/contract/{chainId}/{address}` first (a contract already verified is `already`), then `POST /v2/verify/{chainId}/{address}` with `{stdJsonInput, compilerVersion, contractIdentifier, creationTransactionHash}`, and the ticket's `GET /v2/verify/{verificationId}` polled until `isJobCompleted` — `exact_match` or `match` (creation and runtime match named), `failed` with Sourcify's error, `error` when the request was refused or timed out. `--only <id,id>` narrows to some steps, `--server` another instance (`https://sourcify.dev/server` by default), `--out` where the requests and the report go (`.foga-build/sourcify/<world name>/`: one `<step>.json` per request and `report.json`, schema `foga.sourcify/1`, with a summary by outcome). Exit 3 when anything is `missing`, `failed` or `error`. `test/sourcify.test.ts` runs the matching, a dry run and the v2 exchange against a stand-in; CI dry-runs the whole local world (56 requests, 0 missing) after each bundle verification.
