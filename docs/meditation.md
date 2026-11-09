# The cell's own maintenance (ERC-8490: foga meditate …)

A cell that lives for months changes: the program is upgraded, dependencies move, skills are minted, the policy is tuned, work comes and goes, the store grows. ERC-8490 (the Agent Meditation Mechanism, an eleventh covenant and an *extension* in 0.8.0 — docs/extending.md) gives that change a registered shape: the agent maintains itself across four fixed layers — **runtime** (0), **memory and skills** (1), **tasks and roles** (2), **cognition** (3) — commits to a state document per layer, and records each maintenance cycle in a registry that keeps the commitments, a state version, and a timeliness per layer. The registry never sees the documents; the agent keeps them, and anyone given them can re-derive every hash on chain.

FOGA runs this as `foga meditate …` (the catalog's `meditate_*` capabilities, `src/tools/meditation.ts`), with the documents built by `src/node/meditation.ts`, the cycle by `src/node/meditation-cycle.ts` and the registry read and written by `src/core/amm.ts`. The 0.8.0 slice is the **manual, recoverable, recomputable cycle**: a cycle runs when commanded, survives an interruption anywhere, and leaves a record from which a reviewer recomputes what the chain holds. Automatic cycles (the watcher) come in the next slice.

## What is registered, and what it means

| On chain (the registry) | What it is | What it is not |
|---|---|---|
| `stateVersion`, `root` | the version of the cell's registered state and the root over its four layer commitments; the version moves only when a commitment changed | a count of cycles (that is `recordCount`) |
| `checkpointOf(layer)` | the layer's commitment, when a routine last completed (`lastCompletedAt`), at which version it last changed | the document (kept by the cell, served at `/documents/maintenance/state/`) |
| `layerStatus(layer)` | **FRESH** / **DUE** / **OVERDUE**: the time since the last completed routine against the policy's interval, a controller's floor or demand; `neverCompleted` while no routine completed since enrollment | a judgment of correctness: FRESH means a routine completed in time; the cycle record says what the routine checked and what it changed |
| `signalStatus` | PRESENT / SILENT against a pulse interval, when one is in force; NOT_TRACKED otherwise (FOGA's default) | liveness in the ERC-8434 sense (that is the anchor's heartbeat) |
| policy version | the fields the cell declared: supported and required layers, allowed triggers, disclosure, due window, pulse interval, per-layer maximum intervals | a budget: the policy and the floor say nothing about money or gas; FOGA's budgets are the node's (`policy.budget`, `maintenance.gasPerReport`) |
| controller | the guardian (default), with the rights to set a floor, demand a cycle by a deadline, and revoke registry operators | an owner of the state: the controller cannot change a commitment or the policy |

**The honest reading** of a FRESH row is "the cell's own routine for that layer completed within its interval, and here is the record"; the record (`/documents/maintenance/cycles/<id>.json`) lists the checks, their results, the changes made and the candidates not made. `meditate_status` and the card say this in so many words.

## The four documents

Each layer's state document is built from the cell's *stable* state and nothing that moves on its own between two cycles — no balances, block numbers, operation counts, timestamps, and nothing of the maintenance registry's own versions or roots (a document that referred to the registry's state could never settle). A document that changes only when the cell changes is what makes the version mean something.

