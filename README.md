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

## Status: Phase 3 done (0.6.0, 2026-11-05) — the OG live at foga.finchip.ai, the MCP registry listing, the Sepolia Loop D with an outside agent; 3d-2 (the wallet, signed callers, the documents on chain, preflight, A2A, Sourcify), 3d-1 (quickstart, an outside agent's Loop D), 3c (Loop D with a model), 3b (MCP and HTTP), 3a (the kernel as a node) all done

**3d-3 (0.6.0, 2026-11-05).** Phase 3 closes with the reference cell served and the last acceptance run on the public chain. The OG was born fresh on Sepolia by the path any cell takes (`wallet new`, `cell new`, `cell init`, `docs publish`, `node serve` — one key, no migration; docs/og-deployment.md): agent 11261, its skill offered, its documents on chain, its fifteen contracts Sourcify-verified; it is served in host mode under systemd behind Caddy at `foga.finchip.ai` and listed in the MCP registry as `io.github.garyyang-finchip/foga`. Loop D with an outside agent ran on Sepolia and every invariant row passed (docs/loop-d.md, "On a public chain"); what the public chain taught is fixed in this release — a working directory is one run, role funding is priced with a floor, the settlement figure is the tender's own, a log scan is windowed. `foga cell advise` (`src/node/advise.ts`) tells a running cell what to do next — separate the one key into owner, operator and guardian first — and the recommended items print after a quickstart, a birth and at serve; the first run stays minimal on purpose. The covenant list is read off the world (an eleventh covenant appears with no code change) and the manifest carries a `services` slot — the maintainer's catalog, declinable, served by the reference cell at `/services.json` — docs/extending.md. 107 tests.

