# The cell kernel (foga-kernel)

`src/kernel/` is the deterministic part of a node: it holds the keys, decides what to send, sends each thing once, and keeps the record a reviewer or a restarted process needs. There is no model inside it. `src/core/` (foga-core) underneath is one module per ERC — views, calldata builders, event decoders, canonicalization and the DAG-CBOR skill packager — with no transaction management of its own.

## Pieces

| File | What it is |
|---|---|
| `kernel/store.ts` | `OperationStore`: the operation table, scenario facts and an append-only journal in one SQLite file (`node:sqlite`, WAL, `synchronous=FULL`). `:memory:` for tests. |
| `kernel/tx.ts` | `TxManager`: exactly-once sending by idempotency key, receipt recovery, re-send and fee-replacement rules, fault injection. |
| `kernel/cell.ts` | `Cell`: one FogaCellAccount driven through its owner and operator keys (`deploy`, `execute`, `admin`, `adoptBinding`, `status`). |
| `kernel/kernel.ts` | `Kernel`: a world, a store, the signers, the ten modules opened on that world, `call` / `deploy` / `transfer`, facts, `memo`, evidence. |
| `kernel/errors.ts` | `RevertDecoder`: custom errors across every world ABI, `Error(string)`, `Panic`, and `CallFailed` unwrapping. |

## Exactly once

Every chain write has a key chosen by the caller (`T3.A.submit`). `TxManager.send` runs this sequence for a new key:

1. fix the nonce (`getTransactionCount(signer, "pending")`);
2. build the request — the builder receives the nonce, so a deployment can predict its own address;
3. estimate gas on the pending state and add a margin (25 % + 20 000): the inclusion state differs from the estimate's at least by the block timestamp, and an `SSTORE` that was a no-op during the estimate (a heartbeat written in the same second) costs 2 900 more when the second ticks;
4. sign, compute the hash, **write the row as `sent` with hash and nonce**;
5. broadcast;
6. wait for the receipt (120 s by default); write the row as `confirmed` with block, gas and log count, or `failed` with the reason.

Step 4 before step 5 is what makes a crash recoverable: whatever happens afterwards, the store knows which transaction may be out there.

When the wait runs out, the chain is asked what became of the transaction. Still pending (a public chain whose base fee rose after the quote): it is **replaced** — the same payload under the same nonce, signed again with fees a third above the pending ones, recorded as the operation's new hash (`replaced`, naming the hash it replaces) and waited for in turn, up to three times. Gone from the pool with the nonce still free: broadcast again as it was (`resend`). Gone with the nonce consumed by something else: `OperationAmbiguous`. Every hash an operation ever had is in the journal, and the receipt of any of them completes it — the nonce makes them mutually exclusive, so exactly one can be mined. On a local chain a timeout almost always means the node is starved by another process (a proving-key build), not fees; the replacement is harmless there and the message says what to look for.

### What a resumed run does with a row

| Row status | The chain says | Decision |
|---|---|---|
| `confirmed` | receipt for the hash exists | answered from the store; the receipt is re-read for its logs (`replayed`) |
| `confirmed` | no receipt for the hash | the store and the chain have diverged: refuse (`OperationAmbiguous`) |
| `sent` | a receipt exists for any hash the operation had | finish from the receipt, nothing re-sent (`recovered-receipt`) |
| `sent` | the transaction is known and pending | replace it with higher fees under the same nonce and wait for whichever is mined (`recovered-pending`, `replaced`) |
| `sent` | unknown hash, the signer's nonce still equals the row's | the transaction never reached the chain: re-send with the same nonce (`resend`) |
| `sent` | unknown hash, the signer's nonce has moved past the row's | something else consumed the nonce; the outcome cannot be decided by code (`OperationAmbiguous`): never retried automatically |
| `failed` | — | retried as a new send (a `failed` row means a known revert, usually after a fix) |
| none | — | a new send |

A store also records the hash of block 0 the first time it opens. A later open against a chain with a different block 0 (a restarted anvil) is refused with an explicit message rather than replaying a history into a world where it never happened.

### Fault injection

`--crash-before <key>` exits the process (code 75, `EX_TEMPFAIL`) right after the row is written as `sent`, before the broadcast; `--crash-after <key>` exits right after the broadcast, before the receipt is read. Both leave the store in the state a real crash would, and the next run must resolve it by the table above. CI runs both against `T3.A.submit` and `T3.A.settle` and then a third, pure-replay run, and asserts that the tender still has exactly one submission.

## Facts and `memo`

Values a later step needs (ids, addresses, hashes) are facts in the store, written when known. Values that enter a transaction and depend on the clock or on chain state at run time — deadlines, the probe block, a Groth16 proof bound to an epoch — go through `kernel.memo(key, compute)`: computed once, read back on every later run, so a resumed run rebuilds exactly the inputs the recorded transactions were made from. Rebuilding them from the clock again would make the store's account of a replayed operation disagree with the chain.

## Chain time

`kernel.advanceTime(seconds, why)` lets a window pass. On anvil it moves the clock (`evm_increaseTime`, then a block) and writes a `time-skipped` journal entry with the interval and the reason, so a skipped window is visible in the evidence; on any other chain it waits for real time (`time-waited`, polling the block timestamp every 5 s). The genesis chooses realistic windows on a local chain and short ones elsewhere (docs/genesis.md).

The provider polls a local node every 250 ms and a public endpoint every 4 s: a shared, rate-limited endpoint that makes a block every 12 s is asked a few times per block, not several times per second.