| Layer | Schema | Built from | Changes when |
|---|---|---|---|
| 0 runtime | `amm.layer.runtime/1` | the program version and platform, the contracts bundle hash, the installed versions of `ethers`, `zod`, `@modelcontextprotocol/server`, the adapters (RPC chain and world, model provider and limits, HTTP face), the account's roles and revision from the chain, the operator scope groups, the self-check suite | the program or a dependency is upgraded, a role rotates, the model or the public URL changes |
| 1 memory-skills | `amm.layer.memory-skills/1` | the store's shape (not its size), the skills held with token ids and package hashes and whether offered, the harness (skills and input directories, timeout, executors) | a skill is minted, updated or offered |
| 2 tasks-roles | `amm.layer.tasks-roles/1` | the roles the operator scope allows (fulfiller, demander, …), the maintenance plan, the tenders submitted and not yet settled (from the store's jobs), the terms (tender policy, budget caps, the safety specification and binding), the services (documents manifest hash, endpoints, offers) | the policy or the scope changes, a tender is taken or settled, documents are rebuilt |
| 3 cognition | `amm.layer.cognition/1` | the self-model (capabilities, limits, resources, applicability), the assumptions the program runs on, its judgment strategies and reflection methods, the hash of the maintenance policy document | the program's assumptions change (a release), the policy changes |

Layer commitment: `keccak256(abi.encode(TAG_LAYER_COMMITMENT, uint8 layer, keccak256(schemaId), keccak256(JCS(document)), salt))`; root: `keccak256(abi.encode(TAG_STATE_ROOT, c0, c1, c2, c3))`. The salts are fixed at enrollment in `<maintenance.dir>/salts.json` (zero by default: the documents are public; an operator who wants a layer private puts a random 32-byte salt there before enrolling) and are never served. `test/amm.test.ts` holds this hashing to the ERC's published vectors byte for byte.

## A cycle

`foga meditate run --config <cfg> [--wallet <dir>] [--layers 0,1,2,3] [--trigger commanded|scheduled|event|self] [--detail <text>] [--dry-run] [--job-id <id>]` is the capability `meditate_run` (an act of the cell through its account; the operator key). In order:

1. **Reconcile.** What an earlier cycle left behind is settled first, from the store and the chain, before anything is decided: a report that was mined while the node was away completes that cycle (its job is marked done from the receipt, its documents become the registered state); one still pending blocks a new cycle unless the same job is named (`--job-id`, which resumes it); one that failed, or a cycle interrupted before its report was sent, is superseded. Nothing is sent here.
2. **Begin.** The pre-state is what the registry holds now — head, four checkpoints, the registry's clock — never what the node remembers. The cycle's job id derives from the layers, the trigger, the state version and the record count, so an interrupted cycle is the same job on the next command and a finished one is followed by a new cycle.
3. **Execute locally.** The routine of each scoped layer runs (below); the four documents are rebuilt from the cell as it is; the post commitments are the rebuilt documents' for layers whose routine completed and the pre commitments for the others (a layer out of scope must carry its pre commitment; the registry refuses anything else). A layer whose document differs from the registered one is **adopted**, one that does not is **kept**, one that formed candidates and adopted nothing is **candidate**, one whose routine threw is **failed**. The outcome follows the completed set — COMPLETED, PARTIAL, FAILED — by the routines that completed, not by what changed. The cycle record (`amm.cycle-record/1`) and the report struct are frozen in the store under `meditation.cycle.<id>` and the record is written to `<maintenance.dir>/cycles/<id>.json`.
4. **Report.** One step, `report(subject, CycleReport)`, through the account under the operator's `maintenance` scope (gate checks: the policy supports the layers and allows the trigger; the safety gate; the budget with `maintenance.gasPerReport` reserved; a simulation). The completion time is the registry's clock when the local work ended, raised past any layer's recorded completion when two cycles meet in one block; the step waits for the chain's clock to reach it rather than send a report the registry would refuse.
5. **Confirm.** The `CycleRecorded` event gives the new version; the rebuilt documents of the adopted layers become the registered state (`meditation.state`, `<maintenance.dir>/state/<layer>.json`), the lock is released, `<id>.report.json` is written beside the record.

A `--dry-run` (simulate mode) does steps 2 and 3 in memory and shows the cycle — outcome, adoption per layer, checks, candidates, the record — sends nothing and keeps nothing. The report of a cycle that does not pass a gate is a refusal with a decision record, like any act; a cycle whose report was broadcast and not mined within the kernel's patience is answered at the `pending` gate with the job still running (exit code 3 on the CLI), and the same command, or the same `--job-id`, resumes it.

**Resumable, exactly.** Every phase is a fact; the report is rebuilt from the frozen struct, so a resumed cycle sends the very calldata it computed, and the kernel's rules hold — a `sent` operation is resolved from the chain before anything else is sent, nothing is sent twice. `baseVersion`/`preRoot` in the report are the registry's guard against a stale cycle, not a uniqueness guarantee: a report that reverts with `BaseVersionMismatch` (another report landed first) ends that cycle as failed and the next command computes afresh against the new head.

**Recomputable, by anyone.** Given the record and the four documents (served, by default), `recordHash = keccak256(JCS(record))`, each commitment and the root are re-derived with `src/core/amm.ts` and compared with the chain; `test/meditation.test.ts` does exactly that after every cycle.

## The routines (0.8.0)

What a cycle may change on its own is bounded by what the node may do alone: its documents and its store. Everything else it finds becomes a **candidate** in the record, for the owner or the operator to act on through the capability that governs it — never adopted by the cycle.

| Layer | Checks | Changes it makes | Candidates it forms |
|---|---|---|---|
| 0 runtime | the account's roles against the configuration; the account's revision; every `(target, selector)` of the node's scope groups allowed; the dependencies resolved; the endpoint's chain; the bundle of record (the world's against the program's, recorded, never raised) | the runtime document, as it is (an upgrade is an `update` the operator made, registered here) | `allow-list-completion` (the owner's `scope_complete`) |
| 1 memory-skills | every held package rebuilt and compared with its token's commitment; every offered skill held; SQLite `quick_check`; a write-ahead log checkpoint (`clean`: nothing is dropped) | the memory-skills document; the checkpoint | `skill-package-mismatch` (the operator's `skill_mint` or a restored directory) |
| 2 tasks-roles | the tenders submitted and unsettled in the store against the chain (settled or cancelled there is a finding); the built documents against the chain's commitments; the roles | the tasks-roles document | `in-flight-reconciliation` (the runner's `tender_settle` / `tender_withdraw`), `documents-publish` (`docs_publish`) |
| 3 cognition | the decisions of the last seven days by gate and verdict; the assumptions restated | the cognition document | `refusal-pattern` when most of what was asked was refused |

