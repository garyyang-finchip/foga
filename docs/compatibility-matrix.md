# Compatibility matrix

Compatibility is declared per ERC in three parts: the specification version FOGA follows, the role FOGA takes, and the run evidence that proves it. An interface that merely exists is never counted as a pass. Verdicts use the doctor's vocabulary: Pass / Fail / Unknown / Not tested / Not applicable.

Status key for the evidence column: **L1–L4** = doctor layers 1–4 pass on a locally deployed world (`deployments/local.doctor.example.json`); **L5** = semantic validation through the genesis scenario (`deployments/local.genesis.example.json`; T0–T3 in Phase 2a-1, the rest in later phases).

| ERC | Specification followed | FOGA role(s) | Minimum run acceptance (Phase 2 target) | Evidence today |
|---|---|---|---|---|
| 8338 Token-Bound Executable Skills | repository commit `359ad64` (Draft, PR #1879) | holder, executor, publisher of skill tokens | reads the on-chain commitment, verifies the full package before executing; a tampered file is rejected; publishing v2 does not move an existing v1 commitment | L1–L4 Pass; L5: T2 mint ×2 by the account, package verified against `skillOf` before T3's run, tampered package detected; v2 case Not tested |
| 8414 Token-Bound Task Tenders | commit `b3da62e` (Draft, PR #2005) | fulfiller; demander | creates and funds a real tender; submits; one machine settlement; repeated requests do not pay twice; a judged tender and the NoDecision default path | L1–L4 Pass; L5: T3 mint/fund/commit by B, submit/settle by A, paid once, second settlement and further submission refused, crash-and-resume does not resubmit; judged tender Not tested (T5) |
| 8419 KYA Framework | commit `f204f2e` (Draft, PR #2012) | subject; prover; issuer (world operator) | attested and two proved paths (credential-pattern, predicate-pattern) run; expiry, revocation, wrong binding and replay are rejected | L1–L4 Pass; L5: T0 schemes S_att and S_cred registered, T1 attested level 2 for three account subjects, `check` true; proved paths Not tested (2a-2, 2b) |
| 8434 Agent Identity | commit `1ff7215` (Draft, PR #2044) | anchor | ERC-8004 binding; ACTIVE / STALE / RETIRED transitions; document keeps provenance, validity and proof class; histories are not merged | L1–L4 Pass; L5: T1 bind/heartbeat/document by three accounts (ACTIVE), T2 document update with a skills facet; STALE/RETIRED Not tested (T7, T9) |
| 8436 ACDF | commit `f8204fb` (Draft, merged 2026-10-14) | consumer (through adapters); judges | a real 2-of-3 Final; enactment only after authorization check; NoDecision as a distinct outcome | L1–L4 Pass; L5 Not tested |
| 8444 ARD Onchain | commit `2641685` (Draft, merged 2026-10-15) | controller; discoverer | an external node finds a resource and checks descriptor and anchor; controller change and stale descriptors are detectable; adoption after transfer | L1–L4 Pass (four kinds registered and verified); L5: T1 agent records, T2 skill records, T3 task record, all `backed`; A discovers T3's task through its record; controller change Not tested (T9b) |
| 8447 Swarm AI | commit `de5bc29` (Draft, PR #2081) | member; coordinator; SwarmAccount operator | distinct identities accept one charter; roles take effect; a cooperative tender is completed; leave and inactivity handling | L1–L4 Pass; L5 Not tested |
| 8454 AUF | commit `1be1da6` (Draft, PR #2095) | definition controller; evaluator | cell and swarm units defined; income, gas and missing items recorded; realized net cash flow measured, never presented as value; no double counting | L1–L4 Pass; L5: T1 cell units ×3 and T2 skill units ×2 registered by the accounts; measurement Not tested (T8) |
| 8468 ASF | commit `a76071c` (Draft, PR #2113) | adopter; guardian; execution gate | out-of-scope actions rejected at the execution gate; suspension blocks; a second binding cannot bypass an effective stop | L1–L4 Pass; L5: T0 specification, T1 adoption by three accounts with G as intervener, `status()` Satisfied, gate exercised on every act; suspension and stop Not tested on chain (T7; covered by the account's Foundry tests) |
| 8471 ADRF | commit `cd5a3e0` (Draft, PR #2123) | party; obligation source (escrow); executor | file, evidence, judgment, ruling, enactment with report; repeated enactment rejected; a conforming delivery yields no breach | L1–L4 Pass; L5 Not tested |
| 8004 Trustless Agents | official registries (Draft) | registrant | register, agentURI, transfer; local stub and public instance always labeled apart | L1–L4 Pass against the local stub; L5: T1 `register(agentURI)` by three accounts against the stub; public instance Not tested from this repository yet |

## Interface identifiers

Computed from each interface's own function selectors in the compiled AST and compared with the identifiers the upstream repositories publish in their vectors (or README for 8338/8414). At the locked commits every published identifier matches the computed one; `artifacts/bundle.json` → `interfaceIds` holds the full table, including interfaces upstream publishes no id for (shims and helpers).

| ERC | Interface | Id |
|---|---|---|
| 8338 | ISkillToken / IOnchainSkillDocument | `0x734553a6` / `0x7050dd2c` |
| 8414 | ITaskToken / ITaskTender / ITaskVerifier / IOnchainTaskDocument | `0xcdaeb26d` / `0xc319d532` / `0x9977db15` / `0xeb078d05` |
| 8419 | IKYASchemeRegistry / IKYARegistry / IKYAPolicyRegistry / IKYAPolicyEvaluator / IKYAVerifier | `0xe6dbd933` / `0x5d1bec61` / `0x1cf9e558` / `0x173ff2b6` / `0xfc2b4271` |
| 8434 | IAIDRegistry | `0x72750a54` |
| 8436 | IACDFPolicyRegistry / IACDFRegistry | `0xb362eb4e` / `0xd31aae30` |
| 8444 | IARDOnchainRegistry / IARDKindAdapter | `0x881908a5` / `0x67bde273` |
| 8447 | ISwarmRegistry / IEligibility / ISwarmAccount / IResourceAdapter | `0x085203a4` / `0xd0ede3d8` / `0x25e98353` / `0x8e20b298` |
| 8454 | IAUFUnitRegistry / IAUFAssertionRegistry | `0x7128ef29` / `0x46ae6e24` |
| 8468 | IASFSpecificationRegistry / IASFBindingRegistry | `0x9bddde77` / `0xcff7f826` |
| 8471 | IADRFPolicyRegistry / IADRFDisputeRegistry / IADRFObligationSource / IADRFVerifier / IADRFEvidenceRule / IADRFJudgmentMethod | `0x4413df85` / `0xedc59c17` / `0xa52f2870` / `0xdfed0fe7` / `0x7ff3f359` / `0xc29a559d` |

Note that 8454 and 8468 derive ids without `supportsInterface`, while 8447 and 8471 include it; the computed values follow each repository's own declaration, which is what `type(I).interfaceId` yields.
