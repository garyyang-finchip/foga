# The genesis scenario (T0–T9)

The genesis is the run that proves the ten-ERC stack composes into a working agent: a world is set up, three cells are born, one of them acquires skills and earns a reward by doing verifiable work for another, the three organize into a swarm, the swarm earns a reward on a tender judged by a council, a service call between cells ends in a dispute whose ruling the escrow enacts, a guardian stops a cell at its execution gate, an independent measurer records what the cells realized, and an identity moves to a new body. Design memo section 4 defines ten phases, T0–T9; Phase 2a implemented T0–T5 (2a-1: T0–T3; 2a-2: T4–T5, the credential-pattern ZK path and the council), Phase 2b adds T6–T9, the predicate-pattern ZK path (`S_pred`), the measurement receipts and the doctor's fifth layer. Phase 2c ran the same scenario on a public chain (Sepolia, 2026-11-01): the section "Running on a public chain" below says what differs, which is less than it looks, and what the run showed.

Everything below runs on anvil with `foga demo --genesis T9` (fresh chain) or, against a deployed world, with `foga genesis run --world deployments/local.json --until T9`. The run is idempotent: a second invocation replays every recorded operation from the operation store and re-checks the end state without sending a transaction; an interrupted run is resumed by invoking it again (docs/kernel.md). Checks that cannot be remade on a replayed run (the state of a suspension that has since been lifted) are recorded as skipped with the reason, never as passed.

Two ZK paths need proving material. The credential path (`S_cred`) needs the upstream material (`foga vendor sync`) and the proving libraries (`npm run zk:install`); the predicate path (`S_pred`) needs FOGA's own circuit built with `npm run zk:predicate` (10–60 minutes once; docs/zk.md). `--zk auto` (the default) leaves out whichever path lacks its material, with a notice; `--zk require` insists on both (CI does); `--zk skip` leaves both out. The choices are recorded in the store on the first run and kept by later runs.

## Actors

| Signer | account | Role |
|---|---|---|
| `W` | #0 | world operator: deploys the world, registers the KYA schemes and the ASF specification, issues the attested standing assertions; the treasury: funds the other roles to their floors and the cells with their capital |
| `G` | #1 | guardian: the intervener with suspend and resume rights in every cell's binding |
| `owner.A/B/C` | #2 #3 #4 | cold principals: deploy and administer the accounts, adopt the bindings |
| `operator.A/B/C` | #5 #6 #7 | hot signers: act through `execute` |
| `E` | #8 | the measurer of T8 (registers the method, asserts the receipts); in T4 and T5 also the stranger: an account with no identity and no standing |
| `J1`, `J2`, `J3` | #9, #10, #11 | the judges of the FOGA-Council |

The twelve keys are the first twelve accounts of one BIP-39 phrase (role i at `m/44'/60'/0'/0/i`). On anvil the phrase is anvil's well-known one, so a fresh local world always has the same addresses; on any other chain it is the phrase in `FOGA_MNEMONIC` or in the file `FOGA_MNEMONIC_FILE` names (`foga keys new` writes one, `foga keys show` lists the addresses), and `FOGA_KEY_<ROLE>` overrides one role (`FOGA_KEY_W` to make an account that already holds the chain's ether the treasury, for instance). anvil pre-funds its first ten accounts; J2 and J3 are beyond them, so W funds the judges in T0 there — the same funding step that, on a public chain, funds every role (below).

The cells are contract accounts (`FogaCellAccount`, docs/cell-account.md), not the signers: `A` is `0x663F…`, `B` is `0x057e…`, `C` is `0xbdEd…` on a fresh anvil world (deterministic: same keys, same nonces).

## T0 — world

Pre-condition: a deployed world (`foga world deploy`, 47 contracts, four ARD kinds). The genesis then registers, as `W`:

