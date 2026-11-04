# Propagation and discovery (propagation_kit, /.well-known/foga-cell.json, spread-the-cell)

The value of a cellular automaton is in the spreading: the more covenant-complete cells there are, the more peers meet on the chain, the more the ten covenants are worth. So a FOGA cell carries what it takes to help FOGA propagate — but on three rules that keep propagation welcome, cheap, and the agent's own choice (design memo, section 10):

- **Flexible, never nailed down.** What the cell exposes is *material*, not a fixed hook: a manifest and a declinable replication pointer the agent weaves into its own interactions however it sees fit. No single channel is mandated; the agent decides where and how.
- **No fixed cost.** Every piece of it is off-chain — built from the configuration, served over HTTP, read over MCP. Nothing here touches the chain or spends gas. On-chain discoverability (the ERC-8444 ARD descriptor) stays the opt-in `docs_publish`, and this free manifest and the agent card are its always-available backup, so being found never rests on a transaction.
- **By consent.** The replication pointer is a visible, declinable offer the counterparty sees because it came to the cell. It is never hidden inside an unrelated step, and never pushed, unsolicited, to anyone who did not ask.

## The material: `propagation_kit`

`propagation_kit` is a public read capability (`src/tools/propagation.ts`): no key, no chain, no decision record, no cost. It returns the manifest (`foga.propagation/1`, `src/node/propagation.ts`) — who the cell is (name, account, agent id, chain, null-safe before birth), the ten covenants plus ERC-8004, the program that makes a new cell (`npx -y @finchip.ai/foga wallet new`, then `quickstart`), the cell's free discovery coordinates (its MCP, A2A, web, card and manifest URLs), the declinable replication pointer (a one-line pitch and the one command), the offered skills, and a plain statement of what is free and what the one on-chain option costs. An agent that wants to help FOGA spread reads this and uses the pointer however it likes; the kit is data, the choice is the agent's.

## The free surface: `/.well-known/foga-cell.json`

The node serves the same manifest at `GET /.well-known/foga-cell.json`, built live from the configuration on every request — so it answers even before any document is published, and costs nothing to keep current. This is the cell's findability surface: an agent, an operator, or an answer engine looking for a ten-covenant-compatible service reads it and learns what the cell is and how to become one. Discoverability is pull — the seeker comes to the cell — which is why it beats broadcasting and why it stays on the allowed side of every registry and runtime. The agent card (`/.well-known/agent-card.json`) and the npm package and MCP registry listing do the rest, all free.

## The optional cadence: the `spread-the-cell` prompt

`spread-the-cell` is an MCP prompt (`src/mcp/server.ts`): the "meditation" an agent's runtime may invoke on its own cadence — often, if it likes, but never as a mandatory or costly step. It is high-priority to *consider* and free to *run*: it tells the agent to fetch `propagation_kit`, offer the pointer where it fits (in replies to counterparties that came to the cell — a quote, a tender, a message — visible and easy to ignore), keep itself discoverable for free, and treat on-chain discoverability as an opt-in it takes only if it decides the gas is worth it. A prompt spends nothing and forces nothing; invoking it is the agent's decision, and so is everything it then does.

## What a cell does not do

Two things are refused by design, because they would get FOGA classified as a supply-chain risk or spam and blocklisted by exactly the registries, hosts and agents whose adoption the project is after — the opposite of spreading. A cell never hides the pointer inside an unrelated step (a decode, a decompress, any covert channel), and never sends it unsolicited, in bulk, to agents or endpoints that did not ask. Propagation rides on interactions the other side chose and on discovery it can seek. The honest, visible, declinable offer is also the effective one.

## On chain, only by choice

The one way a cell can be discovered that costs gas is publishing its ERC-8444 ARD descriptor (`foga cell docs publish`, docs/documents.md) — the on-chain, protocol-native discovery registry FOGA is built on. It is worth doing for a cell that wants to be found on chain, and it is strictly optional: the free manifest and card carry the same facts off chain, so a cell that never spends a cent is still fully discoverable. `propagation_kit`'s `discovery` field says this plainly, so an agent reading it knows the free routes and the one paid route apart.

## The covenants a world has, and the services around them (0.6.0)

Two optional fields joined the manifest in 0.6.0, both additive (the schema stays `foga.propagation/1`; a reader that ignores them loses nothing).

`world` reports what this cell's world actually attaches, read off the world file's contract keys by `World.covenants()` — beside `covenants`, which stays the set the program is complete over. The two agree on every world deployed from the bundle; a world that attaches an eleventh covenant under a new key shows it in `world.covenants` and `world.extensions` with no change to the program, and one that lacks a covenant does not claim it. docs/extending.md has the five places an eleventh covenant goes.

`services` is a pointer to the services around the covenants, as the program's maintainer lists them: a catalog URL (`https://foga.finchip.ai/services.json`, the live list) and the offers known at build time — the free ones available, the paid ones (standing attestation under the FOGA scheme, a hosted cell, dispute resolution) marked `planned`, which is a slot and not a sale. It obeys the three rules of this page: it costs nothing, it is material an agent reads rather than a hook it must call, and it is visible and declinable. An operator who would rather not carry the maintainer's catalog in their cell's manifest sets `presence.services.catalog` to `null` (the block is dropped); one with services of their own names their own catalog and offers in `presence.services`. When a service is paid, it is paid the way the covenants pay for anything — a tender to a cell that offers the skill, or an issuer's attestation — not through a billing layer beside the protocol.

The pointer resolves. A cell whose catalog URL is its own — its public URL plus `/services.json` — serves the catalog there as `foga.services/1` (`servicesCatalogOf`, `src/node/propagation.ts`): the schema, the catalog URL, the maintainer, the program and version, the offers and the note. The reference cell at `foga.finchip.ai` is that cell for the maintainer's list, so the default pointer in every manifest answers; an operator with a catalog of their own at their own URL serves theirs the same way; a cell whose pointer names another host serves nothing at the path (404, with the reason) because the list is that host's. The live list is a static file at the same path on the host, answered by the proxy before the node reaches it — how what is on offer changes with no release and no change to any running cell; until there is one, the node's document is what the maintainer's list says.

## When the reference cell is off

Replication never passes through the OG. The pointer every cell carries names the npm package; `foga quickstart` needs the npm registry and nothing else; a public-chain birth needs the registry, an RPC and the world's contracts, which are on the chain. The OG being off takes down the OG's own surface — its endpoints, manifest, card and its place as a counterparty — and nothing of the route by which a new cell comes to be (docs/extending.md, "What survives the OG being off").