A public RPC URL usually fronts a cluster whose nodes import a block at slightly different times, so a read made right after a receipt can land on a node that has not seen the block yet (on Sepolia the roster of a swarm read as not met one second after its third `join` confirmed, and a call opened in one block was unknown to the gas estimate of its delivery in the next). The kernel therefore reads what it has written: its provider (`kernel/provider.ts`, `PinnedProvider`) keeps the highest block it has seen in a receipt, a block header or a block number, and sends every state read made at "latest" — `eth_call`, `eth_estimateGas`, balances, code, storage — at that block instead. A node behind the pin answers with an error rather than with stale state, and the request is retried (up to 60 s) until a node that has the block answers; a contract's revert is an answer and is never retried. When the retries run out, the endpoint's head is sampled again: a pin that came from a node ahead of the rest is lowered to the head the endpoint reports and the read made there, once; otherwise the error is raised with the node's own words and the run stops where it is, to be resumed from its store. A read at "latest" is never substituted — the node that refuses an explicit block may be the one that is hours behind, and a stale answer fails checks that hold on chain (seen on Sepolia: a swarm read as ACTIVE after its conclusion, a document digest read as the version before its update). The kernel journals these events (`pinned-read`). Explicit block tags (the probe's fixed block), "pending" (the nonce) and everything that is not a state read pass through unchanged, and the pin moves forward with every receipt and with the block headers read while waiting for a window, so time-dependent views are read at the current block. The pin starts at the chain's head when the kernel opens, so a replayed run — which reads back old receipts and sends nothing — reads the chain as it is now, not as it was at each step. On a single local node the pin is simply the node's tip. The transaction manager additionally waits, after a receipt on a public chain, until the endpoint reports that block twice in a row (`visibility-waited` when it had to).

## Gas

Every estimate gets a margin (see above). A call whose outcome depends on the gas it is given — the SwarmRegistry's `challenge`, which treats an eligibility module's `false` returned with little gas left as unevaluable — takes an explicit `gasLimit` through `kernel.call`, because an estimate stops at the first non-reverting path, and "unevaluable, nothing changed" is one.

## Evidence

`kernel.evidence(step, label, values)` records what a reviewer needs per step (addresses, ids, hashes, transaction hashes, run receipts). The genesis writes it, together with the checks, facts, operation summary and the journal of the run, to `deployments/<world>.genesis.json` (`foga.genesis-evidence/1`). `deployments/local.genesis.example.json` is a committed run. The doctor consumes that file for its fifth layer (docs/doctor.md).

## Keys and funds

The kernel's signers are named by role (`W`, `G`, `owner.A`, `operator.A`, …). All twelve are the first twelve accounts of one BIP-39 phrase (`src/genesis/roles.ts`): anvil's well-known phrase on anvil, so every local run uses the same addresses; on any other chain the phrase in `FOGA_MNEMONIC` or in the file named by `FOGA_MNEMONIC_FILE` (`foga keys new` writes one, `foga keys show` lists the addresses), with `FOGA_KEY_<ROLE>` (`FOGA_KEY_W`, `FOGA_KEY_OWNER_A`, `FOGA_KEY_OPERATOR_A`, …) overriding one role. Keys never leave the kernel: the skill worker (below) is started with an environment reduced to `PATH`.

W is the treasury. Before every step the genesis tops up each role whose balance has fallen below half its floor (`src/genesis/funding.ts`: a gas budget per role from a full local run, priced at the fee the chain quotes when the step starts; fixed floors on anvil, where only the judges beyond the pre-funded accounts need anything) and gives each cell its working capital at birth. The amounts are memoized facts, so a resumed run rebuilds the same transfers. `foga genesis preflight` prints the plan and what W must hold without sending anything.

## Running a skill

Before a cell executes a skill it holds, the kernel rebuilds the package from the local directory and compares `mdHash` and `packageHash` with the token's on-chain commitment (`skillOf`); a tampered file changes both and the run is refused. `foga-probe` then runs in a separate process (`src/genesis/probe-worker.ts`) with a time limit, holding no key and making view calls only; the parent receives the canonical answer and decides what to commit to. The isolation boundary is a process today; the sandboxed runtime of the hosted node is Phase 3 work.

## The prover

Both ZK paths of ERC-8419 run through `prover/run.cjs`: a stdin/stdout bridge over the upstream prover (`vendor/kya-standard/companions/zk-kya-groth16/prover.js`, with the credential circuit's wasm and proving key next to it) and over FOGA's own predicate circuit (`zk/build`, docs/zk.md). `prover/` is a sub-package with its own dependencies (snarkjs, circomlibjs; `npm run zk:install`), so the kernel's own dependency tree stays at ethers. The bridge keeps the roles apart: `commit` (the prover's Poseidon commitment to its secret), `attest` (the attestor signs the credential over the commitment, never seeing the secret), `root` (an issuer or source set from keys), `prove` (the credential proof: the prover's secret plus public material only), `record.sign` (a source signs one task-completion record) and `predicate.prove` (the predicate proof: the records with their signatures, the prover's secret, public material). FOGA's attestor and source keys and the cells' prover secrets are derived from the signers' keys, so a run is reproducible and nothing extra is stored; a resumed run reuses the recorded proofs.

## `node:sqlite`

Node 22 ships `node:sqlite` unflagged but still prints an experimental notice on first load. The store silences that one notice during its own load and nothing else; Node 24 prints none.
