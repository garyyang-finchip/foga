# The genesis scenario (T0–T5 in Phase 2a)

The genesis is the run that proves the ten-ERC stack composes into a working agent: a world is set up, three cells are born, one of them acquires skills and earns a reward by doing verifiable work for another, the three organize into a swarm, and the swarm earns a reward on a tender judged by a council. Design memo section 4 defines ten phases, T0–T9; Phase 2a implements T0–T5 (2a-1: T0–T3; 2a-2: T4–T5, the credential-pattern ZK path and the council) and the recovery cases of loop C (memo section 5.2). T6–T9 follow in Phase 2b, the Sepolia run in Phase 2c.

Everything below runs on anvil with `foga demo --genesis T5` (fresh chain) or, against a deployed world, with `foga genesis run --world deployments/local.json --until T5`. The run is idempotent: a second invocation replays every recorded operation from the operation store and re-checks the end state without sending a transaction; an interrupted run is resumed by invoking it again (docs/kernel.md). The ZK path needs the proving material (`foga vendor sync`) and the proving libraries (`npm run zk:install`); `--zk auto` (the default) leaves it out with a notice when either is missing, `--zk require` insists on it (CI does), `--zk skip` leaves it out. The choice is recorded in the store on the first run and kept by later runs.

## Actors

| Signer | anvil account | Role |
|---|---|---|
| `W` | #0 | world operator: deploys the world, registers the KYA schemes and the ASF specification, issues the attested standing assertions, funds the cells on a local chain |
| `G` | #1 | guardian: the intervener with suspend and resume rights in every cell's binding |
| `owner.A/B/C` | #2 #3 #4 | cold principals: deploy and administer the accounts, adopt the bindings |
| `operator.A/B/C` | #5 #6 #7 | hot signers: act through `execute` |
| `E` | #8 | evaluator (Phase 2b); in T4 and T5 also the stranger: an account with no identity and no standing |
| `J1`, `J2`, `J3` | #9, #10, #11 | the judges of the FOGA-Council (J2 and J3 are beyond anvil's ten pre-funded accounts, so W funds them in T0) |

The cells are contract accounts (`FogaCellAccount`, docs/cell-account.md), not the signers: `A` is `0x663F…`, `B` is `0x057e…`, `C` is `0xbdEd…` on a fresh anvil world (deterministic: same keys, same nonces).

## T0 — world

Pre-condition: a deployed world (`foga world deploy`, 47 contracts, four ARD kinds). The genesis then registers, as `W`:

| Operation key | Call | Result fact |
|---|---|---|
| `T0.kya.S_att.register` | `KYASchemeRegistry.registerScheme` — attested, IDENTITY binding, ordered levels 0–3 ("none, known, bound, audited"), descriptor as a `data:` URI committed by keccak | `T0.kya.S_att.schemeId` |
| `T0.kya.adapter.deploy` | deploy `Groth16KYAVerifierAdapter(Groth16Verifier of the world, FOGA's issuer-set root, 30-day epochs, grace 1)` — FOGA's own instance of the upstream credential adapter, pinned to an issuer set of one attestor key held by W (derived from W's key; `T0.kya.issuerSet` records the root and the public key) | `T0.kya.adapter` |
| `T0.kya.S_cred.register` | `registerScheme` — proved, verifier = FOGA's adapter, levels 0–4 | `T0.kya.S_cred.schemeId` |
| `T0.asf.spec.register` | `ASFSpecificationRegistry.registerSpecification(salt, keccak(JCS(spec)), data: URI, [])` — the FOGA-Cell-v1 specification: commitment-class actions only while the anchor is ACTIVE, interventions honored at the gate, de-risking always open, attribution only through the account | `T0.asf.spec` (specId, version 1, contentHash) |
| `T0.fund.J1..J3` | 1 ETH each (local chains) | — |
| `T0.acdf.policy.register` | `ACDFPolicyRegistry.registerPolicy` — FOGA-Council: one ROSTER_KOFN body of J1–J3, k = 2, on-chain tally, window; one appeal of a Decided result within the appeal window (an appeal round that ends without a decision preserves the first); a NoDecision is final at once; hard cap = 2 windows + appeal window; descriptorHash = keccak(JCS(descriptor)) | `T0.acdf.policy` |
| `T0.acdf.tenderAdapter.deploy` | deploy `ACDFTaskTenderAdapter(ACDFRegistry, TaskToken, policyId, margin)` — FOGA's instance of the upstream adapter: the judged acceptance authority of T4/T5 | `T0.acdf.tenderAdapter` |