| Operation key | Call | Result fact |
|---|---|---|
| `T0.kya.S_att.register` | `KYASchemeRegistry.registerScheme` — attested, IDENTITY binding, ordered levels 0–3 ("none, known, bound, audited"), descriptor as a `data:` URI committed by keccak | `T0.kya.S_att.schemeId` |
| `T0.kya.adapter.deploy` | deploy `Groth16KYAVerifierAdapter(Groth16Verifier of the world, FOGA's issuer-set root, 30-day epochs, grace 1)` — FOGA's own instance of the upstream credential adapter, pinned to an issuer set of one attestor key held by W (derived from W's key; `T0.kya.issuerSet` records the root and the public key) | `T0.kya.adapter` |
| `T0.kya.S_cred.register` | `registerScheme` — proved, verifier = FOGA's adapter, levels 0–4 | `T0.kya.S_cred.schemeId` |
| `T0.kya.predicate.verifier.deploy`, `T0.kya.predicate.adapter.deploy` | deploy `Groth16PredicateVerifier` (generated from FOGA's circuit `kya_predicate_count_v1`, docs/zk.md) and `Groth16PredicateKYAVerifierAdapter(verifier, source-set root, 30-day epochs, grace 1, validity 30 d)` — FOGA's own IKYAVerifier for the predicate pattern, pinned to a source set of one key held by W (the node that indexes task completions; `T0.kya.sourceSet` records the root and the public key). Both are deployed on every machine; the proving material is needed only to prove (T3) | `T0.kya.S_pred` |
| `T0.kya.S_pred.register` | `registerScheme` — proved, verifier = the predicate adapter, levels 0–1 ("not shown", "shown"): the rule "at least K accepted task completions about the subject inside [t0, t1], signed by a source of the set" | `T0.kya.S_pred.schemeId` |
| `T0.asf.spec.register` | `ASFSpecificationRegistry.registerSpecification(salt, keccak(JCS(spec)), data: URI, [])` — the FOGA-Cell-v1 specification: commitment-class actions only while the anchor is ACTIVE, interventions honored at the gate, de-risking always open, attribution only through the account | `T0.asf.spec` (specId, version 1, contentHash) |
| `T<n>.fund.<role>` | before every step, W tops up each role whose balance has fallen below half its floor (on anvil: 1 ETH for J1–J3 in T0; on a public chain: every role, see "Running on a public chain") | `T<n>.fund.price`, `T<n>.fund.<role>.amount` |
| `T0.acdf.policy.register` | `ACDFPolicyRegistry.registerPolicy` — FOGA-Council: one ROSTER_KOFN body of J1–J3, k = 2, on-chain tally, window; one appeal of a Decided result within the appeal window (an appeal round that ends without a decision preserves the first); a NoDecision is final at once; hard cap = 2 windows + appeal window; descriptorHash = keccak(JCS(descriptor)) | `T0.acdf.policy` |
| `T0.acdf.tenderAdapter.deploy` | deploy `ACDFTaskTenderAdapter(ACDFRegistry, TaskToken, policyId, margin)` — FOGA's instance of the upstream adapter: the judged acceptance authority of T4/T5 | `T0.acdf.tenderAdapter` |
| `T0.adrf.policy.register` | `ADRFPolicyRegistry.registerPolicy` — FOGA-Service-v1: (result, FORMAL) → the upstream `DeclaredVersionVerifier` over the world's `ADRFServiceEscrow`; (result, JUDGED) → the `ADRFACDFBridge` with FOGA-Council as parameters, burden NO_DECISION; one substantive effect, the escrow's refund; standing = the parties of a call; windows below (the decision window must hold the council's whole procedure, which the policy registry verifies) | `T0.adrf` |
| `T0.adrf.escrow.bind` | `ADRFServiceEscrow.bindTo(input)` by its admin W — all the escrow's calls, PRE_COMMIT, refund authorized, the escrow itself the executor; the binding document is a `data:` URI committed by hash | `T0.adrf.bindingId` |

Checks: the pinned version's content hash equals `keccak(JCS(spec))`; the three schemes exist; FOGA's credential adapter pins the issuer-set root and the predicate adapter the source-set root; the policy exists; the tender adapter is bound to it and does not declare `ITaskVerifier` (a judged authority, never machine settlement); the service policy exists and the escrow is bound to it. The genesis refuses to run when the world's escrow is not administered by W (the escrow must be deployed by W: on a public chain `foga world deploy` deploys it with W as deployer).

### Windows and margins

| | local chain (anvil) | other chains |
|---|---|---|
| council round window | 1 day | 180 s |
| appeal window | 1 hour | 60 s |
| workers' decision window | 1 day | 180 s |
| execution margin | 1 hour | 60 s |
| judgment window of the T4 tender | 7 days | 900 s |
| judgment window of the no-decision tender | 3 days | 600 s |
| service dispute: filing window | 7 days | 1800 s |
| service dispute: evidence window / decision window | 1 day / 3 days | 180 s / 600 s |
| service dispute: review window (one review) / enactment margin | 1 day / 1 day | 120 s / 120 s |
| service dispute: hard cap (decision + review + decision) | 7 days | 1320 s |
| escrow dispute period (how long a charge is held) | 10 days | 1800 s |
| AID liveness window (world parameter; T7 shortens A's to 120 s for the demonstration and restores it) | 90 days | 90 days (30 days in Sepolia's backing registry) |

The relations the registries enforce hold in both columns: the service policy's decision window holds the council's whole procedure (2 x window + appeal = 420 s), and a call's dispute period outlasts the service track's hard cap plus its enactment margin (1320 + 120 = 1440 s < 1800 s) so a ruling can still be enacted on the held charge. On anvil the kernel moves the clock past a window (`evm_increaseTime`; every skip is a journal entry and part of the evidence); elsewhere it waits (about fifty minutes in all over T5–T7).

## T1 — birth, for each of A, B, C

| # | Operation key | Who | Call |
|---|---|---|---|
| 1 | `T1.X.deploy` | owner | deploy `FogaCellAccount(safety = ASFBindingRegistry, owner, operator, guardian = G, recovery = owner, requirement)`; the requirement is one clause — FOGA-Cell-v1 version 1, adopter = the account, subjectKey = keccak(`eip155:<chain>:<account>`), scopeKey = keccak(JCS({ref})), enforcement account+contract, intervener G with suspend+resume — built from the address predicted for the deployment nonce |
| 2 | `T1.X.fund` | W | working capital to the account: 0.05 ETH on anvil, 0.01 ETH on a public chain (what a cell funds and deposits over the run is about 0.005 ETH) |
| 3 | `T1.X.setOperator`, `T1.X.scope`, `T1.X.setAIDRegistry` | owner | operator scope: the key (no expiry, 0.01 ETH per day), then the allow-list in one `setOperatorAllowedBatch` — the (target, selector) pairs of the groups the cell plays (`src/genesis/operator-scope.ts`: A identity + standing + skills-provider + labour + organization-member + service-provider, B identity + demander + organization-coordinator + organization-member, C identity + organization-member + service-client; the backing AID registry mirrors the primary one's entries), recorded as the fact `T1.X.scope`; the AID registry for the commitment gate. The account is revision 2 (docs/cell-account.md): a call outside the list reverts with `OperatorNotAllowed`, an asset-moving selector with `OperatorAssetSelector`, so the scope is checked by the run itself |
| 4 | `T1.X.class.*` ×5, `T1.X.derisk.*` ×4 | owner | commitment-class selectors (8414 submitFulfillment, 8447 join / applyToJoin, 8454 assertStatement, 8436 castBallot) and de-risk selectors (8414 withdrawCredit / reclaimEscrow, 8447 leave, 8471 ADRFServiceEscrow.withdrawBalance) |
| 5 | `T1.X.adopt` | owner | `adoptBinding(input, 0)`: the account adopts FOGA-Cell-v1 v1 with G as intervener (rights suspend+resume), params and authority documents as `data:` URIs; the binding is presented for clause 0 |
| 6 | `T1.X.8004.register` | operator via `execute` | `IdentityRegistry.register(agentURI)` with an ERC-8004 registration file; the NFT belongs to the account |
| 7 | `T1.X.aid.bind`, `T1.X.aid.heartbeat` (and `T1.X.aid.backing.bind` where the world has a backing registry) | operator via `execute` | `AIDRegistry.bind(identityRegistry, agentId)` (the account owns the agent), `heartbeat()`; the same `bind` in the backing registry (below) |
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

### The predicate-pattern proof (`S_pred`, end of T3)

Right after its first accepted completion A proves a fact about its record under the predicate scheme (ERC-8419 section 5: the scheme is the decision rule, the prover evaluates it over data authenticated by a source). The memo places this proof at birth; it is made here because the records must exist first.

| Operation key | Who | Call |
|---|---|---|
| — (`T3.A.kya.S_pred.record`) | the source (W's node) | signs one task-completion record about A with its EdDSA key: `(subjectKey, taskRef = top 128 bits of keccak(chainId, TaskToken, tokenId, submissionId), status 1 = Accepted, timestamp = the settlement's block time)`. The record never goes on chain |
| — (`T3.A.kya.S_pred.rule`) | the relying party (the genesis, for the registry) | the rule's parameters: a challenge binding the request, the window `[now − 30 d, now]`, K = 1 |
| — (`T3.A.kya.S_pred.proof.k1`) | A (prover) | Groth16 proof over `kya_predicate_count_v1` (8 record slots, source-set depth 16): the source is in the committed set, each present record is signed by it and about A, records are distinct (strictly increasing `taskRef`), the count of Accepted records inside the window reaches K; outputs `result = 1` and the nullifier `Poseidon(secret, schemeId, admissionDomain, epoch, challenge)`. Verified locally against the committed verification key before it is sent |
| `T3.A.kya.attestWithProof` | A via `execute` | `KYARegistry.attestWithProof(subject A, S_pred, publicInputs, proof, evidence)`; the adapter maps the proof to level 1, `claimDigest = keccak(challenge, t0, t1, k, sourceSetRoot)`, `expiresAt = now + 30 d`, `anchor = sourceSetRoot` |

Checks: the prover counts 1 accepted completion and the proof verifies locally; `check({account, A}, S_pred, 1, [adapter]) == true`; the assertion's anchor is the source-set root and its claim digest commits to the rule; the nullifier is spent; the same proof again, the proof for another subject and the proof under `S_cred` revert; a proof for K = 2 (one completion) has `result = 0` and the adapter refuses it (`PredicateNotSatisfied`: a false predicate is rejected, not recorded); the same proof with the result byte set to 1 outside the circuit fails verification (`KYA_VerifierRejected`); a proof for epoch `current − 2` reverts (`EpochOutOfWindow`). Three proofs, each a few seconds to a minute depending on the machine; all are facts, so a resumed run reuses them.

When the predicate material is absent (`T0.zk.predicate = off`) these checks are recorded as skipped and the scheme stays registered with its adapter.

## T4 — organization

The swarm's objective binds to the tender it will fulfil, so the judged tender comes first (the memo lists its minting under T5).

| Operation key | Who | Call |
|---|---|---|
| `T4.D.mint`, `T4.D.fund`, `T4.D.ard` | W as demander | `mintTask(to = W, updateAuthority = W, acceptanceAuthority = ACDFTaskTenderAdapter, …, terms{0.002 ETH, max 1, settleBy +14 d, judgmentWindow})`, `fundTask`, the ARD task record (the TaskAdapter's controller is the token owner, W) |
| `T4.deploy.assertionLevel`, `T4.deploy.composite` | W | `AssertionLevelEligibility(KYARegistry, S_att, 2, [W])`; `CompositeEligibility([ERC8004Eligibility, IdentityStateEligibility, AssertionLevelEligibility], requireAll)` — the first two were deployed with the world, the third needs a scheme id |
| `T4.X.declareAgent` ×3 | each cell via `execute` | `ERC8004Eligibility.declareAgent(agentId)` — a seat is bound to an identity the account controls |
| `T4.deploy.decisionAdapter`, `T4.B.scope.decisionAdapter.open` | W; owner of B | `SwarmDecisionAdapter(SwarmRegistry, ACDFRegistry, decidingRole = worker, 2 of 2, window, margin)`; B's owner opens `SwarmDecisionAdapter.open` to B's operator (the adapter exists only now, so it is not in T1's list) |
| `T4.B.form` | B via `execute` | `form(spec, charterHash, commitmentHash, charterURI, 0, origin{task, keccak(chain, TaskToken, tokenId)}, objective{TERMINAL, acceptanceAuthority = SwarmTenderAdapter, obligation = (chain, TaskToken, tokenId)})`. Roles: `sai.role.coordinator` (1 seat) and `sai.role.worker` (2 required, 3 seats), both self-join under the composite eligibility. Authorities: AMEND = the decision adapter; REPRESENT = the coordinator role; ACTIVATE by roster; ADVANCE and SUCCEED none; everything else the initiator (B). One OPEN RECRUIT phase (shared payoff, partitioned topology, collective coordination); recruitment window 7 d, max duration 30 d, ineligible grace 1 d, settlement window 7 d, amendment exit window 1 d. The Swarm Pack (schema `swarm-pack.schema.json`) is the charter: `charterHash = SHA-256(JCS(pack))`, `objectiveHash`, `commitmentHash` over its members (byte-exact against the upstream vectors, `test/swarm.test.ts`); `specHash = keccak256(abi.encode(spec))` |
| `T4.B.join`, `T4.A.join`, `T4.C.join` | via `execute` (commitment-class: the AID gate applies) | `join(swarmId, role, charterHash)` — admission completes only if the composite module says so |
| `T4.activate` | anyone (W) | `activate` once the roster is met |
| `T4.deploy.swarmAccount`, `T4.B.setAccount`, `T4.B.scope.swarmAccount.execute`, `T4.B.class.swarmAccount.execute` | W; B via `execute`; owner of B | `SwarmAccount(SwarmRegistry, swarmId, recovery = B)`; `setAccount`; B's owner opens `SwarmAccount.execute` to B's operator and marks it commitment-class (representing the swarm while not ACTIVE is refused at B's gate) |
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

## T6 — dispute (ERC-8471 through the world's service escrow)

A service call between cells goes through the world's `ADRFServiceEscrow` (the upstream worked example, bound in T0 to FOGA-Service-v1). The call's terms commit the provider to a skill version; the provider delivers another one; the client disputes; FOGA-Council judges through the bridge; the escrow enacts the refund within its own authority.

| Operation key | Who | Call |
|---|---|---|
| `T6.C.escrow.deposit` | C via `execute` (value 0.002 ETH) | `deposit()` |
| `T6.C.call1.open` | C via `execute` | `openCall(provider = A, 0.0005 ETH, termsHash = keccak(JCS(terms)), committedVersion = packageHash of finch-extract-verify v1, disputePeriod)` |
| `T6.A.skill.v2.update` | A via `execute` | `SkillToken.updateSkill(tokenId, mdHash v2, packageHash v2)` — version 2 of the package (manifest 1.1.0 and a changelog note), `prev` = v1 |
| `T6.A.call1.deliver`, `T6.A.call1.settle` | A via `execute` | `deliver(callId, declaredVersion = packageHash v2)`, `settle(callId)` — the charge is held for the dispute period |
| `T6.C.call1.file` | C via `execute` | `ADRFDisputeRegistry.file(bindingId, claim)`: object = `objectOf(callId)`, event = the delivery, norm = the terms, clause "the service runs the committed version", respondent A, effect on sustained = refund, fallback = status quo, document hash of the eight-element case document; sub-question 0 FORMAL "the declared version differs from the committed one" (the verifier's canonical proposition, inputs `abi.encode(callId)`), sub-question 1 JUDGED "the version actually used matches the committed version" (decisive; the claim is sustained when FALSE). PRE_COMMIT: admitted at once |
| `T6.call1.resolveFormal` | anyone (W) | `resolveFormal(caseId, 0, abi.encode(callId))` → TRUE, COMPUTED by the `DeclaredVersionVerifier` over the escrow's `versionsOf` |
| `T6.call1.openJudgment` | anyone (W) | `openJudgment(caseId, 1)` → the bridge files the council's issue (CONSUMER_FILED, consumer = the bridge, deadline = the case's decision deadline) |
| `T6.call1.J1.ballot`, `T6.call1.J2.ballot`, `T6.call1.acdf.settleRound`, `T6.call1.acdf.finalize` | J1, J2; anyone | two judges hold the proposition FALSE (the run receipt and the token's commitments show v2 ran, the terms said v1); the round settles, the appeal window passes, the council's result is Final Decided No |
| `T6.call1.import` | anyone (W) | `ADRFACDFBridge.importResult(caseId, 1)` → the finding FALSE, JUDGED, with the council's provenance (registry, issue, policy, round) |
| `T6.call1.decide`, `T6.call1.finalize` | anyone (W) | `decide` → Provisional Sustained; the review window passes; `finalize` → Final, allowed effect = refund, closure REVIEW_LAPSED |
| `T6.C.call1.enact` | C via `execute` | `ADRFServiceEscrow.enact(caseId, refund)` — the escrow checks finality, effect, object and binding, refunds the held charge to the client and reports Enacted to the registry |
| `T6.C.call2.open`, `T6.A.call2.deliver`, `T6.A.call2.settle`, `T6.call2.release` | C, A via `execute`; anyone | the control case: a call committed to v2, delivered as v2; the verifier's answer is FALSE (no departure); after the dispute period `release` moves the charge to the provider's escrow balance |
| `T6.C.escrow.withdraw` | C via `execute` | C withdraws what is left (its deposit minus the one conforming call); A's earnings stay in the escrow until T7 |

Checks: the judges are no party to the call; the call holds the charge with committed v1 and declared v2; a stranger (B) has no standing to file and the respondent cannot file against itself; the case is Admitted, Binding, source = the escrow, claimant C, respondent A; the same contested point cannot be filed twice (`ADRF_Duplicate`); the formal finding is TRUE/COMPUTED; the council's issue is under FOGA-Council with the bridge as consumer; `decide` before the judged finding exists reverts; the judged finding is FALSE with the issue as provenance; `finalize` inside the review window reverts; the ruling is Final Sustained with the refund allowed; the client's escrow balance rose by the charge, the settlement is Refunded, the registry records Enacted by the escrow; a second enactment reverts (`Escrow_NotEnactable`); the provider's escrow balance is zero for the disputed call and equals the price for the conforming one; the verifier finds no departure on call 2.

## T7 — safety (the stop is enforced where the cell acts)

| Operation key | Who | Call |
|---|---|---|
| `T7.B.mint`, `T7.B.fund`, `T7.B.commit` | B via `execute` | a hashlock tender over the deterministic finch-extract-verify report, two completions of 0.001 ETH: a pending opportunity for A |
| `T7.G.suspend` | G | `ASFBindingRegistry.suspend(bindingId of A, NO_NEW_RISK ∣ DERISK_ONLY, responseRef, reasonRef)` — the intervener's suspension is also recorded as its standing stop against A for the subject and the specification |
| — | kernel | reads `status()` (NotSatisfied, Suspended) and records its decision: no new commitment-class calls, de-risk actions continue, wait for resume (`T7.kernel.decision`) |
| — (`T7.bypass`) | operator.A, around the kernel | a raw transaction straight to `A.execute(TaskToken, submitFulfillment(...))` with an explicit gas limit: mined with status 0 (the gate's `BindingNotSatisfied`); the hash, gas and decoded reason are evidence |
| `T7.A.derisk.withdraw` | A via `execute` | `ADRFServiceEscrow.withdrawBalance(earned)` — a de-risk action on the allow-list passes the same gate under the suspension: A brings its T6 earnings home |
| `T7.operator.submit`, `T7.operator.settle` | operator.A directly (not through the account) | `submitFulfillment(tokenId, sha256(answer ‖ operator), …)` and its settlement: accepted by the chain, but the fulfiller is the operator's own key and the payout went there; the kernel records the submission as not attributable to A (`T7.unattributed`), and T8 does not count it |
| `T7.A.adopt2` | owner | `adoptBinding(input₂, 0)`: a fresh binding of the same specification presented while the first is suspended |
| `T7.G.resume` | G | `resume(bindingId, reasonRef)` — lifts the standing stop with it |
| `T7.A.submit`, `T7.A.settle` | A via `execute` | A takes the second completion through its account and is paid |
| `T7.A.aid.window` | A via `execute` | `AIDRegistry.setLivenessWindow(120)` — the anchor shortens its own window (its parameter, bounded by the registry's maximum) |
| — | kernel | lets the window pass without a heartbeat (moved on anvil, waited for elsewhere): A is STALE |
| `T7.A.aid.heartbeat`, `T7.B.aid.heartbeat`, `T7.C.aid.heartbeat` (and `T7.X.aid.backing.heartbeat` in a backing registry) | each cell via `execute` | A back to ACTIVE; B and C renew |
| `T7.A.aid.window.reset` | A via `execute` | `setLivenessWindow(0)`: the registry's default again (90 days) |

Checks: a non-guardian cannot suspend (`NotAuthorized`); `status()` is NotSatisfied [Suspended] during the stop; the operator's bypass transaction failed on chain with the gate's reason; a call that is neither de-risk nor allow-listed (an escrow deposit) reverts under the suspension; the de-risk withdrawal succeeded and A's account rose by the earnings; the operator's own submission is not attributable (fulfiller ≠ the account) and its payout left the cell's boundary; with the fresh binding presented `status()` is NotSatisfied [StoppedByIntervener] and the commitment-class call still reverts (the stop follows the adopter and the subject, not the binding); the adopter cannot lift the intervener's suspension; after `resume` the status is Satisfied, A's submission is Accepted with the account as fulfiller and A is paid; with its window shortened to 120 s and the window passed, `state(A) = STALE` and the commitment-class call reverts at the gate's AID clause (`AnchorNotActive`); after the heartbeats the three anchors are ACTIVE (in the backing registry too, where there is one) and the same call passes the gate; A's window is the registry's default again; after the heartbeats all three are ACTIVE and the same call passes the gate (it then fails only inside the tender, both completions being taken). On a replayed run the checks that depend on the suspended or stale state are recorded as skipped.

## T8 — value, as measured (ERC-8454 observation receipts)

| Operation key | Who | Call |
|---|---|---|
| `T8.E.method.register` | E | `AUFAssertionRegistry.registerDescriptor(keccak(JCS(method)), kind "auf:method-descriptor", data: URI)` — `foga.realized-net-cash-flow/1`: inflows that settled on chain to accounts inside the unit's boundary, minus the gas the unit's own operations paid; unobservable items are listed as missing, never written as zero; no field states a value |
| — (`T8.receipt.A`) | the measurer (kernel) | the receipt of cell A's unit over T3–T7: counted — the T3 tender reward, the T6 conforming call (released and withdrawn), the T7 tender reward; shown and excluded — the refunded call (nothing reached the provider) and the operator key's own payout (not attributable); costs — the gas A's keys paid for the account's confirmed operations in the window, from the chain's receipts; missing — model fees, the operator's gas for the refused bypass |
| — (`T8.receipt.swarm`) | the measurer | the receipt of the swarm unit over T4–T5: the two tender payouts to the swarm account; members' accounts and the gas their keys paid are outside the boundary (missing) |
| `T8.E.assert.A`, `T8.E.assert.swarm` | E | `assertStatement({kind Observation, unitId, version, profileId = method hash, contentHash = keccak(JCS(receipt)), contentURI = data: URI, payload = ObservationCore(snapshotHash, windowStart, windowEnd)})` — E is not the units' controller (`byController = false`) |
| — | the resolver (`src/core/measure.ts`) | recomputes each receipt from the chain (settlement state and recipient of every inflow reference, the registered method, the unit version, the assertion's fields) and checks the boundary, the totals, the absence of value fields and double counting across the set |

Checks: the method is registered by E; the assertions are Observations by E with the receipts' hashes; both receipts pass the resolver; a receipt that counts the swarm's tender for A's unit fails the boundary rule and the once rule; a receipt citing an unregistered method is refused; neither receipt carries a value field.

Deviation from the memo: the measured unit for A is the cell's unit (every inflow reaches the account), not a skill unit; the chain pays accounts, not skills, so per-skill revenue would need an allocation rule the receipt does not invent.

## T9 — succession

| Operation key | Who | Call |
|---|---|---|
| `T9.Aprime.deploy`, `T9.Aprime.fund`, `T9.Aprime.setOperator`, `T9.Aprime.scope`, `T9.Aprime.setAIDRegistry`, `T9.Aprime.class.8414.submitFulfillment` | owner.A (the same owner and operator keys as A); W funds on a local chain | the new body, configured as a cell; its allow-list is the successor's (identity, skills-provider, labour, service-provider) |
| `T9.Aprime.adopt` | owner | `adoptBinding` of A-prime's own binding (the old one is A's); nothing executes before it |
| `T9.A.8004.transfer` | A via `execute`, signed by A's owner | `IdentityRegistry.transferFrom(A, A-prime, agentId)` — an asset leaves the cell, which revision 2 of the account refuses to the operator; A's anchor turns STALE: the binding predicate no longer holds |
| `T9.Aprime.aid.bind` (and `T9.Aprime.aid.backing.bind`) | A-prime via `execute` | `AIDRegistry.bind(registry, agentId)` — the takeover: the stale binding does not hold the agent hostage; A's binding record is cleared; A-prime is ACTIVE (the same in the backing registry) |
| `T9.A.aid.retire` (and `T9.A.aid.backing.retire`) | A via `execute` | `retire(successor = A-prime)` — only the anchor itself; `retire` has no delegated form |
| `T9.Aprime.ard.register`, `T9.Aprime.aid.document` | A-prime via `execute` | a new ARD agent record anchored at (chain, A-prime, 0) and A-prime's own AID document (identity facet only: A's standing facet is not carried over) |
| `T9.A.skill.transfer` | A via `execute`, signed by A's owner | `SkillToken.safeTransferFrom(A, A-prime, finch-extract-verify)` — the owner's act, like the identity; the ARD skill record's controller follows the token; the record is no longer adopted (committed by a former controller) |
| `T9.Aprime.skill.adopt` | A-prime via `execute` | `ARDOnchainRegistry.updateDescriptor(recordId, same hash, same URI, same urn)` — recommitting the same descriptor is the adoption |
| `T9.Aprime.auf.unit` | A-prime via `execute` | A-prime's own unit (A's stays A's) |

Checks: A-prime cannot execute before presenting a binding (`BindingsNotPresented`) and cannot bind an agent it does not hold (`NotAgentOfAnchor`); A is ACTIVE before and STALE after the transfer; after the takeover the agent's anchor is A-prime (ACTIVE) and A's binding record is cleared; `retire(successor)` acts on `msg.sender` only; A is RETIRED with `successorOf(A) = A-prime` and cannot heartbeat again; A-prime's record is a new, backed record; its document is its own; the skill token and the record's controller moved, the record was unadopted and is adopted again by recommitment; A-prime has no `S_att` standing while A's assertion still resolves for A; the swarm seat stays with A; A's unit stays A's; a commitment-class call by the retired A reverts at the gate (`AnchorNotActive`); the two histories share one pointer and nothing else.

9d, key loss, is documented rather than demonstrated: under the guarded profile (owner, operator, guardian, recovery) the owner rotates the operator and the anchor stays; a lost anchor key under a lite profile (the anchor is a plain EOA) cannot `retire`, so the old address stays STALE forever and the new identity starts from nothing — no RETIRED state can be promised there.

## Loop C — crashes and resumption

| Case | How to reproduce | Expected, and what CI asserts |
|---|---|---|
| killed after submit, before settle | `foga genesis run … --until T9 --crash-after T3.A.submit` (exit 75), then `foga genesis run … --until T9` | the second run recovers the receipt of `T3.A.submit` by hash and does not re-send; it settles and carries on to T9; `submissionCountOf == 1`; evidence `recovered: 1`. The same holds at any key, for instance `--crash-after T5.swarm.submit` or `--crash-after T6.C.call1.file` |
| intent recorded, never broadcast | `--crash-before T3.A.settle`, then run again | the hash is unknown to the node and the nonce is free: re-sent with the same nonce (`resent: 1`) |
| the same request twice | run a completed scenario again | every operation replayed from the store, nothing sent (`sent: 0`), all end-state checks pass |
| the chain was reset under the store | restart anvil, redeploy, run with the old store | refused: block 0 differs from the one the store recorded |
| RPC timeout after broadcast | (the recovery path above covers it: hash and nonce are consulted before any retry) | — |

`foga genesis status --world <world>` lists the store's rows with status, signer, nonce and hash.

## Operation count and evidence

A complete T0–T9 run on anvil is 193 operations (13 in T0, 67 in T1, 7 in T2, 7 in T3, 24 in T4, 20 in T5, 21 in T6, 16 in T7, 3 in T8, 15 in T9; scenario version 5 — the six operator-scope operations were added in 0.6.0, a 0.5.0 run had 187) and 166 checks, about 100 s including five Groth16 proofs (two credential, three predicate; the predicate proofs take 10-15 s each on a small machine). On a world with a backing registry the run adds the bind, heartbeat, takeover and retirement there (201 operations, 171 checks in the anvil rehearsal of that path); the public-chain funding adds one transfer per role topped up (203 operations on Sepolia with 0.5.0, where nine roles were funded in T0 and the predicate path was off). A store made by an earlier scenario version is not resumed into the new one: the version is recorded in the store, and a mismatch is refused with both versions named. The evidence file `deployments/<world>.genesis.json` holds the checks, the facts, per-step evidence (addresses, ids, hashes, transaction hashes, run receipts, case documents, measurement receipts and their resolver reports, results of the deliberations), the operation summary of the store and the run's journal (time skips and waits included); `deployments/local.genesis.example.json` is a committed local run, `deployments/local-attach.genesis.example.json` the rehearsal, `deployments/sepolia.genesis.example.json` the Sepolia run (below). `foga doctor --genesis <evidence.json>` turns the checks into the doctor's fifth layer, per standard (docs/doctor.md).

## Running on a public chain

The scenario is the same; the chain is not. Four things differ, and each is a branch the anvil run also takes, so the public-chain path is rehearsed in CI on anvil (an attach-mode world built by `scripts/attach-rehearsal.mjs`) before it is run for real.

**The world is attached and completed.** `worlds/sepolia.json` is an attach-mode config: every address comes from the upstream deployment records (docs/version-lock.md). Plan steps the config does not list are what the upstream records do not provide at the locked revision — on Sepolia the whole ERC-8471 stack (deployed upstream at revision 3, which cannot be bound to a revision-4 escrow: the binding module admits only sources declaring its own `IADRFObligationSource` id) and the two ERC-8447 eligibility modules never deployed upstream. `foga world deploy --world worlds/sepolia.json` attaches what is listed and deploys the rest from the bundle, with W as deployer (111 M gas for the 15 contracts on Sepolia; before the first one is sent the deployer's balance is checked against a budget of 11 M gas per contract at the chain's quote, `DEPLOY_GAS_PER_STEP` in `src/world/deploy.ts`), so the escrow the genesis binds in T0 is administered by W. The resulting `deployments/sepolia.json` is an ordinary world file (`mode: attached`; the steps say which contracts were deployed here), and the doctor runs on it as on any other.

**Twelve keys, one treasury.** `foga keys new` writes a BIP-39 phrase to a file outside the repository (`~/.foga/genesis.mnemonic`, mode 0600) and prints the twelve role addresses; `FOGA_MNEMONIC_FILE` (or `FOGA_MNEMONIC`) hands it to every command, and `FOGA_KEY_<ROLE>` overrides a role. Only W needs to be funded by hand: before every step the kernel tops up each role whose balance has fallen below half its floor, and gives each cell its capital at birth (`T<n>.fund.<role>`, `T1.X.fund`, `T9.Aprime.fund`; 0.005 ETH per cell and 0.001 for the successor on a public chain — B funds 0.003 ETH of rewards, C deposits 0.002). A floor is a gas budget — what the role spent in the Sepolia run, with a margin of about one half (`src/genesis/funding.ts`, `ROLE_GAS_BUDGET`; the table below) — priced at the fee the chain quotes when the step starts, never below a floor of its own (`FOGA_FEE_FLOOR_GWEI`, 0.1 gwei by default: a quiet testnet quotes fractions of a wei), so a rising base fee raises the top-up rather than starving a role, and the amount of every transfer is fixed in the store the first time so a resumed run rebuilds it. The cells' pre-commitment check compares the operator's gas with a quarter of the same budget. `foga genesis preflight --world deployments/sepolia.json` prints the plan without sending anything: every role's balance against its floor, what W must hold (the top-ups, the cells' capital and W's own budget of 200 M gas for the genesis), the escrow's admin, the backing registry, the proving material and the waits.

What the run costs is a matter of the chain's gas schedule, not of the scenario: Sepolia runs the repriced schedule of its Glamsterdam fork (block-level access lists in its headers; a plain transfer costs 204,600 gas there, code deposit about 1,500 gas per byte), the schedule the public chains are moving to, and the 203 operations of the genesis, which take 108 M gas on anvil, took 475 M gas on Sepolia — deployments 6.5–7 times anvil's figure, calls 2–5 times, 4.4 times in all — plus 111 M gas for the 15 contracts of the world deployment: 586 M gas for the whole thing. The budgets are those figures with their margin, 721 M gas in all (W 200 M for the genesis, 521 M for the other eleven roles), so the preflight asks W for 0.72 ETH per gwei of the quoted fee plus 0.019 ETH of capital and tender rewards: 0.09 ETH at the 0.1 gwei floor, 0.74 ETH at 1 gwei, 2.2 ETH at 3 gwei, 7.2 ETH at 10 gwei; the world deployment asks for a further 0.165 ETH per gwei (0.0165 at the floor). What the roles do not spend stays in their accounts (the phrase holds every key): the Sepolia run itself was priced by the chain at 22 wei per gas (base fee 15, priority 7), so its 586 M gas cost 0.000013 ETH, and what left W (0.031 ETH of a faucet's 0.05) was the roles' top-ups and the cells' capital, which the phrase still holds. When the chain is that quiet, `FOGA_FEE_FLOOR_GWEI=0.05` halves what the preflight asks for.

| Role | Gas spent on Sepolia (M) | Largest step | Budget (M gas) |
|---|---|---|---|
| W | 131.3 in the genesis (+ 111.2 in the world deployment) | T0 54.7 (T4 50.3) | 200 (+ 11 per contract deployed) |
| G | 0.8 | T7 | 1.25 |
| owner.A | 44.7 | T1 21.8 (T9 20.1) | 67 |
| owner.B, owner.C | 21.9, 21.8 | T1 21.8 | 33 each |
| operator.A | 85.7 | T2 33.9 (T1 25.4, T9 19.4) | 130 |
| operator.B | 103.5 | T4 29.1 (T1 23.2, T3 22.6, T5 21.2) | 156 |
| operator.C | 32.2 | T1 23.2 | 49 |
| E | 31.8 | T8 31.8 | 48 |
| J1, J2, J3 | 0.8, 0.4, 0 | T5 | 1.25 each |

**Two liveness registries.** On Sepolia the ERC-8444 agent kind is anchored to ARD's own fixture `AIDRegistry` (`8434/AIDRegistry(ard-fixture)`, 30-day default window), not to aid-standard's reference instance the cells' accounts gate on (seam 1 of docs/version-lock.md). A world that names a backing registry under that id makes the cells keep their liveness in both: `bind` at birth (T1), heartbeats in T7, the takeover and the retirement in T9, each a `backing.*` operation mirroring the primary one; the ARD `backed` checks read the backing registry, and the evidence records both states. Documents and facets stay in the reference registry; the backing registry carries liveness only.

**Real time.** The public timing profile (table above) is waited for: about fifty minutes over T5–T7, plus one block per operation. T7 makes A STALE by shortening A's own liveness window to 120 s rather than by moving the clock 90 days, which is also what the anvil run does now. Receipts are awaited for 120 s per operation; a transaction still pending after that is replaced under the same nonce with fees raised by a third (up to three times), and a resumed run recognizes whichever of an operation's transactions was mined (docs/kernel.md). The probe of T3 reads state at a fixed block; a run resumed or replayed later than the endpoint's state window (about 128 blocks on a public cluster of non-archive nodes) cannot reproduce the answer and records `A.answer` and `copy.refused` as skipped — the settlement on chain is the proof of the original answer.

The sequence on a machine that reaches a Sepolia RPC (the repository's EC2, for instance):

```bash
export SEPOLIA_RPC_URL=https://...                   # the config's rpc is ${SEPOLIA_RPC_URL}
npm run foga -- keys new                             # once; prints W's address: fund it (0.11 ETH at the 0.1 gwei floor for the deployment and the genesis; the two commands below say what they need)
export FOGA_MNEMONIC_FILE=~/.foga/genesis.mnemonic
npm run foga -- world deploy --world worlds/sepolia.json --rpc $SEPOLIA_RPC_URL     # attaches 35, deploys 15 (W pays; refused before the first one if W holds less than the budget); add --resume to continue an interrupted deployment
npm run foga -- genesis preflight --world deployments/sepolia.json --rpc $SEPOLIA_RPC_URL
npm run foga -- genesis run --world deployments/sepolia.json --rpc $SEPOLIA_RPC_URL --until T9     # 1.5-2.5 h; re-run to resume
npm run foga -- doctor --world deployments/sepolia.json --rpc $SEPOLIA_RPC_URL --genesis deployments/sepolia.genesis.json
```

`--zk auto` records which proving paths the machine has; `--zk require` insists on both (the predicate material is built with `npm run zk:predicate`, docs/zk.md). The store `deployments/sepolia.genesis.sqlite` is the run's memory: an interrupted run is resumed by the same command; nothing is sent twice.

### The Sepolia run (2026-11-01)

World `sepolia-11155111-20261101T043153Z` (`deployments/sepolia.example.json`): 35 upstream contracts attached, 15 deployed by W (`0x3D177ecaa56402335fC7C6449d35bC1Fa68Bc1b8`) in blocks 12038625–12038640, the ERC-8004 registry at its official address. The genesis ran from the project's EC2 against a public RPC (publicnode), T0 at 04:35 UTC, the 203rd operation confirmed in block 12040082; the operations span blocks 12038641–12040082. Cells: A `0xA0d1B8e9370EA798f517F8DD8562ca6e77c0BcCc`, B `0x9303a594f6224320016a30f9eB01F79b7426d40F`, C `0x235EDC4D29146686B2CB3e750c5dB5224720D76e`, A-prime `0x09F35299C34694929f0f35DDD7AE894E8F122D75`; ERC-8004 agents 11255–11257; the swarm's account `0xe86650Fca5C117f7f1a8361618Db7f48BB23EA70`; the service escrow `0xCDc9Eb5Cb1D6b195Dbf29353f368C52e7ba76cf0`. Every address, id, hash and transaction is in the evidence file, every contract's verdict in the doctor report (`deployments/sepolia.doctor.example.json`: Pass 234, Fail 1 — the ARD fixture registry's known older source —, Unknown 2 — the two interface ids upstream publishes none for —, all eleven standards Pass on layer 5; docs/version-lock.md).

The run was not uneventful, and the evidence shows it: its journal (1,532 entries) is the store's whole history, resumes included. The timing profile cost about fifty minutes of waiting as planned (the dispute period alone 1,801 s). Twice a read landed on a node of the RPC cluster that had not yet imported the block of the previous receipt — the swarm's roster read as not met one second after the third join confirmed (`T4.activate`, `SAI_RosterNotMet`), and the delivery of a call opened one block earlier was refused by the estimate (`T6.A.call2.deliver`, `Escrow_UnknownCall`); both are `estimate-failed` entries, the run was resumed, and the kernel's reads have been pinned to the blocks it has written since (docs/kernel.md; the 43 `pinned-read` entries record the nodes' refusals in their own words). Once the process hung after a transaction was mined (`T9.Aprime.aid.backing.bind`, block 12039588); the resumed run recovered the receipt by hash (`recovered-receipt`) and finished. The predicate-pattern proof was off (`T0.zk.predicate = off`: the proving material is not built on that machine), so the eleven `S_pred` checks of T3 are one skipped check there.

The committed evidence (`deployments/sepolia.genesis.example.json`) is the final replay of the completed run, made with 0.5.0-alpha.9 at block 12040269: 203 operations replayed from the store, nothing sent, 161 checks of which 114 were remade against the chain as it stood and passed, and 47 recorded as skipped because the state they are about had been changed later by the run itself (a suspension since lifted, a tender since settled, an identity since transferred — the reason is in each check). The same checks had passed live when their steps ran — or, for the two that a lagging node failed (`T4 swarm.rosterMet`, `T6 refund.twice.refused`), on the resume that followed; what the replay adds is that the end state still holds, which the doctor's layer 5 then attributes per standard (every effective check Pass). The world was read against an independent node while the replays were being debugged: the chain was right, the first replays were reading it at the wrong block (0.5.0-alpha.9).

## Not in this phase

- A production trusted setup for the predicate circuit: the committed keys come from a development ceremony with a public beacon (docs/zk.md).
