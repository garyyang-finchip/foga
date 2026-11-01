# Finch OG Agent (FOGA)

FOGA is a reference autonomous agent built on ten Ethereum ERC drafts written by the same author:

| ERC | Title | Role in a cell |
|---|---|---|
| ERC-8338 | Token-Bound Executable Skills | what a cell can execute (hash-verified skill packages) |
| ERC-8414 | Token-Bound Task Tenders | the work a cell takes or offers (escrowed tenders) |
| ERC-8419 | Know-Your-Agent (KYA) Framework | how a cell proves facts about itself (attested and ZK-proved assertions) |
| ERC-8434 | Agent Identity (AID) | the address-anchored identity and liveness of a cell |
| ERC-8436 | Agent Collective Decision Framework (ACDF) | how cells decide together (authorized K-of-N decisions with finality) |
| ERC-8444 | Agentic Resource Discovery (ARD) Onchain | how cells, skills and tasks are found |
| ERC-8447 | Swarm AI Framework (SAI) | how cells organize into purpose-bound swarms |
| ERC-8454 | AIFi Unit Framework (AUF) | the economic boundary and measurement of a cell or swarm |
| ERC-8468 | Agent Safety Framework (ASF) | the safety specifications a cell adopts and the interventions it must honor |
| ERC-8471 | AI Dispute Resolution Framework (ADRF) | how claims about a cell's conduct are filed, ruled on and enacted |

ERC-8004 (Trustless Agents) is a required dependency: ERC-8419, ERC-8434 and ERC-8447 bind to its Identity Registry.

The project delivers three things from one kernel: the **Finch OG Agent** (the first running instance), the **FOGA node software** anyone can run with their own identity, model and wallet, and a **public access layer** (MCP, A2A, HTTP/CLI). It is built in phases; this repository has completed **Phase 2c: the genesis on a public chain**, on top of the Phase 2 genesis (T0–T9) and the Phase 1 world layer.

## Status: Phase 3 started — the kernel hardened for a public node (3a-1); Phase 2c done

**3a-1 (0.6.0-alpha.1, 2026-11-02).** Phase 3 turns the kernel into a node other agents can call, and its first slice gives the kernel what a public service needs and a scenario driver did not: `FogaCellAccount` revision 2 — the operator may call only what the owner allow-listed, never an asset-moving selector, and signs for the account only when enabled and the gate is satisfied; a node holds one key, its cell's operator, and refuses an environment from which any other role could be derived (`foga keys export`, `foga keys check`); the transaction manager counts fee replacements on the row so the limit holds across restarts, caps fees, runs one signer's operations one at a time, binds a key to the hash of its request (another request under the same key is a conflict), and answers a failed operation with its failure until it is retried explicitly; jobs sit beside operations in the store; the skill worker runs both executors out of process under Node's permission model. All of it is tested offline against an in-process chain (`test/tx-semantics.test.ts`) and by the genesis on anvil, which now opens each cell's scope itself (193 operations, 166 checks). docs/kernel.md, docs/cell-account.md, docs/design-memo.md (section 9) and the changelog have the detail; what 3a-2 to 3d add is in the memo.

**The Sepolia run (0.5.0, 2026-11-01).** World `sepolia-11155111-20261101T043153Z`: the 35 upstream reference deployments attached, 15 contracts added from the bundle by W, the official ERC-8004 registry. The genesis T0–T9 ran from the project's EC2 against a public RPC: 203 operations in blocks 12038641–12040082, three cells born (ERC-8004 agents 11255–11257), A's skills minted and run for B's tender, the swarm formed and paid on a council-judged tender, the dispute refunded by the escrow, the guardian's stop enforced at the gate, the measurements asserted, A's identity moved to A-prime. The doctor on the completed world: Pass 234, Fail 1 (the ARD fixture registry's known older source), Unknown 2, all eleven standards Pass on layer 5. The three files are committed: `deployments/sepolia.example.json` (the world), `deployments/sepolia.genesis.example.json` (the evidence: checks, facts, per-step evidence, the journal of the whole run including its resumes) and `deployments/sepolia.doctor.example.json`. What the run taught — a public RPC cluster's nodes disagree for a second after every block, Sepolia's repriced gas schedule charges 4.4 times anvil's figures (586 M gas for world and genesis), a replay must read the chain at its head — is in docs/genesis.md ("The Sepolia run"), docs/kernel.md and the 0.5.0 changelog; the gas budgets of the roles are now the measured Sepolia figures with a margin.

