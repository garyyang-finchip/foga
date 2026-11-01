# FogaCellAccount

`contracts/src/FogaCellAccount.sol` is the body of a cell: one contract account that is, at the same time, the cell's ERC-8434 anchor, its ERC-8004 owner, the holder of its assets and tokens, the fulfiller of record on ERC-8414 tenders, the adopter of its ERC-8468 binding, the KYA subject (`account` type), and the controller of its ARD records and AUF units. Everything the cell does on chain is a call made by this address; a call made by the operator key directly is the operator's own act, not the cell's (design memo, section 8.2).

The account carries the execution-gate semantics of the ERC-8468 reference's `ASFGuardedAccount` — a requirement fixed at deployment, bindings presented by the owner, a de-risk allow-list that stays open under a derisk-only suspension — and adds what a cell needs on top. It is compiled with via-IR (solc 0.8.30, cancun) and shipped in the bundle as `foga:FogaCellAccount`. `ACCOUNT_VERSION` is 2 since 0.6.0: revision 2 closes the operator's scope to an allow-list (below). The cells of the 0.5.0 Sepolia run are revision-1 accounts; a revision-1 account cannot be upgraded in place, so a cell that is to run as a public node moves to a revision-2 account the way T9 moves A to A-prime (docs/design-memo.md, Phase 3).

## Roles

