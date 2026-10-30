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

The project delivers three things from one kernel: the **Finch OG Agent** (the first running instance), the **FOGA node software** anyone can run with their own identity, model and wallet, and a **public access layer** (MCP, A2A, HTTP/CLI). It is built in phases; this repository is at **Phase 1: the world layer**.

## Status: Phase 1 — world layer

What works today:

- **Locked sources.** `vendor/LOCK.json` pins the ten reference implementations by commit. `foga vendor sync` materializes them; nothing is modified downstream.
- **One artifact bundle.** `foga build` compiles all ten with their own compiler settings (five profiles on solc 0.8.24, three on 0.8.30, two solc-js repositories mirrored on 0.8.28) into `artifacts/bundle.json`: ABIs, creation and runtime bytecode, link and immutable references, compiler metadata, ERC-165 ids computed from the AST and cross-checked against the upstream vectors (all published ids match). `foga build --verify` rebuilds and proves the hash.
- **One-command world.** `foga world deploy` deploys the whole stack in dependency order — 47 contracts including external libraries and the ERC-8471 module router — and registers the four ARD kinds. Local worlds use `contracts/src/Identity8004Stub.sol` as a clearly labeled stand-in for the ERC-8004 Identity Registry; public worlds attach the official registry.
- **The doctor.** `foga doctor` reports five layers per contract — chain and code, interfaces, version match, configuration and permissions, semantic validation — with the verdicts Pass / Fail / Unknown / Not tested / Not applicable. Layers 1–4 run now; layer 5 arrives with the Phase 2 genesis scenario. A doctor run can be exported as a JSON-RPC probe plan and replayed from results collected elsewhere, so a report never depends on which machine can reach which RPC.
- **Sepolia address book.** `worlds/sepolia.json` records every upstream reference deployment at its deployed revision, including the three seams the inventory found (see docs/version-lock.md).

What is next: Phase 2 adds the SDK (`foga-core`), the deterministic cell kernel, the FogaCellAccount, the predicate-style ZK-KYA path and the genesis scenario T0–T9; Phase 3 adds MCP, A2A and the CLI surface for cells. The design is in docs/design-memo.md.

## Quick start

Three ways in, from most to least demanding:

```bash
# 1. Full reproduction (needs git, Node >= 22 and Foundry):
npm ci
npm run vendor:sync          # fetch the ten repositories at the locked commits
npm run bundle:verify        # rebuild artifacts/bundle.json and compare its hash
npm run demo                 # anvil + world deploy + doctor, all local

# 2. World only (Node >= 22 and Foundry's anvil, no Solidity build):
npm ci && npm run demo

# 3. Containers (Docker with Compose):
docker compose up --build     # anvil + world + doctor; the address book lands in ./deployments
```

Against a running node:

```bash
npm run foga -- world deploy --world worlds/local.json --rpc http://127.0.0.1:8545 --out deployments/local.json
npm run foga -- doctor --world deployments/local.json --rpc http://127.0.0.1:8545 --out deployments/local.doctor.json
```

Against Sepolia (read-only; needs an RPC that the machine can reach):

```bash
FOGA_RPC_URL=$SEPOLIA_RPC_URL npm run foga -- doctor --world worlds/sepolia.json --attach --out deployments/sepolia.doctor.json
```

Or in two steps through any relay that has an RPC — export the plan here, collect results there, evaluate anywhere:

```bash
npm run foga -- doctor --world worlds/sepolia.json --attach --export-probe sepolia.probe.json
node scripts/relay.mjs $SEPOLIA_RPC_URL sepolia.probe.json > sepolia.results.json
npm run foga -- doctor --world worlds/sepolia.json --attach --import-results sepolia.results.json --out deployments/sepolia.doctor.json
```

Offline builds: if the machine cannot reach the solc binary mirror, download the three static binaries from the Solidity GitHub releases with `scripts/install-solc.sh` and export `FOGA_SOLC_DIR`.

## Layout

```
artifacts/           bundle.json (+ .sha256): the compiled ten-ERC stack, committed and CI-verified
build/               build profiles per repository and the README-published interface ids
contracts/           FOGA's own local-only contracts (Identity8004Stub) with Foundry tests
deployments/         world files and doctor reports (local outputs are gitignored; examples are kept)
docker/, docker-compose.yml
docs/                design memo, compatibility matrix, version lock, build, world, doctor
scripts/             install-solc.sh, relay.mjs
src/                 TypeScript: build/ (vendor + bundle), world/ (plan + deploy), doctor/ (probe + evaluate), cli.ts
test/                unit tests for the bytecode and interface-id utilities
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
foga doctor --world <world|config> [--attach] [--rpc <url>] [--out <report>] [--export-probe <file>] [--import-results <file>]
foga probe relay-script
foga demo [--port <n>] [--keep]
```

During development the CLI runs from source with `npm run foga -- <args>`; `npm run build` compiles it to `dist/` for the `foga` binary.

## Principles

- The ten reference implementations are used as they are. Gaps found while composing them go back upstream as separate changes; FOGA keeps no forks.
- Compile conditions are never changed by FOGA, only orchestrated. The bundle records compiler, settings, source hashes and build inputs so anyone can rebuild it.
- A world file names its chain, its bundle hash, its deployment batch and, for forks, the source block, so two local chain-id-31337 worlds cannot be confused.
- Every claim the doctor makes carries one of five verdicts; a green ERC-165 probe is never presented as full compatibility.

## License

Apache-2.0 for the code in this repository. The compiled artifacts in `artifacts/bundle.json` are built from the upstream repositories, which are CC0-1.0 (ARD material vendored upstream is Apache-2.0); see NOTICE.