Observations a layer takes on the way (balances, store pages, job counts, the decision window) go into the record's `observations` and are not part of any commitment.

## Enrollment, policy, controller

**At birth** (`foga cell init`, `foga join`) on a world whose file carries `8490/AgentMeditationRegistry`, the owner enrolls the cell through its account as the last step: the baseline is the four documents as they are at birth, the policy is `maintenance.policy`, the controller is the guardian with `maintenance.controllerRights` (7: floor, demand, revoke operators) — or none, with `maintenance.controller: "none"`. The operator's scope gains the `maintenance` group (`report`, `pulse`) in the same `setOperatorAllowedBatch` as the rest. `enroll`, `setPolicy` and `setController` are the owner's acts through `execute`; they are not in the operator's scope, and no permission is granted to the operator's address on the registry itself — one authorization path, the account's.

**A running cell** (born before 0.8.0, or on a world file written before the registry was known) is extended in place: `foga cell extend --covenants 8490 --config <cfg> [--wallet <dir>] [--rpc <url>] [--registry <addr>]` adds the registry to the cell's world file (from the packaged world of its chain, or the address given, checked for ERC-165 `0x9c81b550` when an RPC is at hand; the file before is kept as `world.json.before-8490.bak`), then the owner opens the `maintenance` scope and enrolls in one keyed job (`meditate_enroll`), completes the allow-list (`scope_complete`) and reads the registry back. Idempotent: run again, it says what is already so and sends nothing. The identity, the account, the store and the documents are untouched — an extension, not a migration (`foga cell migrate` is for a new account).

**The policy** (`maintenance.policy` in `cell.config.json`): `supportedLayers` and `requiredLayers` (15), `allowedTriggers` (15), `disclosure` (2: the policy, the state documents and the cycle records are served; 1: records and policy; 0: nothing), `dueWindow` (3600 s), `pulseInterval` (0: not tracked), `maxInterval` (`[86400, 604800, 2592000, 7776000]`: daily, weekly, monthly, quarterly). The policy document (`amm.policy/1`) carries these fields with the routines above and is served at `/documents/maintenance/policy.json`; its hash is on chain. `foga meditate policy` (the owner) records a changed configuration as a new policy version; a cycle begun under the old version reports under it.

**The controller.** With a controller set, only the controller may transfer the role (rights a subset of its own), shrink it, or renounce it; the subject cannot change it. The rotation of a guardian is therefore the outgoing guardian's `foga meditate controller --to <new> [--rights 7]` (the guardian key), done when the guardian is rotated; a cell enrolled without a controller appoints one with the same command and the owner key. `foga meditate demand --layers 0 --due-in-seconds 86400` and `foga meditate floor --required-layers 15 --max-interval …` are the controller's own transactions (the guardian key); a demand makes the layer DUE then OVERDUE against its deadline until a completion at or after the demand clears it.

