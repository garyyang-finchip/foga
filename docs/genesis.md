# The genesis scenario (T0–T3 in Phase 2a-1)

The genesis is the run that proves the ten-ERC stack composes into a working agent: a world is set up, three cells are born, one of them acquires skills, and it earns a reward by doing verifiable work for another. Design memo section 4 defines ten phases, T0–T9; this phase implements T0–T3 and the recovery cases of loop C (memo section 5.2). T4–T5 follow in Phase 2a-2, T6–T9 in Phase 2b, the Sepolia run in Phase 2c.

Everything below runs on anvil with `foga demo --genesis T3` (fresh chain) or, against a deployed world, with `foga genesis run --world deployments/local.json --until T3`. The run is idempotent: a second invocation replays every recorded operation from the operation store and re-checks the end state without sending a transaction; an interrupted run is resumed by invoking it again (docs/kernel.md).

## Actors

| Signer | anvil account | Role |
|---|---|---|
| `W` | #0 | world operator: deploys the world, registers the KYA schemes and the ASF specification, issues the attested standing assertions, funds the cells on a local chain |
| `G` | #1 | guardian: the intervener with suspend and resume rights in every cell's binding |
| `owner.A/B/C` | #2 #3 #4 | cold principals: deploy and administer the accounts, adopt the bindings |
| `operator.A/B/C` | #5 #6 #7 | hot signers: act through `execute` |
| `E`, `J1–J3` | #8, #10–#12 | evaluator and judges (later phases) |

The cells are contract accounts (`FogaCellAccount`, docs/cell-account.md), not the signers: `A` is `0x663F…`, `B` is `0x057e…`, `C` is `0xbdEd…` on a fresh anvil world (deterministic: same keys, same nonces).

## T0 — world

Pre-condition: a deployed world (`foga world deploy`, 47 contracts, four ARD kinds). The genesis then registers, as `W`:

| Operation key | Call | Result fact |
|---|---|---|
| `T0.kya.S_att.register` | `KYASchemeRegistry.registerScheme` — attested, IDENTITY binding, ordered levels 0–3 ("none, known, bound, audited"), descriptor as a `data:` URI committed by keccak | `T0.kya.S_att.schemeId` |
| `T0.kya.S_cred.register` | `registerScheme` — proved, verifier = the Groth16 credential adapter of the world, levels 0–4 | `T0.kya.S_cred.schemeId` |
| `T0.asf.spec.register` | `ASFSpecificationRegistry.registerSpecification(salt, keccak(JCS(spec)), data: URI, [])` — the FOGA-Cell-v1 specification: commitment-class actions only while the anchor is ACTIVE, interventions honored at the gate, de-risking always open, attribution only through the account | `T0.asf.spec` (specId, version 1, contentHash) |

Checks: the pinned version's content hash equals `keccak(JCS(spec))`; both schemes exist.

Deferred from the memo's T0 to later phases: the ACDF policy FOGA-Council and the ACDFTaskTenderAdapter (T5, 2a-2), the ADRF policy and FOGA's ADRFServiceEscrow (T6, 2b), the predicate scheme S_pred (2b).

## T1 — birth, for each of A, B, C