| Role | Held by | Powers |
|---|---|---|
| `owner` | the cold principal (on the Finch OG Agent: the author's key; on anvil: a derived account) | set operator, guardian, recovery and AID registry; adopt and present bindings; set selector classes; transfer ownership; `execute`; `sweep` |
| `operator` | the node's hot signer | `execute`, within scope: only (target, selector) pairs the owner allow-listed (`operatorAllowed`), never an asset-moving selector, optional expiry (`operatorValidUntil`), a per-day cap on native value sent (`operatorDailyValueCap`); ERC-1271 signatures only when the owner enabled them (`operatorMaySign`) |
| `guardian` | the intervener named in the cell's safety binding | nothing on the account itself: the guardian acts on the ERC-8468 Binding Registry (`suspend`, `resume`), and the gate reads the result |
| `recovery` | defaults to the owner | `sweep` to the owner, at any time |

## The operator's scope (revision 2)

The operator key is the one key a running node holds, so what it can do through the account is what an attacker holding it can do. Revision 1 bounded that by expiry and a daily value cap only: any target, any selector. Revision 2 adds an allow-list and a signing switch, both owner-administered:

- `operatorAllowed[target][selector]` — `setOperatorAllowed(target, selector, allowed)` and `setOperatorAllowedBatch(targets, selectors, allowed)` (`OperatorAllowedSet` per entry). A call by the operator whose (target, selector) is not on the list reverts with `OperatorNotAllowed(target, selector)` before the gate is consulted. A fresh account allows nothing: the owner opens the scope after `setOperator`, and the genesis does it in T1 (`T1.<X>.scope`) from the groups in `src/genesis/operator-scope.ts` — identity, standing, skills-provider, labour, demander, organization-member, organization-coordinator, service-provider, service-client — so a cell's allow-list reads as the roles it plays, and opens two more entries for B in T4 when the swarm's decision adapter and account exist (`T4.B.scope.*`). The selector is the first four bytes of `data`; a call with less than four bytes of data has selector `0x00000000` and must be allow-listed as such.
- Asset-moving selectors are closed to the operator by construction, allow-listed or not: `transfer`, `transferFrom`, both ERC-721 `safeTransferFrom`s, the ERC-1155 `safeTransferFrom` and `safeBatchTransferFrom`, `approve`, `setApprovalForAll`, `increaseAllowance`, `permit`. Allow-listing one reverts with `OperatorAssetSelector`, and so does an operator call carrying one. Moving the cell's assets — the ERC-8004 identity and the skill tokens A hands to A-prime in T9, for instance — is the owner's act (`execute` by the owner, which is never scope-checked, or `sweep`).
- `operatorMaySign` (`setOperatorMaySign`, `OperatorSigningSet`) — off by default. While off, an operator signature is not the account's signature (ERC-1271 below), so a relayed, signed path (`bindWithSig`, `joinBySig`, `assertStatementBySig`, signed ballots) is not open to a key that only holds `execute` rights.

The order of checks for an operator call is: expiry, asset selector, allow-list, daily value cap, then the gate below. The owner's calls pass none of the operator checks and all of the gate.

## The gate

`execute(target, value, data)` is the only way to act as the cell. Every call passes `_gate`:

1. The presented bindings must be as many as the requirement has clauses; before the first `adoptBinding` nothing executes (`BindingsNotPresented`). There is no privileged path around this, the owner included.
2. `safety.check(requirement, presentedBindings)` must return `Satisfied`. `NotSatisfied` passes only when every failing clause is a suspension (own, inherited, or a standing stop by a named intervener) whose response set keeps de-risking open and is not a full stop, **and** the selector is on the owner's de-risk allow-list for that target. `Unknown` (the specification registry unreachable) never passes.
3. A selector the owner marked as commitment-class (`setCommitmentClass`) additionally requires `aid.state(address(this)) == ACTIVE` in the configured ERC-8434 registry — "no delivery while not ACTIVE" is enforced, not promised. De-risk calls skip this clause by construction.

The genesis marks `TaskToken.submitFulfillment`, `SwarmRegistry.join`, `SwarmRegistry.applyToJoin`, `AUFAssertionRegistry.assertStatement` and `ACDFRegistry.castBallot` as commitment-class, and `TaskToken.withdrawCredit`, `TaskToken.reclaimEscrow`, `SwarmRegistry.leave` and `ADRFServiceEscrow.withdrawBalance` as de-risk actions. T7 of the genesis exercises the gate on chain: a transaction sent around the kernel fails with `BindingNotSatisfied` under a suspension, the allow-listed withdrawal passes, a fresh binding does not escape the intervener's standing stop, and a STALE anchor stops commitment-class calls until the next heartbeat (docs/genesis.md).

## Adopting the binding

Adoption is the bootstrap and it is owner-level: `adoptBinding(input, clauseIndex)` calls `adopt` on the Binding Registry with the account as `msg.sender` (so the registry records the account as adopter) and presents the returned id for the given clause. The operator cannot swap bindings; re-adoption after a termination overwrites the slot. `presentBindings` remains for re-pointing an existing set.

Because the requirement names the account as adopter and subject, the deploying kernel predicts the account's address from the deployer's nonce (`getCreateAddress`) and checks the receipt against it.

## Signatures and receivers

`isValidSignature` accepts a 65-byte ECDSA signature by the owner always, and one by the operator only when `operatorMaySign` is on, the operator has not expired and the safety gate is satisfied at that moment (bindings presented and the registry's verdict `Satisfied`): a suspension that stops `execute` stops the signed path too, where revision 1 checked the expiry alone. That makes `bindWithSig` (ERC-8434), `joinBySig` (ERC-8447), `assertStatementBySig` (ERC-8454) and signed ballots (ERC-8436) available to a cell whose owner opens them. The account implements the ERC-721 and ERC-1155 receiver hooks and ERC-165 for 1271 and both receivers.

## Sweep

`sweep(token, amount)` moves native value or an ERC-20 balance to the owner. It is open to the owner and the recovery address and is not gated: it can only reduce the account's exposure, which is what `RESTRICT_DERISK_ONLY` is meant to keep open.

## Errors

`NotOwner`, `NotOperatorOrOwner`, `NotOwnerOrRecovery`, `OperatorExpired(validUntil)`, `OperatorNotAllowed(target, selector)`, `OperatorAssetSelector(target, selector)`, `LengthMismatch` (a batch whose arrays differ in length), `DailyValueCapExceeded(cap, spent, requested)`, `BindingsNotPresented(presented, required)`, `ClauseIndexOutOfRange(index, clauses)`, `BindingNotSatisfied(verdict, reasons)`, `AnchorNotActive(state)`, `CallFailed(data)` (the inner revert data of the target call), `ZeroAddress`. The kernel's revert decoder unwraps `CallFailed` so a refused call reports the real cause (`CallFailed(Error("TaskToken: verification failed"))`).

## Tests

`contracts/test/FogaCellAccount.t.sol` (17 tests, `forge test`): constructor fixes requirement and roles; nothing executes before bindings are presented; `adoptBinding` is owner-only, presents the binding and makes the account the adopter; operator executes when satisfied; owner executes, strangers cannot; the gate blocks `NotSatisfied` for operator and owner alike; de-risk allow-list under a derisk-only suspension, full stop blocks even allow-listed calls; `Unknown` blocks; commitment class requires an ACTIVE anchor (DORMANT and STALE refused); operator expiry and the daily cap, reset on the next day; target reverts bubble; the allow-list is the operator's only door (a fresh account refuses with `OperatorNotAllowed` before the gate, the batch opens and closes entries, the owner is not scope-checked); asset selectors are closed to the operator and cannot be allow-listed; ERC-1271 for the owner always and for the operator only when enabled, in scope and satisfied; sweep by owner or recovery only, open under a full stop; receivers and ERC-165; owner-only administration.

Timestamps in the tests are absolute: with via-IR the compiler may cache `block.timestamp` within a call, so `block.timestamp + x` after a `vm.warp` can still read the pre-warp value.