## Where things are

```
<config dir>/<maintenance.dir>/            (default: meditation/)
  policy.json                              the policy document; hash on chain
  salts.json                               the four salts; never served
  state/<n>-<layer>.json, state/root.json  the registered state documents and their root/version
  cycles/<id>.json                         the cycle record (amm.cycle-record/1); recordHash on chain
  cycles/<id>.report.json                  the report struct as sent, the result, the submitter
```

The store's facts are the source of truth (`meditation.policy`, `meditation.salts`, `meditation.state`, `meditation.lock`, `meditation.lastCycle`, `meditation.cycle.<id>`); the files are the same material laid out for people and for the node to serve under `GET /documents/maintenance/{policy.json,state/<file>,cycles/<file>}`, as far as the policy's disclosure goes. The propagation manifest carries a `maintenance` block (registry, where the documents are, the disclosure) when the world has the registry, and the card an `upkeep` line.

## The permission table

| Call | Who signs | Route | On the registry, msg.sender is | Scope / class |
|---|---|---|---|---|
| `enroll` | owner | the account's `execute` | the cell account (the subject) | owner's act; not in the operator's scope |
| `report`, `pulse` | operator | the account's `execute` | the cell account | `maintenance` scope group; plain class (no commitment, no de-risk) |
| `setPolicy` | owner | `execute` | the cell account | owner's act |
| `setController` (appoint, none set) | owner | `execute` | the cell account | owner's act |
| `setController` (transfer, shrink, renounce) | guardian | direct | the guardian (the controller) | the controller's own transaction |
| `setFloor`, `demand`, `withdrawDemand` | guardian | direct | the guardian | the controller's own transaction |
| `setOperator` on the registry | — | — | — | not used: no second authorization path |

**A one-key cell** (owner = operator = guardian, the default of `foga wallet new` and `foga join`) is the one case where the owner's acts meet the allow-list: `FogaCellAccount.execute` scope-checks `msg.sender == operator` first, and the owner *is* that address. So for such a cell alone the three owner pairs — `enroll`, `setPolicy`, `setController` on the registry (`OWNER_EXECUTE_SCOPE`, `src/genesis/operator-scope.ts`) — are opened at birth, by `meditate_enroll` and by `scope_complete`, and `operator_rotate` closes them in the same job when the roles separate (and opens them again when they rejoin). A separated cell's operator never holds them; the preflight and the runtime routine say so when one does. The guardian of a one-key cell is the same key, and it is a valid controller: the registry refuses only the subject itself, which is the account.

Gas, as the upstream Sepolia run measured it: `enroll` about 2.3 M (the first write of every slot and the policy's strings), `report` 0.23–0.31 M, `setPolicy` 0.6 M, `pulse` 0.05 M; through the account add the `execute` overhead. The budget gate reserves `maintenance.gasPerReport` (600 000) per report and the enrollment plan 2.6 M; the estimate at send time sets each transaction's own limit.

## Over MCP and HTTP

`meditate_status` is a public read; `meditate_run` and `meditate_pulse` are acts the operator's view sees, so an MCP client with the operator key, or an HTTP caller whose grant reaches act and operator visibility, runs a cycle with the same gates and records as the CLI. The admin capabilities (`meditate_enroll`, `meditate_policy`, `meditate_controller`, `meditate_demand`, `meditate_floor`, `scope_complete`) are CLI-only, like every owner's and guardian's act; the MCP server never lists them.

## Doctor and preflight

The registry enters a world under `8490/AgentMeditationRegistry` (`foga world deploy` deploys it from the bundle on a chain without one; `worlds/sepolia.json` and the packaged Sepolia world attach the upstream instance at `0x184dF595404414f91aD11986C47B9a539eF9559f`), so the doctor's layers 1–2 and the `CLOCK_MODE` readout cover it like any other contract, and layer 5 reports ERC-8490 `NotTested` until a scenario exercises it (4c). `foga node preflight` adds a `maintenance` area: enrolled; the registered documents kept here are the ones on chain; no layer overdue; no cycle left half-way.
