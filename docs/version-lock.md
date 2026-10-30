# Version lock

FOGA locks five things separately, because they drift separately:

| Locked object | Where | What it answers |
|---|---|---|
| Specification text | `vendor/LOCK.json` → `spec` (file path inside the repository, or the ethereum/ERCs location once merged) | which version of the rules FOGA claims to follow |
| Reference implementation | `vendor/LOCK.json` → `commit` | which code FOGA compiles and deploys |
| Build | `artifacts/bundle.json` → `builtWith`, per-contract `compiler`, `settings`, `sourceKeccak`, and the bundle `hash` | whether anyone can rebuild the same contracts |
| Deployment | `deployments/<world>.json` → `worldId`, `chainId`, `bundleHash`, `batch`, per-contract tx/block/args/libraries | which world instance a run talks to |
| Evidence | doctor reports (`*.doctor.json`) and, from Phase 2, genesis evidence files, each naming the world and bundle they were produced against | what has actually been verified on that instance |

## Locked commits (2026-10-30)

| ERC | Repository | Commit | Upstream toolchain | Bundle profile |
|---|---|---|---|---|
| 8338 | skill-token-standard | `359ad64aa698c7c206bee9329a9a5ec05f12a685` | foundry, solc 0.8.24, optimizer (default runs) | native |
| 8414 | task-token-standard | `b3da62e761b00ef0921860f353d7eed24c6c85ae` | foundry, solc 0.8.24, runs 1 | native |
| 8419 | kya-standard | `f204f2ec2115bd8d1a96de60e0e844dee31cfe1b` | solc-js 0.8.28, runs 200, cancun (`tools/compile.js`) | staged: same settings on solc 0.8.28 |
| 8434 | aid-standard | `1ff7215505af0f4699d437744402bd1e1b4dd043` | solc-js 0.8.28, runs 200, cancun (`scripts/compile.js`) | staged: same settings on solc 0.8.28 |
| 8436 | acd-framework | `f8204fb9c38d47d619b9d8bc81441dfe9e8e7f91` | foundry, solc 0.8.24, runs 1, via-IR | native |
| 8444 | ard-onchain-framework | `26416854e489564fc32c4a69cf9c176b703dc089` | foundry, solc 0.8.24, runs 200 | native |
| 8447 | swarm-ai-framework | `de5bc291ab93bca0163bec47caa66136d1cf3f6a` | foundry, solc 0.8.24, runs 1, via-IR, external libraries | native |
| 8454 | aifi-unit-framework | `1be1da69811875bae0a6fd7b10152b4831e5538f` | foundry, solc 0.8.30, runs 200, cancun, bytecode_hash none | native |
| 8468 | agent-safety-framework | `a76071c0e0ab76c296a0eb878dee1365ce5a78bc` | foundry, solc 0.8.30, runs 200, via-IR, cancun, bytecode_hash none, external libraries | native |
| 8471 | ai-dispute-resolution | `cd5a3e076d648ff5c29d87ab023b22398e0ab17a` | foundry, solc 0.8.30, runs 200, via-IR, cancun, bytecode_hash none | native |

"Staged" means the contract tree is copied into a throw-away Foundry project whose settings mirror the upstream solc-js script (same compiler version and commit — `0.8.28+commit.7893614a`, the version recorded in the upstream Sepolia deployments — same optimizer, runs, EVM version and metadata settings). Only the orchestration changes; the compiler input does not. Source paths in the staged project equal the upstream script's source names, so even the metadata hash is expected to match.

## Deployed revision versus locked source (Sepolia)

The upstream reference deployments on Sepolia were made at various revisions. `worlds/sepolia.json` records the deployed revision per contract so the doctor can label a layer-3 mismatch as *known* rather than as a defect:

| ERC | Deployed on Sepolia | Locked source | Expected doctor verdict on layer 3 |
|---|---|---|---|
| 8338 | KERNEL v4.3 (frozen) | same | Pass expected |
| 8414 | TASK-KERNEL v3.2.1 (2026-09-05) | later commits add companions and tests only | Pass expected for the kernel; to be confirmed by the first Sepolia run |
| 8419 | registries rev 5, bridge rev 6, verifier/adapter rev 4 | rev 6 sources | to be confirmed |
| 8434 | 2026-10-15 (solc-js 0.8.28) | R2.10 (documentation and vectors revised since) | Pass expected |
| 8436 | revision 3 (2026-10-15) | revision 3 | Pass expected |
| 8444 | v1.1 adoption (2026-10-16); adapters from v1.0 | v1.1 | Pass expected |
| 8447 | revision 2.1 + revision 2.2 decision adapter | v0.3.2 | to be confirmed |
| 8454 | 2026-10-21 | same contracts | Pass expected |
| 8468 | revision 7 (2026-10-27) | v0.8.2 = revision 7 | Pass expected |
| 8471 | **revision 3** (2026-10-29) | **revision 4** | Fail (known) for ADRFBindingModule, ADRFFilingModule, DuplicateSettlementVerifier, ADRFServiceEscrow |

"To be confirmed" rows become facts the first time `foga doctor --world worlds/sepolia.json --attach` runs against a Sepolia RPC; the report is then committed under `deployments/`.

## Three seams found while locking

1. **ERC-8444 agent kind on Sepolia is anchored to ARD's own fixture AIDRegistry** (`0x36E4a7BDe8a9D7d445042495180b64C7AF77Fd7E`, 30 d / 365 d liveness), not to aid-standard's reference instance (`0x01C05738eebD20DC80bBb9Fa1Ceb1165af8dA00F`). The registry owner is a session-held upstream key, so `registerKind` cannot be called again. Consequence for Phase 2c: cells bind in both AID registries on Sepolia; `worlds/sepolia.json` records both instances and carries a layer-4 expectation for the adapter. Suggested upstream change: let the agent adapter's identity registry be configured, or allow more than one adapter per kind.
2. **ERC-8447 eligibility modules other than Allowlist were never deployed** (and upstream tests them only against in-file mocks). FOGA deploys ERC8004Eligibility, IdentityStateEligibility and (in Phase 2, once a scheme exists) AssertionLevelEligibility and CompositeEligibility; there is no owner restriction on doing so.
3. **ERC-8471 revision 3 is deployed while revision 4 is the locked source.** FOGA deploys its own revision-4 ADRFServiceEscrow in Phase 2c and reports the registry mismatch as known until the upstream rev-4 run lands.

Known and non-blocking: the rev 1–5 deployer key of kya-standard is lost upstream (FOGA registers its own schemes); the ARD registry owner key is session-held (the four kinds are already registered); the vendored TaskToken fixtures in four repositories are byte-identical to task-token-standard HEAD although their READMEs cite three different commits (a documentation issue); the three `SignatureChecker.sol` copies differ (no runtime effect); schema `$id` conventions differ across repositories (the SDK will carry a schema map).

## ERC-8004 anchors

| Chain | Identity Registry | Reputation Registry | Validation Registry |
|---|---|---|---|
| Sepolia | `0x8004A818BFB912233c491871b3d84c89A494BD9e` (used by all upstream runs) | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | to be re-checked; upstream bound kya-standard's companion `ValidationRegistry8004` |
| Ethereum mainnet, Base and 23 other mainnets (CREATE2, same addresses) | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | `0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58` |

Local worlds deploy `Identity8004Stub` instead; it is labeled as a stub in every world file and must never be presented as the reference registry.
