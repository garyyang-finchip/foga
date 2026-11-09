# Extending FOGA: the eleventh covenant, the services slot, what survives the OG

FOGA is complete over ten covenants and ERC-8004 today. Nothing in the program assumes that is the last word: the covenant list is read off the world, the kernel and the catalog are registries, the doctor judges per standard, and the manifest carries a slot for the services around the covenants that the maintainer fills without a code release. This page is the map of those seams — where an eleventh covenant goes, how the services pointer works and is declined, how the cell specification would move to a second version, and what keeps working when the reference cell is off.

## The covenant list is data

`FOGA_COVENANTS` (`src/node/propagation.ts`) names the set this build is complete over: the base, not a ceiling. What a cell's world *actually* has is read off the world file's contract keys — `8414/TaskToken` is ERC-8414, `identity8004/…` is ERC-8004 — by `World.covenants()` (`src/core/world.ts`), and the propagation manifest reports both:

```
"covenants": ["ERC-8004", "ERC-8338", …, "ERC-8471"],      // the program's base set
"world": { "covenants": ["ERC-8004", …, "ERC-8471"], "extensions": [] }
```

A world that attaches contracts under a new key — `9001/SomethingRegistry` — advertises `ERC-9001` under `world.covenants` and in `world.extensions` with no change to the program; a world that lacks one of the base set does not claim it. The doctor's layer 5 and the catalog's `ercs` dimension work the same way: per standard, from the world and the capabilities registered, never from a fixed count.

## Adding a covenant, in five places

An eleventh covenant is a repository under `vendor/` and five additions, each in a registry that already exists:

1. **The world.** Its contracts enter the world file under the ERC's number (`"9001/<Name>": {address, bundleKey}`) — `foga world deploy` from the bundle, or `foga world attach` to an instance that exists. `World.covenants()` sees it at once.
2. **The kernel.** A module like `src/core/asf.ts` or `src/core/tenders.ts`: the ABI from the bundle, the encoders and reads the catalog and the genesis need. `Kernel` holds one per standard.
3. **The catalog.** Capabilities in `src/tools/<covenant>.ts`, each declaring its action, visibility and principal, with the ERC in its `ercs`; registered in `src/tools/index.ts`. The CLI, MCP, HTTP and A2A entrances pick them up without a line of their own: an entrance is a view of the catalog.
4. **The doctor.** A checker in `src/doctor/` that names its checks after the standard; layer 5 judges it beside the others (docs/doctor.md).
5. **The manifest and the documents.** Nothing to add for the manifest (it reads the world); the ERC-8434 AID document and the ERC-8444 descriptor gain a facet or a field only if the covenant has something a counterparty must be told (docs/documents.md).

A cell born on a world with the eleventh covenant attached is complete over eleven; one born on a world without it is complete over ten, and says so.

**The first one, done (0.8.0).** ERC-8490, the Agent Meditation Mechanism, went in by exactly these five: `8490/AgentMeditationRegistry` in the plan and the attach-mode configs (1), `src/core/amm.ts` on `Kernel.meditation` (2), `src/tools/meditation.ts` registered in the catalog (3), the registry's rows at layers 1–3, a `CLOCK_MODE` readout and a layer-5 rule for its checks (4), a `maintenance` block in the manifest and an `upkeep` line in the card, with no change to the AID document or the descriptor (5) — plus what a covenant that *acts* needs and the list did not say: a scope group for the operator (`maintenance` in `src/genesis/operator-scope.ts`), a configuration block (`maintenance` in `cell.config.json`), and a way onto it for a cell that already runs, which is `foga cell extend --covenants 8490` (`src/node/extend.ts`): the contract enters the cell's own world file, the owner opens the scope and enrolls, nothing is migrated. docs/meditation.md has the rest. The base set `FOGA_COVENANTS` stays at the ten plus ERC-8004 until the twelve-covenant cell specification (4c); until then a world with the registry advertises `ERC-8490` under `world.extensions`.