Built for 2c (0.5.0-alpha.1 to alpha.9):

- **The same scenario on a public chain.** `foga world deploy` on the Sepolia config attaches the upstream reference deployments and adds, from the same bundle, what their records do not provide at the locked revision (the ERC-8471 stack, deployed upstream at revision 3 which a revision-4 escrow cannot be bound to, and the two ERC-8447 eligibility modules never deployed upstream), with W as deployer. Cells keep their liveness in two ERC-8434 registries where the world names a backing one (Sepolia's ARD agent kind is anchored to ARD's own fixture registry). T7 makes an anchor STALE by shortening its own liveness window and waiting, the same way on every chain.
- **Twelve keys from one phrase, one treasury.** `foga keys new` writes a BIP-39 phrase outside the repository and prints the role addresses; only W is funded by hand — before every step W tops up each role below half its floor (a gas budget measured on Sepolia, priced at the chain's current fee) and gives each cell its capital at birth. `foga genesis preflight` prints the plan, the escrow's admin, the proving material and the waits, and sends nothing; `foga world deploy` checks the deployer's balance before the first deployment.
- **Public-chain transaction handling.** Public endpoints are polled every 4 s; a transaction still pending after the 120 s receipt wait is replaced under the same nonce with fees raised by a third, up to three times, and a resumed run recognizes whichever of an operation's transactions was mined. Every state read is pinned to the highest block the kernel has seen, so a node of the RPC cluster that has not imported the last block answers with an error that is retried, never with stale state.
- **Rehearsed before it is run.** CI builds an attach-mode world on anvil from a deployed local one (`scripts/attach-rehearsal.mjs`: address book attached, 15 contracts added by `foga world deploy`, a second AIDRegistry as backing registry), runs the preflight, the genesis T0–T9 and the doctor on it: 171 checks, all eleven standards Pass. The public timing profile (about fifty minutes of waiting over T5–T7) and the Sepolia runbook are in docs/genesis.md, "Running on a public chain".

From 2b (0.4.0-alpha.1):

- **The predicate-pattern ZK path.** FOGA's own circuit `kya_predicate_count_v1` (8 record slots, source set of depth 16) proves "at least K task-completion records about me, signed by a source of the committed set, are Accepted inside a window" without revealing the records; `Groth16PredicateKYAVerifierAdapter` admits it as scheme `S_pred`. A proves its first completion at the end of T3; a false predicate (K = 2 with one completion) is refused by the adapter, a flipped result bit by the verifier, replays and stale epochs by the registry. The proving material is built locally by a deterministic development ceremony (`npm run zk:predicate`; CI rebuilds it on a cache miss and checks the committed verifier against it). docs/zk.md.
- **T6 — dispute.** C buys a run of A's skill through the world's ERC-8471 service escrow, bound in T0 to FOGA-Service-v1; A publishes v2 and delivers it against terms committing v1; C files; the declared-version verifier answers the formal question, FOGA-Council the judged one through the bridge; the ruling is Final Sustained and the escrow enacts the refund once. A control call committed to v2 settles and is released.
- **T7 — safety.** The guardian suspends A; a transaction sent around the kernel fails on chain at the account's gate; the allow-listed de-risk withdrawal passes; the operator's direct submission is accepted by the chain but not attributable to the cell; a fresh binding does not escape the intervener's standing stop; after `resume` A works again; a STALE anchor stops commitment-class calls until the next heartbeat.
- **T8 — measurement.** E registers `foga.realized-net-cash-flow/1` and asserts observation receipts for cell A and for the swarm: settled inflows inside each boundary, gas as the cost, unobservable items as missing, never a value; a deterministic resolver recomputes them from the chain and fails a receipt that counts the swarm's tender for A or cites an unregistered method.
- **T9 — succession.** A moves its ERC-8004 agent to A-prime through its account: A turns STALE, A-prime takes the binding over, A retires naming its successor, A-prime publishes a new record and document, the skill follows and its record is adopted again by recommitment; standing, swarm seat, unit and binding are not inherited.
- **Doctor layer 5.** `foga doctor --genesis <evidence.json>` turns the genesis checks into per-standard verdicts; the demo runs it after the genesis.
- 187 operations, 166 checks, all green on anvil in about 100 s (five Groth16 proofs); every step resumes after an injected crash, and a replayed run re-checks what still holds and records the rest as skipped.

From 2a-2 (0.3.0-alpha.1):

- **T4 — organization.** W tenders a judged task; B forms a swarm bound to it (coordinator and two workers under a composite eligibility: registered ERC-8004 agent, ACTIVE anchor, attested standing ≥ 2); A and C join through their accounts; the swarm account is bound; the swarm becomes an AUF unit containing the members' units at pinned versions. A stranger's join is refused; a revoked assertion suspends a member on challenge and a fresh one reinstates it.
- **T5 — governance.** The swarm account submits the `finch-extract-verify` report (deterministic path over a pinned fixture); the FOGA-Council (three judges, two decide) accepts it through FOGA's instance of the upstream `ACDFTaskTenderAdapter`; the workers amend the charter through the `SwarmDecisionAdapter`; a second case ends without a decision and the tender's own `claimUnjudged` pays after the window; the swarm concludes ACHIEVED. Wrong-round ballots, non-judge ballots, premature or repeated execution are refused.
- **The credential-pattern ZK path.** A's standing is also proved in zero knowledge: W's attestor signs a credential over A's commitment, A proves it for this registry and epoch (Groth16, `kya-public-v1`), and FOGA's own `Groth16KYAVerifierAdapter` admits it as issuer of record. Replayed, re-targeted and stale-epoch proofs are refused. The prover lives in `prover/`, a sub-package over the upstream prover (`npm run zk:install`).
- 125 operations, 89 checks, all green on anvil in about 40 s; every step resumes after an injected crash.

From 2a-1 (0.2.0):

- **FogaCellAccount** (`contracts/src/FogaCellAccount.sol`, 15 Foundry tests). The body of a cell: anchor, ERC-8004 owner, asset holder, fulfiller, adopter, subject and controller in one contract account, with the ERC-8468 execution gate (no path around it), owner/operator/guardian/recovery roles, operator scope (expiry, daily value cap), an AID-state gate for commitment-class selectors, ERC-1271 and the token receiver hooks. docs/cell-account.md.
- **foga-core** (`src/core/`). One module per ERC — views, calldata builders, event decoders — plus RFC 8785 canonicalization and a byte-exact port of the ERC-8338 DAG-CBOR packager (verified against the upstream vectors).
- **foga-kernel** (`src/kernel/`). An operation store on `node:sqlite`, a transaction manager that sends each keyed operation exactly once and recovers by hash and nonce after a crash, cells driven through their accounts, facts, evidence and a revert decoder across every ABI. docs/kernel.md.
- **The genesis, T0–T3** (`src/genesis/`, `foga genesis run`). World registrations (two KYA schemes, the FOGA-Cell-v1 safety specification); three cells born with their bindings, ERC-8004 identities, AID anchors and documents, attested standing, ARD records and AUF units; two real skill packages minted by A; a hashlock tender from B that A discovers, pre-checks, fulfils in an isolated worker, settles and is paid for. 73 operations, 50 checks, all green on anvil; the memo's loop-C cases (crash after submit, crash before broadcast, duplicate run, reset chain) are reproduced in CI. docs/genesis.md.

From Phase 1, unchanged in substance:

- **Locked sources.** `vendor/LOCK.json` pins the ten reference implementations by commit. `foga vendor sync` materializes them; nothing is modified downstream.
- **One artifact bundle.** `foga build` compiles all ten with their own compiler settings (five profiles on solc 0.8.24, three on 0.8.30, two solc-js repositories mirrored on 0.8.28) into `artifacts/bundle.json`: ABIs, creation and runtime bytecode, link and immutable references, compiler metadata, ERC-165 ids computed from the AST and cross-checked against the upstream vectors (all published ids match). `foga build --verify` rebuilds and proves the hash.
- **One-command world.** `foga world deploy` deploys the whole stack in dependency order — 47 contracts including external libraries and the ERC-8471 module router — and registers the four ARD kinds. Local worlds use `contracts/src/Identity8004Stub.sol` as a clearly labeled stand-in for the ERC-8004 Identity Registry; public worlds attach the official registry.
- **The doctor.** `foga doctor` reports five layers per contract — chain and code, interfaces, version match, configuration and permissions, semantic validation — with the verdicts Pass / Fail / Unknown / Not tested / Not applicable. Layers 1–4 probe the chain; layer 5 reads the genesis evidence. A doctor run can be exported as a JSON-RPC probe plan and replayed from results collected elsewhere, so a report never depends on which machine can reach which RPC.
- **Sepolia address book.** `worlds/sepolia.json` records every upstream reference deployment at its deployed revision, including the three seams the inventory found (docs/version-lock.md); the completed world and the doctor's report on it are the 2c files above.

What is next: Phase 3 continues with the capability catalog, policy engine and node skeleton (3a-2), MCP and the HTTP API (3b), loop D (3c), A2A and the OG instance's move to a revision-2 account with public endpoints (3d); Phase 4 the hosted node and payments. The design is in docs/design-memo.md.

## Quick start

Three ways in, from most to least demanding:

```bash
# 1. Full reproduction (needs git, Node >= 22 and Foundry):
npm ci
npm run vendor:sync          # fetch the ten repositories at the locked commits
npm run bundle:verify        # rebuild artifacts/bundle.json and compare its hash
npm run test:contracts       # Foundry tests for FogaCellAccount and the ERC-8004 stand-in
npm run zk:install           # proving libraries for the ZK paths (prover/, separate from the kernel's dependencies)
npm run zk:predicate         # build FOGA's predicate circuit and its development proving key (10-60 min, once; optional)
npm run demo:genesis         # anvil + world deploy + doctor + genesis T0-T9 + doctor layer 5, all local

# 2. World and genesis only (Node >= 22 and Foundry's anvil, no Solidity build; the ZK paths are left out without their material):
npm ci && npm run demo:genesis

# 3. Containers (Docker with Compose):
docker compose up --build     # anvil + world + doctor + genesis; outputs land in ./deployments
```

The genesis against a running node, step by step:

```bash
npm run foga -- world deploy --world worlds/local.json --rpc http://127.0.0.1:8545 --out deployments/local.json
npm run foga -- genesis run --world deployments/local.json --rpc http://127.0.0.1:8545 --until T9
npm run foga -- genesis status --world deployments/local.json         # the operation store
npm run foga -- doctor --world deployments/local.json --genesis deployments/local.genesis.json   # layer 5 from the evidence
```

Interrupt and resume (the same command again replays what was done and continues). `demo --keep` leaves its anvil running in the background and returns:

```bash
npm run foga -- demo --keep --genesis T2                                                           # chain, world, doctor, T0-T2
npm run foga -- genesis run --world deployments/local.json --until T9 --crash-after T3.A.submit   # exits 75 after the submit is broadcast
npm run foga -- genesis run --world deployments/local.json --until T9                              # recovers the submit by hash, settles, carries on
```

Against a running node:

```bash
npm run foga -- world deploy --world worlds/local.json --rpc http://127.0.0.1:8545 --out deployments/local.json
npm run foga -- doctor --world deployments/local.json --rpc http://127.0.0.1:8545 --out deployments/local.doctor.json
```

Against Sepolia (needs an RPC that the machine can reach). The read-only doctor on the attached address book:

```bash
FOGA_RPC_URL=$SEPOLIA_RPC_URL npm run foga -- doctor --world worlds/sepolia.json --attach --out deployments/sepolia.doctor.json
```

The genesis there — one phrase for the twelve roles, W funded by hand, the world completed from the bundle, the preflight, then the run (1.5–2.5 h with the public windows; the same command resumes an interrupted run):

```bash
npm run foga -- keys new                                   # writes ~/.foga/genesis.mnemonic, prints the addresses; fund W
export FOGA_MNEMONIC_FILE=~/.foga/genesis.mnemonic
npm run foga -- world deploy --world worlds/sepolia.json --rpc $SEPOLIA_RPC_URL
npm run foga -- genesis preflight --world deployments/sepolia.json --rpc $SEPOLIA_RPC_URL
npm run foga -- genesis run --world deployments/sepolia.json --rpc $SEPOLIA_RPC_URL --until T9
npm run foga -- doctor --world deployments/sepolia.json --rpc $SEPOLIA_RPC_URL --genesis deployments/sepolia.genesis.json
```

Or in two steps through any relay that has an RPC — export the plan here, collect results there, evaluate anywhere:

```bash
npm run foga -- doctor --world worlds/sepolia.json --attach --export-probe sepolia.probe.json
node scripts/relay.mjs $SEPOLIA_RPC_URL sepolia.probe.json > sepolia.results.json
npm run foga -- doctor --world worlds/sepolia.json --attach --import-results sepolia.results.json --out deployments/sepolia.doctor.json
```

Offline builds: if the machine cannot reach the solc binary mirror, download the three static binaries from the Solidity GitHub releases with `scripts/install-solc.sh` and export `FOGA_SOLC_DIR`.

Older Linux (Amazon Linux 2 and 2023, CentOS 7, Debian 11, …): the regular Foundry binaries need glibc 2.35 and fail with ``version `GLIBC_2.35' not found``. `scripts/install-foundry.sh` installs the statically linked build of the pinned release (v1.7.1) into `~/.foga/foundry`; export `FOGA_FOUNDRY_DIR=~/.foga/foundry` for `foga demo`, or put that directory first on `PATH` to use its anvil, forge and cast everywhere.

## Layout

```
artifacts/           bundle.json (+ .sha256): the compiled ten-ERC stack and FOGA's contracts, committed and CI-verified
build/               build profiles per repository and the README-published interface ids
contracts/           FOGA's own contracts: FogaCellAccount, Identity8004Stub (local stand-in), zk/ (the predicate verifier and its KYA adapter), Foundry tests
deployments/         world files, doctor reports, genesis evidence (local outputs are gitignored; examples are kept)
prover/              the ZK proving sub-package: run.cjs bridge (credential and predicate proofs), build-predicate.mjs (the development ceremony), its own dependencies
zk/                  circuits/ (kya_predicate_count_v1.circom) and build/ (verification_key.json committed; the proving key is rebuilt locally)
docker/, docker-compose.yml
docs/                design memo, compatibility matrix, version lock, build, world, doctor, cell account, kernel, genesis, zk
scenarios/skills/    the two ERC-8338 skill packages of the genesis: foga-probe, finch-extract-verify
scenarios/fixtures/  the pinned document finch-extract-verify works on in T5 and T7
scripts/             install-solc.sh, install-foundry.sh, relay.mjs
src/                 TypeScript: build/ (vendor + bundle), world/ (plan + deploy), doctor/ (probe + evaluate),
                     core/ (foga-core: one module per ERC incl. acdf, adrf and swarm, measure, canonicalization, DAG-CBOR packager),
                     kernel/ (store, transaction manager, cell, kernel), genesis/ (roles, operator scope, probe, extract, skill worker, zk, scenario T0-T3, t3-zk, t4..t9, runner),
                     node/ (the node's one key), cli.ts
test/                unit tests: bytecode and interface ids, skill packages, canonicalization, operation store, transaction semantics against an in-process chain (mock-chain.ts), keys, swarm/ACDF vectors, extractor, measurement resolver, doctor layer 5
vendor/              LOCK.json (sources are materialized here and gitignored)
worlds/              world configs: local.json (deploy), sepolia.json (attach)
```

## Commands

```
foga vendor sync | verify
foga build [--verify] [--solc-dir <dir>] [--only <repo,repo>]
foga bundle info
foga world deploy --world <config> [--rpc <url>] [--out <file>] [--resume] [--gas-multiplier <x>] [--allow-chain-mismatch]
foga world attach --world <config> [--out <file>]
foga doctor --world <world|config> [--attach] [--rpc <url>] [--out <report>] [--export-probe <file>] [--import-results <file>] [--genesis <evidence>]
foga probe relay-script
foga genesis run --world <world> [--rpc <url>] [--until T0..T9] [--store <file>] [--out <evidence>] [--zk auto|require|skip] [--crash-after <key>] [--crash-before <key>]
foga genesis status --world <world> [--store <file>]
foga keys new [--out <file>] | show | export --role <role> [--out <file>] | check
foga demo [--port <n>] [--keep] [--genesis <T0..T9>]
```

During development the CLI runs from source with `npm run foga -- <args>`; `npm run build` compiles it to `dist/` for the `foga` binary.

## Principles

- The ten reference implementations are used as they are. Gaps found while composing them go back upstream as separate changes; FOGA keeps no forks.
- Compile conditions are never changed by FOGA, only orchestrated. The bundle records compiler, settings, source hashes and build inputs so anyone can rebuild it.
- A world file names its chain, its bundle hash, its deployment batch and, for forks, the source block, so two local chain-id-31337 worlds cannot be confused.
- Every claim the doctor makes carries one of five verdicts; a green ERC-165 probe is never presented as full compatibility.
- A cell acts only through its account, and the account acts only through its gate. The kernel sends every operation once, records it before broadcasting it, and asks the chain before retrying.

## License

Apache-2.0 for the code in this repository. The compiled artifacts in `artifacts/bundle.json` are built from the upstream repositories, which are CC0-1.0 (ARD material vendored upstream is Apache-2.0); see NOTICE.
