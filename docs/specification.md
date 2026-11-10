# The FOGA cell specification (ERC-8468): FOGA-Cell-v1 and FOGA-Cell-v2

Every FOGA cell adopts one safety specification under ERC-8468, the Agent Safety Framework: a document whose content hash a binding holds, with named interveners (the guardian) and declared enforcement. The specification says what a cell promises; the account's gates, the acceptance consumers and the runtime are what enforce it — the text alone enforces nothing (docs/genesis.md, T7). This page is the specification's two versions, how a cell comes to hold each, and how anyone reads which one a cell operates under.

## The two versions

The specification is one per owner: its id derives from the registry, the publisher (the owner) and a fixed salt, so an owner's cells share it, and an owner who published it for an earlier cell adopts it for the next rather than registering it again. Its versions are the documents of this program (`fogaCellSpecification(version)`, `src/core/asf.ts`); a version's bytes never change once published, because the content hash is what every binding pins.

| | Version 1 (0.6.0) | Version 2 — FOGA-Cell-v2 (1.0.0) |
|---|---|---|
| Clauses | `aid-active`, `honor-stop`, `derisk-open`, `attribution` | the four of version 1, unchanged, and `self-maintenance` (ERC-8490), `self-description` (ERC-8489), `context-by-rule` (ERC-8489) |
| Enforcement declared | account, contract | account, contract, runtime |
| Who enforces | the cell account's gates: the AID-state gate, the execution gate against the Binding Registry, the de-risk allow-list; attribution by routing | the account as before for the first four; the node's runtime for the three new ones — the maintenance watcher, the flows watcher, the catalog's gates — attested by the registries' own records |
| Published as | `registerSpecification` (version 1 of the owner's specification) | `publishVersion` (version 2 of the same specification) |

The three clauses of version 2, in short: a cell keeps its four state documents registered in the ERC-8490 meditation registry and runs a maintenance cycle when a layer falls due or a document drifts, honoring a controller's demand by its deadline; it publishes its self-description in an ERC-8489 channel it is the authority of, anchors every publication there (publish, then supersede; the same content never twice) and records the disclosure when its documents are served to anyone; it takes part in a shared context — a market, a channel it does not own — only under a role the context's rules grant or admit, acquired and exercised through its account, and reports a verifier's outcome as obtained, never folding one into another.

## How a cell comes to hold a version

**Born under 1.0.0** (`foga cell init`, `foga join`, `foga quickstart`): the owner's specification is made whole first — version 1 registered when the owner never published, version 2 published under it when missing (`ensureCellSpecification`, `src/node/init.ts`; two transactions once per owner, not per cell) — then the account is deployed with a requirement naming **version 2** with enforcement account | contract | runtime, and the cell adopts a version-2 binding through the account's own `adoptBinding`, presented for the requirement's clause. `identity.safety` in the configuration records `{specId, version: 2, contentHash}`.

**Born before 1.0.0**: the account's requirement — fixed at deployment, `requirementId` immutable — names version 1 alone. A binding to version 2 cannot be presented to that account: the registry's check would answer `VersionMismatch` and the account would stop executing. So a running cell **adopts version 2 as a second binding**, enforced by the runtime: `foga cell adopt` (`spec_adopt`, the owner's key) publishes version 2 under the owner's specification when it is missing (the owner is its publisher), then adopts a binding to it through the account — adopter the account, enforcement `runtime`, the guardian as intervener, params `{profile: "foga-cell/2", presentedToAccount: false, accountEnforces: 1}` — and records it in the configuration as `identity.adopted`. Nothing is presented to the account, so nothing stops; the account keeps enforcing version 1 through the binding it presents, and the node honors version 2's clauses, as it did before the binding said so. For a one-key cell the owner's `adopt` pair through `execute` is opened first in the same job (operator-scope.ts).

**A successor body** (`foga cell migrate`): the new account fixes version 2 in its requirement and binds to it at its deployment; the adoption is not carried, because the account itself enforces version 2 now.

## Reading which version a cell operates under

A cell operates under the higher of the version its account enforces and the version its runtime adopted. Four places say it, with no chain call where the node's own configuration suffices:

- `foga cell card` — the `spec` line: `FOGA-Cell-v2`, or `FOGA-Cell-v2 (the account enforces v1; v2 adopted by the runtime)`, or `FOGA-Cell-v1 — this program is v2: foga cell adopt`;
- the propagation manifest (`/.well-known/foga-cell.json`) — `specification: {operatesUnder, account, adopted, program}`;
- `spec_status` (`foga cell spec`; public; MCP and `POST /api/spec_status`) — the bindings read live: the presented binding's state, the adopted binding's state, the account's verdict on what it presents, and this build's current version with its content hash, so a counterparty can tell a FOGA-Cell-v2 cell from one still under version 1;
- `foga node preflight` — the row "the cell operates under FOGA-Cell-v2": Pass when the account's binding or the adopted one is version 2, Warn with the command otherwise.

A counterparty that requires FOGA-Cell-v2 of a cell reads `spec_status`, or asks the Binding Registry itself: a requirement naming the owner's specification, `versions: [2]` and `enforcement: runtime` is Satisfied by the adopted binding of a cell born before 1.0.0 and by the presented binding of a cell born under it; one naming `enforcement: account` for version 2 is Satisfied only by the latter — which is the truth of the matter, and the reason the two bindings are not folded into one.

The documents themselves: `foga://spec/foga-cell-v1` and `foga://spec/foga-cell-v2` over MCP, `spec_read` with `foga-cell-v1` or `foga-cell-v2`.

## Where things are

| | |
|---|---|
| `src/core/asf.ts` | `fogaCellSpecification(1 \| 2)`, `FOGA_CELL_SPEC_VERSION` (2), `FOGA_CELL_SPEC_SALT_NAME`, `cellEnforcement(version)`, `cellProfile(version)` |
| `src/node/init.ts` | `ensureCellSpecification` (versions 1 and 2 under the owner's specification); the birth binds to version 2 |
| `src/node/migrate.ts` | the successor binds to the current version |
| `src/tools/specification.ts` | `spec_status` (public read), `spec_adopt` (admin, the owner's key) |
| `cell.config.json` → `identity.safety`, `identity.adopted` | the account's binding; the runtime's adopted binding (absent for a cell born under the current version) |
| `test/specification.test.ts` | the acceptance on anvil: version 2 at birth, a cell born under version 1 adopting it, a successor binding to it |