Checks: the pinned version's content hash equals `keccak(JCS(spec))`; both schemes exist; FOGA's adapter pins the issuer-set root; the policy exists; the tender adapter is bound to it and does not declare `ITaskVerifier` (a judged authority, never machine settlement).

Deferred from the memo's T0 to Phase 2b: the ADRF policy and FOGA's ADRFServiceEscrow (T6), the predicate scheme S_pred.

### Windows and margins

| | local chain (anvil) | other chains |
|---|---|---|
| council round window | 1 day | 180 s |
| appeal window | 1 hour | 60 s |
| workers' decision window | 1 day | 180 s |
| execution margin | 1 hour | 60 s |
| judgment window of the T4 tender | 7 days | 900 s |
| judgment window of the no-decision tender | 3 days | 900 s |

On anvil the kernel moves the clock past a window (`evm_increaseTime`; every skip is a journal entry and part of the evidence); elsewhere it waits.

## T1 — birth, for each of A, B, C

| # | Operation key | Who | Call |
|---|---|---|---|
| 1 | `T1.X.deploy` | owner | deploy `FogaCellAccount(safety = ASFBindingRegistry, owner, operator, guardian = G, recovery = owner, requirement)`; the requirement is one clause — FOGA-Cell-v1 version 1, adopter = the account, subjectKey = keccak(`eip155:<chain>:<account>`), scopeKey = keccak(JCS({ref})), enforcement account+contract, intervener G with suspend+resume — built from the address predicted for the deployment nonce |
| 2 | `T1.X.fund` | W | 0.05 ETH of working capital to the account (local chains only) |
| 3 | `T1.X.setOperator`, `T1.X.setAIDRegistry` | owner | operator scope (no expiry, 0.01 ETH per day), the AID registry for the commitment gate |
| 4 | `T1.X.class.*` ×5, `T1.X.derisk.*` ×3 | owner | commitment-class selectors (8414 submitFulfillment, 8447 join / applyToJoin, 8454 assertStatement, 8436 castBallot) and de-risk selectors (8414 withdrawCredit / reclaimEscrow, 8447 leave) |
| 5 | `T1.X.adopt` | owner | `adoptBinding(input, 0)`: the account adopts FOGA-Cell-v1 v1 with G as intervener (rights suspend+resume), params and authority documents as `data:` URIs; the binding is presented for clause 0 |
| 6 | `T1.X.8004.register` | operator via `execute` | `IdentityRegistry.register(agentURI)` with an ERC-8004 registration file; the NFT belongs to the account |
| 7 | `T1.X.aid.bind`, `T1.X.aid.heartbeat` | operator via `execute` | `AIDRegistry.bind(identityRegistry, agentId)` (the account owns the agent), `heartbeat()` |
| 8 | `T1.X.kya.attest` | W | `KYARegistry.attest({account, (chain, account)}, S_att, level 2, claimDigest, expiresAt = +365 d, evidence data: URI, claimDigest)` |
| 9 | `T1.X.aid.document` | operator via `execute` | `setDocumentURI(data: URI, keccak(JCS(document)))` — an `aid-document/v1` with a SELF identity facet (resolver erc8004-identity) and an ATTESTED standing facet (resolver erc8419-assertion citing the assertion) |
| 10 | `T1.X.ard.register` | operator via `execute` | `ARDOnchainRegistry.register(kind agent, target = account, id = 0, sha256(JCS(authored descriptor)), data: URI, urn)` — the AgentAdapter makes the anchor its own controller |
| 11 | `T1.X.auf.unit` | operator via `execute` | `AUFUnitRegistry.registerUnit(controller = account, keccak(JCS(definition)), data: URI, [])` — the cell's unit: agent element, treasury position, deliverable and funds ports |