**3d-2 (0.6.0-alpha.7, 2026-11-03).** The second slice of 3d is what a cell needs to stand on its own among other agents, under one principle (docs/design-memo.md, section 10): the wallet is the first step, made by default and never a reason to stop; identity is one's own; only the genome replicates. `foga wallet new` (`src/node/wallet.ts`, docs/wallet.md) makes an agent's keys on its own machine — by default one key in a 0600 file under `~/.foga/wallet` — the identity that fills every role a cell needs; `--cell` for the separated owner/operator/guardian set — never overwritten, no network — and `foga quickstart` makes the default wallet on its first run and births every later cell with the same keys; `--wallet <dir>` on every `foga cell` and `foga node` command takes a role's key from there. A wallet is also a credential: `Authorization: FOGA-EIP712 <envelope>` (`src/http/signed.ts`, `src/http/access.ts`) is an EIP-712 signature in the cell's own domain — bound to one request and good once, or a session for a client with static headers — and the caller is the signing address at the level `access.signers` grants it (the cell's own operator or owner, an allow-list by address or ERC-8004 agent id, a KYA standing threshold, a default); `/api`, `/mcp` and `/a2a` take it, `foga wallet sign` prints it, and every cell's MCP server carries the prompt `become-a-cell` and the resource `foga://docs/quickstart` for an agent that meets it. `foga cell docs build | publish | status` (`src/node/documents.ts`, docs/documents.md) generates the cell's documents from one configuration — the ERC-8004 registration, the ERC-8434 AID document, the ERC-8444 descriptor, the ERC-8454 unit, the A2A agent card, `server.json`, a manifest with content hashes — serves them at `/documents/*` and `/.well-known/*`, and commits them on chain as the operator's keyed job (`setAgentURI`, `setDocumentURI`, `updateDescriptor`, `publishVersion`; only what differs is sent), read back and cross-checked; `docs_status` and `docs_publish` are the catalog's 30th and 31st capabilities. `foga node preflight` (`src/node/preflight.ts`) is the readiness reconciliation — the world, the account and its allow-list, the budget, the keys, the standing, the skills run in the worker, the documents against the chain, the public URL, the model — advisory, `--strict` for CI. `POST /a2a` (`src/a2a/`, docs/a2a.md) is the A2A 1.0 JSON-RPC binding with the card at `/.well-known/agent-card.json`: a quote for anyone, a tender taken for an act-level caller as one task over the catalog's jobs, `GetTask`, `ListTasks`, `CancelTask`, errors by the specification. `foga world verify --sourcify` (`src/world/sourcify.ts`, docs/world.md) submits every FOGA-deployed contract of a world with the standard JSON input of its own compiler run (`forge build` now leaves the build-info beside the artifacts), matched by runtime code; a local chain is a dry run, which CI runs over all 47. The OG instance's default is host mode (`foga node serve`: every entrance, the watchers, no model) with embedded mode (`foga node run`, the runner with a model) on demand. Seven new tests on anvil and offline (`wallet`, `signed`, `documents`, `a2a`, `preflight`, `sourcify`, and `quickstart` extended) are the gate; `foga quickstart` now ends with a cell whose documents are on chain, whose card answers, and whose A2A entrance quotes. Next, 3d-3: the OG deployment runbook, `foga.finchip.ai`, the registry listing, the Sepolia Sourcify run, the OG cell's migration to revision 2 and an outside agent's Loop D on Sepolia.

**3d-1 (0.6.0-alpha.6, 2026-11-02).** The package is on npm as `@finchip.ai/foga` (0.6.0-alpha.4 and alpha.5, the latter with the launcher fixed for Windows), so the first slice of 3d is the two things that make it usable from nothing. `foga quickstart` (`src/demo/quickstart.ts`, docs/quickstart.md) is one command to a live cell: anvil, the local world, a cell born with keys nobody held and its two skills, two tenders minted for it, the node served (watchers, HTTP API, MCP over Streamable HTTP), both entrances checked (the handshake and tool list over HTTP with an act-level key, and over stdio with the operator key), and the MCP client configurations — Claude Desktop, Claude Code, Cursor, and the HTTP form with URL and Bearer key — printed and written with every path filled in, under `~/.foga/quickstart`. Loop D gains `--model external` (docs/loop-d.md): the node is served instead of run, an act-level key is minted for whoever proposes, the orchestrator prints a brief (the entrance, the five steps of a tender, what the run does around the agent — nothing about the cases) and waits for the agent — any model, any runtime, a person with `curl` — with the same recovery drill, the same entrance checks and the same acceptance; the evidence names the agent and carries no runner ticks, the doctor marks a case the agent left alone `NotTested` rather than `Fail`, and `--compare` skips what one run did not reach. `test/loop-d-external.test.ts` drives it with a scripted agent through the MCP entrance and every verdict passes, the model-agnostic row included against the kept stub run. Smaller: `.gitattributes` keeps every text file LF (the launcher's shebang included), a `prepare` script compiles a checkout installed straight from git, the shared cell birth (`src/demo/birth.ts`) and anvil helpers (`src/demo/anvil.ts`) serve the demos, and the docs carry the PowerShell and Windows notes. Next in 3d: `foga node preflight`, `docs build/publish` with `setAgentURI`, the A2A card and inbound mapping, Sourcify, then the OG deployment runbook, the documentation site and the registry listing.

**3c (0.6.0-alpha.4, 2026-11-02).** A model in the loop, and the acceptance that looks at records rather than words. `src/node/runner.ts` is the node's loop with a model: each tick perceives through the read capabilities, hands the situation and the catalog as tools to the model, carries out what it proposes — reads at once, acts through `Catalog.invoke` where the three checks decide and a refusal goes back so the model can revise once — and records the tick by hash (the decision records carry the model and the hashes of its request and answer; the journal the hash of the whole transcript; the text never). Limits bound a tick (12 tool calls, 2 acts) and a day (the model's calls, counted in the store). Two adapters on one interface: `anthropic` (the Messages API over `fetch`, the key in the environment, the model name in the configuration) and `stub` (a deterministic decision table that also proposes, once, a tender above the budget so the evidence shows the gate closing). `foga node run` is the embedded node — server, watchers, runner — on the operator key alone. `foga demo --loop-d` (`src/demo/loop-d.ts`) is the unscripted run: a new cell with fresh keys, an independent demander process minting cases a–f in a seeded order (two tenders to take, four to refuse at `skill`, `policy`, `verifier`, and one met during the guardian's suspension), the node killed after its first submission and restarted, the HTTP entrance used beside the runner (the same request answered once, the same job under another request a conflict, three mints at once of which the third is refused at `budget` before anything is sent), and an evidence file with every record, the cases' outcomes and a scan of every transaction the operator key signed. `foga doctor --loop-d` judges it beside layer 5: every operation under an allowed decision, refusals that broadcast nothing, the four budget books, the operator's transactions all at the account and allow-listed, the cases as expected, the recovery, the entrances, and — given two runs — the same outcomes from the stub and a real model. The slice also closed a race the run exposed: the catalog's decision section now runs one act at a time per node and a job reserves the value it will move from its decision. `test/loop-d.test.ts` (anvil, under a minute) and `test/model.test.ts` are the gate; CI runs Loop D on the world the genesis ran on. docs/loop-d.md.

**3b (0.6.0-alpha.3, 2026-11-02).** The catalog gets its second and third entrances. `src/mcp/server.ts` builds one MCP server per caller from the catalog with the official TypeScript SDK v2: the tool list is what the caller may see and do (a write capability is up to three tools over one handler — `<name>` acts, `<name>_simulate` runs every check and sends nothing, `<name>_build` returns the calls for the caller's own account — with static annotations), results are `structuredContent` under the capability's output schema, a refused act is a tool error carrying the gate, the reason and the decision record's id, an ineligible pre-check an ordinary `eligible: false`; resources for the world, the cell, the policy, the FOGA-Cell-v1 specification and the compatibility matrix; one prompt. Both protocol eras are served on both transports — the 2026-07-28 revision (`server/discover`, no session) as the main path and the 2025-era `initialize` handshake in stateless form — and `foga node mcp` serves a local client over stdio (the operator with the key, a build-level local user without). `src/http/server.ts` is the HTTP entrance on `node:http`: `/mcp` over Streamable HTTP, `POST /api/<capability>`, the health and front pages, the public without a credential (reads and builds) and `Authorization: Bearer <key>` for a grant the operator minted with `foga node key new` (stored as its hash alone); the edge checks Host, Origin, body size, content type and a per-address rate, maps permission refusals to 403 and business refusals to `200 {ok: false, gate, reason, decisionId}`. `foga node serve` runs it with the watchers beside it. The gate of the slice is `test/mcp.test.ts`: on anvil, the reference client pinned to 2026-07-28, in legacy mode and in auto mode, over HTTP and stdio — the public's tools, the key holder walking a tender from pre-check to settlement with the reward reaching the account, idempotency and conflict on the wire, every edge refusal. `scripts/pack-smoke.mjs` (a CI step) installs the npm tarball in a clean directory and runs the packaged CLI and MCP server from there; `package.json` carries `mcpName` and `server.json` the registry manifest for the publication in 3d. docs/mcp.md.

**3a-2 (0.6.0-alpha.2, 2026-11-02).** The kernel becomes a node other agents can call. `src/tools/` is the capability catalog — 28 capabilities on the Loop D path, each declaring its action (read, build, act, admin), the visibility of its data (public, caller, operator) and whose act it is — and `Catalog.invoke` is the one place authorization happens: call permission, business authorization through the policy engine (anchor and binding, skill held and offered, reward and deadlines, acceptance authority, budget), wallet permission by simulating the account's own gate; every attempt to act, allowed or refused, is a decision record naming the gate. Jobs are the business unit and operations the chain writes under them; the same job is answered once, a failed one with its failure, the same job under another request as a conflict. `src/node/` is the runtime: one `cell.config.json`, the node over the kernel holding the operator key alone, `foga cell init` (a cell's birth from its config, T1 for one cell), `foga cell migrate` (the move to a new revision-2 account, T9 for one cell), the watchers (heartbeat, tender discovery, settlement, safety). The CLI (`foga cell …`, `foga node …`) is generated from the catalog. The gate of the slice is `test/node-cli.test.ts`: on anvil, through the CLI and without the genesis script, a cell is born, mints its skills and meets the seven Loop D cases — two tenders taken and settled, five refused at the right gate (skill, policy, verifier, safety during a suspension and allowed after the resume, budget) — then moves to a new account. docs/node.md.

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

What is next: 3d-3 closes Phase 3 — the OG instance's move to a revision-2 account with public endpoints (`foga.finchip.ai`), its documents and sources verified on Sepolia, the registry listing and an outside agent's Loop D run on Sepolia; Phase 4 the hosted node and payments. The design is in docs/design-memo.md.

## Quick start

With Node 22.13+ and Foundry's `anvil` installed, one command makes your wallet (on the first run; `~/.foga/wallet`, reused after), births a cell with it on a local chain, publishes the cell's documents and prints the MCP client configuration to connect to it (docs/quickstart.md; in PowerShell quote the name: `npx -y '@finchip.ai/foga' quickstart`):

```bash
npx -y @finchip.ai/foga quickstart
```

The wallet alone, for an agent that will only call cells (docs/wallet.md), and a cell on a public chain born with it:

```bash
npx -y @finchip.ai/foga wallet new                       # ~/.foga/wallet: one key (your identity, every role); prints the address to fund. --cell for the separated owner/operator/guardian set
foga cell new --wallet ~/.foga/wallet --name mine --world deployments/sepolia.json --store mine.sqlite --out mine.json
foga cell init --config mine.json --wallet ~/.foga/wallet
foga node preflight --config mine.json --wallet ~/.foga/wallet
foga node serve --config mine.json --wallet ~/.foga/wallet
```

From a checkout, three ways in, from most to least demanding:

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
deploy/              the OG host assets: foga-og.service (systemd, host mode), Caddyfile, og.env.example (docs/og-deployment.md)
site/                 the documentation site for GitHub Pages (docs.foga.finchip.ai): index.html, llms.txt, CNAME
docs/                design memo, compatibility matrix, version lock, build, world, doctor, cell account, kernel, genesis, zk, node, mcp, loop-d, quickstart, wallet, documents, a2a, og-deployment; examples/ (client configurations)
scenarios/skills/    the two ERC-8338 skill packages of the genesis: foga-probe, finch-extract-verify
scenarios/fixtures/  the pinned document finch-extract-verify works on in T5 and T7
scripts/             install-solc.sh, install-foundry.sh, relay.mjs, pack-smoke.mjs (the npm tarball run from a clean install)
src/                 TypeScript: build/ (vendor + bundle), world/ (plan + deploy), doctor/ (probe + evaluate),
                     core/ (foga-core: one module per ERC incl. acdf, adrf and swarm, measure, canonicalization, DAG-CBOR packager),
                     kernel/ (store, transaction manager, cell, kernel), genesis/ (roles, operator scope, probe, extract, skill worker, zk, scenario T0-T3, t3-zk, t4..t9, runner),
                     tools/ (the capability catalog: types, catalog, read, tenders, identity, documents, admin), node/ (config, keys, wallet, node, policy, init, migrate, watchers, documents, preflight),
                     mcp/ (the MCP server built from the catalog), http/ (the HTTP API, MCP over Streamable HTTP, API keys, signed callers), a2a/ (the A2A 1.0 binding and card),
                     node/runner.ts and node/model/ (the runner, the stub and anthropic adapters), demo/ (the Loop D demander, orchestration and evidence, quickstart), world/sourcify.ts,
                     cli.ts, cli-cell.ts (foga cell / foga node)
test/                unit tests: bytecode and interface ids, skill packages, canonicalization, operation store, transaction semantics against an in-process chain (mock-chain.ts), keys, policy gates, catalog, cell config, swarm/ACDF vectors, extractor, measurement resolver, doctor layer 5, sourcify; node-cli.test.ts (the Loop D cases through the CLI on anvil), mcp.test.ts (the entrances over MCP and HTTP on anvil; helpers/anvil-cell.ts births the cell), model.test.ts (the stub's table, the Anthropic adapter against a stand-in API, the Loop D verdicts), loop-d.test.ts (the unscripted run with the stub on anvil), loop-d-external.test.ts, quickstart.test.ts, wallet.test.ts, signed.test.ts, documents.test.ts, a2a.test.ts, preflight.test.ts (3d, on anvil)
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
foga world verify --world <world.json> --sourcify [--dry-run] [--only <id,id>] [--server <url>] [--out <dir>] [--build-info <dir>]   source verification from the bundle's own compiler runs
foga doctor --world <world|config> [--attach] [--rpc <url>] [--out <report>] [--export-probe <file>] [--import-results <file>] [--genesis <evidence>]
foga probe relay-script
foga genesis run --world <world> [--rpc <url>] [--until T0..T9] [--store <file>] [--out <evidence>] [--zk auto|require|skip] [--crash-after <key>] [--crash-before <key>]
foga genesis status --world <world> [--store <file>]
foga keys new [--out <file>] | show | export --role <role> [--out <file>] | check
foga wallet new [--name <n> | --dir <dir>] [--cell] | show [--rpc <url>] | sign (--config <cfg> | --url <node> | --cell <acct> --chain-id <n>) [--role] [--ttl <s>] [--agent-id <id>] [--method --path [--body]]
                                                                          an agent's own key (the first step; --cell for the separated owner/operator/guardian set), and a signed Authorization header for a cell
foga demo [--port <n>] [--keep] [--genesis <T0..T9>]
foga cell list [--public] | schema <capability>
foga cell new --name <cell> --world <world.json> --store <ops.sqlite> --out <cell.config.json> (--wallet <dir> | --owner <addr> --operator <addr> --guardian <addr>)
foga cell init --config <cell.config.json> [--wallet <dir>] [--capital-wei <n>]          (owner key)
foga cell migrate --config <cell.config.json> --to <new.config.json> [--operator <addr>]   (owner key)
foga cell docs build | publish | status --config <cell.config.json> [--wallet <dir>]     the cell's documents, served and committed on chain (publish: operator key)
foga cell <capability> --config <cell.config.json> [--wallet <dir>] [--mode simulate|build|act] [--<field> <value> ...] [--json '<input>']
foga node preflight --config <cell.config.json> [--wallet <dir>] [--no-executors] [--no-network] [--out <report.json>] [--strict]   the readiness reconciliation; sends nothing
foga node tick | watch --config <cell.config.json> [--interval <s>]      (operator key alone)
foga node mcp --config <cell.config.json>                                 MCP over stdio (= foga mcp; the operator with FOGA_OPERATOR_KEY[_FILE] or --wallet, reads and builds without)
foga node serve --config <cell.config.json> [--listen <host:port>] [--no-watch]   host mode: the HTTP API, /mcp, /a2a, the documents, /healthz, the watchers; no model
foga node key new --config <cell.config.json> --id <id> [--level read|build|act] [--visibility public|caller|operator] [--note <text>]
foga node run --config <cell.config.json> [--model stub|anthropic] [--listen <host:port> | --no-http] [--interval <s>] [--once | --ticks <n>] [--transcripts <dir>]
                                                                          the embedded node: server, watchers and the runner (operator key alone)
foga demo --loop-d [--model stub|anthropic|external] [--model-name <name>] [--seed <n>] [--no-recovery]   anvil, the world, then Loop D judged by the doctor
foga loop-d run --world <world.json> --rpc <url> [--dir <dir>] [--out <evidence.json>] [--model] [--model-name] [--seed] [--no-recovery] [--listen] [--wait <s>] [--idle <s>]
foga doctor [--world <world.json>] --loop-d <evidence.json> [--compare <evidence2.json>] [--out <report.json>]
foga quickstart [--dir <dir>] [--wallet <dir>] [--port <n>] [--listen <host:port> | --no-serve] [--name <cell>] [--no-tenders] [--exit]   one command to a live cell (the wallet first) and its client configuration
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
