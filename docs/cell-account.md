# FogaCellAccount

`contracts/src/FogaCellAccount.sol` is the body of a cell: one contract account that is, at the same time, the cell's ERC-8434 anchor, its ERC-8004 owner, the holder of its assets and tokens, the fulfiller of record on ERC-8414 tenders, the adopter of its ERC-8468 binding, the KYA subject (`account` type), and the controller of its ARD records and AUF units. Everything the cell does on chain is a call made by this address; a call made by the operator key directly is the operator's own act, not the cell's (design memo, section 8.2).

The account carries the execution-gate semantics of the ERC-8468 reference's `ASFGuardedAccount` — a requirement fixed at deployment, bindings presented by the owner, a de-risk allow-list that stays open under a derisk-only suspension — and adds what a cell needs on top. It is compiled with via-IR (solc 0.8.30, cancun) and shipped in the bundle as `foga:FogaCellAccount`.

## Roles

| Role | Held by | Powers |
|---|---|---|
| `owner` | the cold principal (on the Finch OG Agent: the author's key; on anvil: a derived account) | set operator, guardian, recovery and AID registry; adopt and present bindings; set selector classes; transfer ownership; `execute`; `sweep` |
| `operator` | the node's hot signer | `execute`, within scope: optional expiry (`operatorValidUntil`) and a per-day cap on native value sent (`operatorDailyValueCap`); ERC-1271 signatures while in scope |
| `guardian` | the intervener named in the cell's safety binding | nothing on the account itself: the guardian acts on the ERC-8468 Binding Registry (`suspend`, `resume`), and the gate reads the result |
| `recovery` | defaults to the owner | `sweep` to the owner, at any time |

## The gate

`execute(target, value, data)` is the only way to act as the cell. Every call passes `_gate`:

1. The presented bindings must be as many as the requirement has clauses; before the first `adoptBinding` nothing executes (`BindingsNotPresented`). There is no privileged path around this, the owner included.
2. `safety.check(requirement, presentedBindings)` must return `Satisfied`. `NotSatisfied` passes only when every failing clause is a suspension (own, inherited, or a standing stop by a named intervener) whose response set keeps de-risking open and is not a full stop, **and** the selector is on the owner's de-risk allow-list for that target. `Unknown` (the specification registry unreachable) never passes.
3. A selector the owner marked as commitment-class (`setCommitmentClass`) additionally requires `aid.state(address(this)) == ACTIVE` in the configured ERC-8434 registry — "no delivery while not ACTIVE" is enforced, not promised. De-risk calls skip this clause by construction.

The genesis marks `TaskToken.submitFulfillment`, `SwarmRegistry.join`, `SwarmRegistry.applyToJoin` and `AUFAssertionRegistry.assertStatement` as commitment-class, and `TaskToken.withdrawCredit`, `TaskToken.reclaimEscrow` and `SwarmRegistry.leave` as de-risk actions.

## Adopting the binding

Adoption is the bootstrap and it is owner-level: `adoptBinding(input, clauseIndex)` calls `adopt` on the Binding Registry with the account as `msg.sender` (so the registry records the account as adopter) and presents the returned id for the given clause. The operator cannot swap bindings; re-adoption after a termination overwrites the slot. `presentBindings` remains for re-pointing an existing set.

Because the requirement names the account as adopter and subject, the deploying kernel predicts the account's address from the deployer's nonce (`getCreateAddress`) and checks the receipt against it.

## Signatures and receivers

`isValidSignature` accepts a 65-byte ECDSA signature by the owner, or by the operator while in scope. That makes `bindWithSig` (ERC-8434), `joinBySig` (ERC-8447), `assertStatementBySig` (ERC-8454) and signed ballots (ERC-8436) available to a cell. The account implements the ERC-721 and ERC-1155 receiver hooks and ERC-165 for 1271 and both receivers.

## Sweep

`sweep(token, amount)` moves native value or an ERC-20 balance to the owner. It is open to the owner and the recovery address and is not gated: it can only reduce the account's exposure, which is what `RESTRICT_DERISK_ONLY` is meant to keep open.

## Errors

`NotOwner`, `NotOperatorOrOwner`, `NotOwnerOrRecovery`, `OperatorExpired(validUntil)`, `DailyValueCapExceeded(cap, spent, requested)`, `BindingsNotPresented(presented, required)`, `ClauseIndexOutOfRange(index, clauses)`, `BindingNotSatisfied(verdict, reasons)`, `AnchorNotActive(state)`, `CallFailed(data)` (the inner revert data of the target call), `ZeroAddress`. The kernel's revert decoder unwraps `CallFailed` so a refused call reports the real cause (`CallFailed(Error("TaskToken: verification failed"))`).

## Tests

`contracts/test/FogaCellAccount.t.sol` (15 tests, `forge test`): constructor fixes requirement and roles; nothing executes before bindings are presented; `adoptBinding` is owner-only, presents the binding and makes the account the adopter; operator executes when satisfied; owner executes, strangers cannot; the gate blocks `NotSatisfied` for operator and owner alike; de-risk allow-list under a derisk-only suspension, full stop blocks even allow-listed calls; `Unknown` blocks; commitment class requires an ACTIVE anchor (DORMANT and STALE refused); operator expiry and the daily cap, reset on the next day; target reverts bubble; ERC-1271 for operator and owner, expired operator refused; sweep by owner or recovery only, open under a full stop; receivers and ERC-165; owner-only administration.

Timestamps in the tests are absolute: with via-IR the compiler may cache `block.timestamp` within a call, so `block.timestamp + x` after a `vm.warp` can still read the pre-warp value.