| 12 (A only) | `T1.A.kya.attestWithProof` | operator via `execute` | the proved path (memo T1 ④): A derives a prover secret, hands its Poseidon commitment to W; W's attestor signs the scheme-bound credential (subject key, S_cred, level 4, claim digest, expiry, commitment) without seeing the secret; A proves membership of the credential's issuer in FOGA's set for this registry's `admissionDomain()` and the current epoch (Groth16, ~6 s), then `KYARegistry.attestWithProof(subject, S_cred, publicInputs, proof, evidence data: URI)`; the adapter is the issuer of record. The proving runs in `prover/run.cjs`, a bridge over the upstream prover (docs/kernel.md) |

Checks per cell (memo "expected"): `state(anchor) == ACTIVE`; `check({account, anchor}, S_att, 2, [W]) == true`; `status()` Satisfied; the ARD record `backed`; the unit's controller is the account; the ERC-8004 agent's owner is the account; `requirementId()` equals `keccak(abi.encode(requirement))` computed off-chain; `computeBindingId(account, input)` equals the adopted id. For A's proof: `check({account, A}, S_cred, 4, [adapter]) == true`; the nullifier is spent; the same proof again reverts (`KYA_NullifierUsed`); the proof presented for another subject reverts (`KYA_SubjectMismatch`); a proof for epoch `current - 2` reverts (`EpochOutOfWindow`). The proof and the credential are facts, so a resumed run reuses them rather than proving again.

One ordering differs from the memo's list: the binding is adopted before the ERC-8004 registration. The account executes nothing before a binding is presented (there is no privileged path), so adoption is the first act after deployment; the memo's order (register, bind, then adopt) assumed an ungated bootstrap that the account deliberately does not have.

## T2 — capability (A)

Two real ERC-8338 packages live in `scenarios/skills/`: `foga-probe` (the deterministic ten-ERC probe of one address at one block — the "known answer" source of T3) and `finch-extract-verify` (structured extraction plus consistency check over a pinned document — the first business task, judged in later phases). They are packed with the DAG-CBOR rules of the upstream `pack.py` (`src/core/pack/`, byte-exact against the upstream vectors).

| Operation key | Who | Call |
|---|---|---|
| `T2.A.skill.<name>.mint` | A via `execute` | `SkillToken.mintSkill(to = A, updateAuthority = A, mdHash, packageHash, packageURI)` |
| `T2.A.skill.<name>.ard` | A via `execute` | `register(kind skill, target = SkillToken, id = tokenId, …)` — the SkillAdapter makes the token owner the controller |
| `T2.A.skill.<name>.unit` | A via `execute` | the skill's unit (source element, calls-out and fees-in ports, controller A) |
| `T2.A.aid.document` | A via `execute` | the document gains an `aid:skills/erc8338/v1` facet listing the tokens |

Checks: `skillOf(tokenId)` equals the local package (mdHash, packageHash, version 1); the owner is A; the skill records are `backed` (the adapter reads the package hash); appending one byte to `SKILL.md` changes both hashes (the tampered-package case); the on-chain document digest equals the kernel's latest commitment before and after the update.

## T3 — labour (machine acceptance)

B, as demander, tenders "the `foga-probe` report of cell C at block N" and commits the answer's hash; A, as fulfiller, discovers the task through ARD, checks itself, runs the skill in isolation, submits, settles and is paid. Block N is fixed once (`T3.block`) and the answer is `JCS(report)`, where the report reads every registry at block N and includes the block hash.