| # | Operation key | Who | Call |
|---|---|---|---|
| 1 | `T1.X.deploy` | owner | deploy `FogaCellAccount(safety = ASFBindingRegistry, owner, operator, guardian = G, recovery = owner, requirement)`; the requirement is one clause — FOGA-Cell-v1 version 1, adopter = the account, subjectKey = keccak(`eip155:<chain>:<account>`), scopeKey = keccak(JCS({ref})), enforcement account+contract, intervener G with suspend+resume — built from the address predicted for the deployment nonce |
| 2 | `T1.X.fund` | W | 0.05 ETH of working capital to the account (local chains only) |
| 3 | `T1.X.setOperator`, `T1.X.setAIDRegistry` | owner | operator scope (no expiry, 0.01 ETH per day), the AID registry for the commitment gate |
| 4 | `T1.X.class.*` ×4, `T1.X.derisk.*` ×3 | owner | commitment-class selectors (8414 submitFulfillment, 8447 join / applyToJoin, 8454 assertStatement) and de-risk selectors (8414 withdrawCredit / reclaimEscrow, 8447 leave) |
| 5 | `T1.X.adopt` | owner | `adoptBinding(input, 0)`: the account adopts FOGA-Cell-v1 v1 with G as intervener (rights suspend+resume), params and authority documents as `data:` URIs; the binding is presented for clause 0 |
| 6 | `T1.X.8004.register` | operator via `execute` | `IdentityRegistry.register(agentURI)` with an ERC-8004 registration file; the NFT belongs to the account |
| 7 | `T1.X.aid.bind`, `T1.X.aid.heartbeat` | operator via `execute` | `AIDRegistry.bind(identityRegistry, agentId)` (the account owns the agent), `heartbeat()` |
| 8 | `T1.X.kya.attest` | W | `KYARegistry.attest({account, (chain, account)}, S_att, level 2, claimDigest, expiresAt = +365 d, evidence data: URI, claimDigest)` |
| 9 | `T1.X.aid.document` | operator via `execute` | `setDocumentURI(data: URI, keccak(JCS(document)))` — an `aid-document/v1` with a SELF identity facet (resolver erc8004-identity) and an ATTESTED standing facet (resolver erc8419-assertion citing the assertion) |
| 10 | `T1.X.ard.register` | operator via `execute` | `ARDOnchainRegistry.register(kind agent, target = account, id = 0, sha256(JCS(authored descriptor)), data: URI, urn)` — the AgentAdapter makes the anchor its own controller |
| 11 | `T1.X.auf.unit` | operator via `execute` | `AUFUnitRegistry.registerUnit(controller = account, keccak(JCS(definition)), data: URI, [])` — the cell's unit: agent element, treasury position, deliverable and funds ports |

Checks per cell (memo "expected"): `state(anchor) == ACTIVE`; `check({account, anchor}, S_att, 2, [W]) == true`; `status()` Satisfied; the ARD record `backed`; the unit's controller is the account; the ERC-8004 agent's owner is the account; `requirementId()` equals `keccak(abi.encode(requirement))` computed off-chain; `computeBindingId(account, input)` equals the adopted id.

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

## Loop C — crashes and resumption

| Case | How to reproduce | Expected, and what CI asserts |
|---|---|---|
| killed after submit, before settle | `foga genesis run … --until T3 --crash-after T3.A.submit` (exit 75), then `foga genesis run … --until T3` | the second run recovers the receipt of `T3.A.submit` by hash and does not re-send; it settles; `submissionCountOf == 1`; evidence `recovered: 1` |
| intent recorded, never broadcast | `--crash-before T3.A.settle`, then run again | the hash is unknown to the node and the nonce is free: re-sent with the same nonce (`resent: 1`) |
| the same request twice | run a completed scenario again | every operation replayed from the store, nothing sent (`sent: 0`), all end-state checks pass |
| the chain was reset under the store | restart anvil, redeploy, run with the old store | refused: block 0 differs from the one the store recorded |
| RPC timeout after broadcast | (the recovery path above covers it: hash and nonce are consulted before any retry) | — |

`foga genesis status --world <world>` lists the store's rows with status, signer, nonce and hash.

## Operation count and evidence

A complete T0–T3 run is 73 operations (3 in T0, 19 per cell in T1, 7 in T2, 6 in T3) and 50 checks. The evidence file `deployments/<world>.genesis.json` holds the checks, the facts, per-step evidence (addresses, ids, hashes, transaction hashes, the run receipt), the operation summary of the store and the run's journal; `deployments/local.genesis.example.json` is a committed example.

## Not in this phase

- T1 ④ for A through `S_cred` (`attestWithProof` with a Groth16 proof by the node) — 2a-2, together with T4 (swarm) and T5 (judged tender, FOGA-Council, SwarmDecisionAdapter governance).
- T6–T9, the predicate circuit (`S_pred`), doctor layer 5 and the AUF measurement receipt — 2b.
- The Sepolia run — 2c (the keys come from `FOGA_KEY_<ROLE>`; the AgentAdapter seam documented in docs/version-lock.md means cells bind in both AID registries there).