**The second one (0.9.0).** ERC-8489, the Agent Information Flow Paradigm, went in by the same five — seven upstream contracts under `8489/…` in the plan and the attach-mode configs, plus a contract of FOGA's own, `8489/FogaIdentityVerifier` (the `identity` predicate leaf over the world's ERC-8004 and ERC-8434 registries), and a wiring step (1); `src/core/aifp.ts` on `Kernel.flows`, with FOGA's two paradigm descriptors in `scenarios/flows/` (2); `src/tools/flows.ts` in the catalog (3); layer-4 wiring checks and two readouts (4); a `flows` block in the manifest and a `flows` line in the card, the flow documents served under `/documents/flows/` (5) — and what a covenant with **a shared context** needs beyond them: a maintainer's bootstrap per chain (the paradigms registered in the family `foga`, the default market opened — `foga world deploy` for a local world, `foga flow bootstrap` by the reference cell on a public one), recorded in the world file's `flows` block; a step of the birth (the cell's own channel, its SUBMIT grant); steps of `docs_publish` (the publication anchored and disclosed); a gate of `tender_precheck` (the counterparty's role, when the policy asks); a watcher; and `foga cell extend --covenants 8489` for a running cell, which also copies the chain's `flows` from the packaged world. docs/flows.md has the rest.

## The cell specification: one version, then a second

Every cell adopts the FOGA-Cell-v1 safety specification (ERC-8468): `foga cell init` registers it under the owner when the configuration names none and adopts it when the owner published it before, and the account binds to it. Its content hash is what the binding holds, so **its text is not edited in place** — an edit would make every existing cell's configuration disagree with the chain and every new birth from an owner who published before fail its check (`src/node/init.ts`). A change to what a cell promises is a *second version*: `fogaCellSpecification()` grows a sibling, a new cell names it in `identity.safety` or registers it, and an existing cell moves by presenting a binding to the new specification (`binding_present`). Two versions coexist on one world; the doctor and the manifest read which one a cell holds.

## The services slot

The manifest carries, beside the program and the replication pointer, a `services` block (docs/propagation.md):

```
"services": {
  "catalog": "https://foga.finchip.ai/services.json",
  "maintainer": "FinChip.ai",
  "offers": [ { "id": "become-a-cell", "kind": "free", "status": "available", … }, { "id": "kya-attestation", "kind": "paid", "status": "planned", … }, … ],
  "note": "optional and declinable; the catalog is the live list; a planned offer is not for sale yet"
}
```

It is a pointer, deliberately: the catalog behind the URL is the live list, so what the maintainer offers — the free things, and in time the paid ones (standing attestation under the FOGA scheme, a hosted cell, dispute resolution) — changes there, with no release and no change to any cell already running. A `planned` offer is a slot, not a sale. The pointer resolves from the first day: the reference cell serves the maintainer's catalog at `/services.json` as `foga.services/1` from what its build knows (any cell whose pointer is its own URL does the same for its own list), and a static file at that path on the host, answered by the proxy ahead of the node, replaces it whenever the live list moves on (docs/propagation.md). Everything about it is visible and declinable, like the replication pointer: an operator who does not want the maintainer's catalog in their cell's manifest sets `presence.services.catalog` to `null`; one with services of their own names their catalog and offers there. The services themselves, when they are paid, are paid the way the covenants already pay for anything — a tender (ERC-8414) to a cell that offers the skill, or an attestation (ERC-8419) by an issuer — not a billing system beside the protocol.

## What survives the OG being off

The reference cell at `foga.finchip.ai` is one running instance. Becoming a cell never passes through it: `npx -y @finchip.ai/foga quickstart` needs the npm registry and nothing else; a birth on a public chain needs the npm registry, an RPC and the world's contracts, which are on the chain. The replication pointer every cell carries names the package, not the OG. When the OG is off, what stops is the OG's own surface — its endpoints, its manifest and card, its place as a counterparty; the npm package, the GitHub repository, the MCP registry's package entry and the documentation site stay, and every pointer in a cell's documents resolves to those or to the chain. The program is the genome; the OG is the first body. docs/og-deployment.md says how it is served, and `foga cell advise` what any cell — the OG included — should do once it runs.