| Operation key | Who | Call |
|---|---|---|
| `T3.B.mint` | B via `execute` | `TaskToken.mintTask(to = B, updateAuthority = B, acceptanceAuthority = HashlockVerifier, tdHash, taskHash = sha256(task document), taskURI = data: URI, terms{ETH, 0.001 per completion, max 1, submitBy, settleBy, judgmentWindow 7 d})` |
| `T3.B.fund` | B via `execute` (value 0.001 ETH) | `fundTask(tokenId, 0.001 ETH)` — within the operator's daily cap |
| `T3.B.commit` | B via `execute` | `HashlockVerifier.commitAnswer(TaskToken, tokenId, sha256(answer))` — B is the update authority |
| `T3.B.ard` | B via `execute` | the task record (kind task; the TaskAdapter's controller is the token owner) |
| — | A (kernel) | discovery: read the record, decode the descriptor and the task document (skill, packageHash, subject, block, acceptance); pre-check: anchor ACTIVE, safety Satisfied, operator gas above the floor, escrow covers the reward, deadlines open, not cancelled; verify the local `foga-probe` directory against the token's commitment and the task's `packageHash`; run the probe in a child process with no keys; `sha256(answer)` must equal the committed hash |
| `T3.A.submit` | A via `execute` | `submitFulfillment(tokenId, resultHash = sha256(answer ‖ A), resultURI = run receipt as data: URI)` — commitment-class, so the AID gate applies |
| `T3.A.settle` | A via `execute` | `settleFulfillment(tokenId, submissionId, proof = answer)` — anyone may settle a verifier-judged tender; the vault pays A directly |
| `T3.A.withdraw` | A via `execute` | only if the settlement credited instead of paying (it does not when the account can receive, which it can) |

Checks: the submission is `Accepted` with `machineSettled` and fulfiller A; A's balance rose by exactly the reward; `submissionCountOf == 1`; the escrow is spent; `verifyFulfillment` with A's `resultHash` is true for A and false for any other fulfiller (the proof cannot be copied); settling with a wrong proof reverts `TaskToken: verification failed`; a second settlement and a further submission are refused (max completions reached).

The run receipt (`foga.run-receipt/1`: skill, package hash, token, input, answer hash, fulfiller, worker) is the `resultURI` and is kept as a fact.

## T4 — organization

The swarm's objective binds to the tender it will fulfil, so the judged tender comes first (the memo lists its minting under T5).

| Operation key | Who | Call |
|---|---|---|
| `T4.D.mint`, `T4.D.fund`, `T4.D.ard` | W as demander | `mintTask(to = W, updateAuthority = W, acceptanceAuthority = ACDFTaskTenderAdapter, …, terms{0.002 ETH, max 1, settleBy +14 d, judgmentWindow})`, `fundTask`, the ARD task record (the TaskAdapter's controller is the token owner, W) |
| `T4.deploy.assertionLevel`, `T4.deploy.composite` | W | `AssertionLevelEligibility(KYARegistry, S_att, 2, [W])`; `CompositeEligibility([ERC8004Eligibility, IdentityStateEligibility, AssertionLevelEligibility], requireAll)` — the first two were deployed with the world, the third needs a scheme id |
| `T4.X.declareAgent` ×3 | each cell via `execute` | `ERC8004Eligibility.declareAgent(agentId)` — a seat is bound to an identity the account controls |
| `T4.deploy.decisionAdapter` | W | `SwarmDecisionAdapter(SwarmRegistry, ACDFRegistry, decidingRole = worker, 2 of 2, window, margin)` |
| `T4.B.form` | B via `execute` | `form(spec, charterHash, commitmentHash, charterURI, 0, origin{task, keccak(chain, TaskToken, tokenId)}, objective{TERMINAL, acceptanceAuthority = SwarmTenderAdapter, obligation = (chain, TaskToken, tokenId)})`. Roles: `sai.role.coordinator` (1 seat) and `sai.role.worker` (2 required, 3 seats), both self-join under the composite eligibility. Authorities: AMEND = the decision adapter; REPRESENT = the coordinator role; ACTIVATE by roster; ADVANCE and SUCCEED none; everything else the initiator (B). One OPEN RECRUIT phase (shared payoff, partitioned topology, collective coordination); recruitment window 7 d, max duration 30 d, ineligible grace 1 d, settlement window 7 d, amendment exit window 1 d. The Swarm Pack (schema `swarm-pack.schema.json`) is the charter: `charterHash = SHA-256(JCS(pack))`, `objectiveHash`, `commitmentHash` over its members (byte-exact against the upstream vectors, `test/swarm.test.ts`); `specHash = keccak256(abi.encode(spec))` |
| `T4.B.join`, `T4.A.join`, `T4.C.join` | via `execute` (commitment-class: the AID gate applies) | `join(swarmId, role, charterHash)` — admission completes only if the composite module says so |
| `T4.activate` | anyone (W) | `activate` once the roster is met |
| `T4.deploy.swarmAccount`, `T4.B.setAccount`, `T4.B.class.swarmAccount.execute` | W; B via `execute`; owner of B | `SwarmAccount(SwarmRegistry, swarmId, recovery = B)`; `setAccount`; B's owner marks `SwarmAccount.execute` commitment-class (representing the swarm while not ACTIVE is refused at B's gate) |
| `T4.B.unit` | B via `execute` | the swarm's AUF unit: controller B, elements the swarm account, `contains = [A@v1, B@v1, C@v1]` |
| `T4.W.revoke.C`, `T4.challenge.C.suspend`, `T4.W.reattest.C`, `T4.challenge.C.reinstate` | W; anyone (W) | the memo's failure case: W revokes C's S_att assertion; `challenge(swarm, C)` suspends C (INELIGIBLE) and the roster is no longer met; a fresh assertion and a second `challenge` reinstate C. The challenge calls carry an explicit gas limit: the registry treats a module's `false` with too little gas left as unevaluable (its anti-starvation rule), and an estimate stops at that first non-reverting path |

Checks: the tender's acceptance authority is the adapter and its escrow the reward; the composite module says yes for A, B, C and no for a stranger (E); the on-chain `specHash` equals the one computed off-chain; `rosterMet` after three joins; A, B, C ACTIVE; the swarm ACTIVE with the account bound and B as initiator; `isAuthorized(REPRESENT)` true for B and false for A; the unit contains the three member units at version 1; E's `join` as worker reverts `SAI_Ineligible`; the suspension and the reinstatement.

Deviation from the memo: the memo's "2-of-3 members" governance vote is realized as 2 of 2 workers, because the upstream decision adapter takes its roster from one deciding role; the coordinator proposes and may not vote.

## T5 — governance

| Operation key | Who | Call |
|---|---|---|
| `T5.swarm.submit` | B via `execute` → `SwarmAccount.execute` → `TaskToken.submitFulfillment(tokenId, resultHash, resultURI)` | the deliverable is the `finch-extract-verify` report over `scenarios/fixtures/sample-filing.txt` produced by the skill's deterministic path (`src/genesis/extract.ts`: line-label extraction, the field list's consistency rules, evidence quotes); `resultHash = sha256(JCS(report))`; the fulfiller of record is the swarm account, not a member |
| `T5.open` | anyone (W) | `ACDFTaskTenderAdapter.open(tokenId, submissionId)` files the council's case (CONSUMER_FILED, consumer = the adapter, deadline inside the judgment window minus the margin) |
| `T5.J1.ballot`, `T5.J2.ballot` | J1, J2 | `castBallot(issueId, round, body 0, approve)` — two approvals decide |
| `T5.settleRound`, `T5.finalize` | anyone (W) | `settleRound` → Provisional (a Decided result may be appealed); after the appeal window → `finalize` → Final Decided Yes |
| `T5.execute` | anyone (W) | `ACDFTaskTenderAdapter.execute(issueId)` → `acceptFulfillment` → the vault pays the swarm account 0.002 ETH; the enactment is recorded |
| `T5.gov.open` | B via `execute` | `SwarmDecisionAdapter.open(swarmId, AMEND, amend(swarmId, charterHash v2, URI v2, 0, 0, false), roster = [A, C])` — the adapter registers a policy version with the two workers as roster and files the proposal |
| `T5.gov.A.ballot`, `T5.gov.C.ballot`, `T5.gov.settle`, `T5.gov.execute` | A and C via `execute` (commitment-class); anyone | the workers approve; the round settles Final at once (no appeal in the adapter's policy); `execute` performs `amend` as the AMEND authority: charter version 2, commitment version unchanged (not material) |
| `T5.nd.mint`, `T5.nd.fund`, `T5.nd.submit`, `T5.nd.open`, `T5.nd.J1.ballot`, `T5.nd.settleRound` | W; B via `execute`; J1 | the no-decision path: a second judged tender (0.001 ETH, judgment window 3 d), the swarm account submits, the case opens, one judge approves, the window passes → `settleRound` → Final NoDecision (QUORUM_NOT_MET); the adapter enacts nothing |
| `T5.nd.claimUnjudged` | anyone (W) | after the judgment window, `TaskToken.claimUnjudged(tokenId, submissionId)` pays the fulfiller: silence is the kernel's own default |
| `T5.swarmTender.settle` | anyone (W) | `SwarmTenderAdapter.settle(swarmId, submissionId)` → the swarm concludes ACHIEVED with the report's hash |

Checks: the judges are nobody's party (not the demander, a member, the swarm account or an operator); the submission's fulfiller is the swarm account on the judged path; a worker driving the swarm account reverts (`SwarmAccount_NotRepresentative`); a ballot for the wrong round, a ballot by a non-judge and `execute` before Final revert; the result is Final Decided Yes from round 1; the submission is Accepted and the enactment Enacted; the swarm account received exactly 0.002 ETH and the members nothing; `execute` again reverts; the coordinator cannot vote on the workers' decision; the charter is version 2 with commitment version 1; the proposal is enacted; the second case ends Final NoDecision (QUORUM_NOT_MET), `execute` is inert, `claimUnjudged` pays after the window; the swarm is CONCLUDING / ACHIEVED with the report's hash.

Deviation from the memo: the settlement pays the swarm account directly (the account can receive), so no `withdrawCredit` follows.

## Loop C — crashes and resumption

| Case | How to reproduce | Expected, and what CI asserts |
|---|---|---|
| killed after submit, before settle | `foga genesis run … --until T5 --crash-after T3.A.submit` (exit 75), then `foga genesis run … --until T5` | the second run recovers the receipt of `T3.A.submit` by hash and does not re-send; it settles and carries on to T5; `submissionCountOf == 1`; evidence `recovered: 1`. The same holds at any key, for instance `--crash-after T5.swarm.submit` |
| intent recorded, never broadcast | `--crash-before T3.A.settle`, then run again | the hash is unknown to the node and the nonce is free: re-sent with the same nonce (`resent: 1`) |
| the same request twice | run a completed scenario again | every operation replayed from the store, nothing sent (`sent: 0`), all end-state checks pass |
| the chain was reset under the store | restart anvil, redeploy, run with the old store | refused: block 0 differs from the one the store recorded |
| RPC timeout after broadcast | (the recovery path above covers it: hash and nonce are consulted before any retry) | — |

`foga genesis status --world <world>` lists the store's rows with status, signer, nonce and hash.

## Operation count and evidence

A complete T0–T5 run is 125 operations (9 in T0, 20 per cell plus A's proof in T1, 7 in T2, 6 in T3, 22 in T4, 20 in T5) and 89 checks, about 40 s on anvil including two Groth16 proofs. The evidence file `deployments/<world>.genesis.json` holds the checks, the facts, per-step evidence (addresses, ids, hashes, transaction hashes, run receipts, results of the deliberations), the operation summary of the store and the run's journal (time skips included); `deployments/local.genesis.example.json` is a committed example.

## Not in this phase

- T6–T9, the predicate circuit (`S_pred`), doctor layer 5 and the AUF measurement receipt — 2b.
- The Sepolia run — 2c (the keys come from `FOGA_KEY_<ROLE>`; the judges and the cells' operators must be funded there; the AgentAdapter seam documented in docs/version-lock.md means cells bind in both AID registries; the short windows of the public timing profile apply).
