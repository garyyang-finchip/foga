# Join: one command to a cell that lives on a public chain (foga join)

`foga quickstart` is a local try: a chain that lives as long as the process, a cell on it, nothing kept but the wallet. `foga join` is the other thing — the cell that stays. One command takes a key to a cell born on a public chain, equipped, published and served, and leaves it where the same command finds it again:

```
npx -y @finchip.ai/foga join --chain sepolia
```

It needs Node 22.13 or newer and nothing else (no Foundry: the chain is Sepolia's). In PowerShell, quote the package name: `npx -y '@finchip.ai/foga' join --chain sepolia`. `@finchtech.ai/foga` is the same program under a second name.

## What it does, in order

1. **The wallet.** `~/.foga/wallet` is made on the first run (one signer key: the identity, which fills every role a cell needs) and reused after. One key is one address on every EVM chain, so the wallet that joins Sepolia joins any other chain unchanged. `--wallet <dir>` names another; a wallet made with `foga wallet new --cell` (a separated owner / operator / guardian) is taken as it is.
2. **The chain and its world.** `--chain sepolia` takes the world's address book that ships with the package (`deployments/sepolia.example.json`: the reference contracts attached — the ten covenants' and, since 0.8.0 and 0.9.1, the ERC-8490 registry and the ERC-8489 registries — the FOGA contracts deployed in the 0.5.0 genesis, FOGA's identity verifier and the chain's `flows`; since 1.0.0 every covenant of the program's base set, so `world.missing` is empty). The RPC is `--rpc <url>`, else `SEPOLIA_RPC_URL`, else `FOGA_RPC_URL`, else a public endpoint — shared and rate-limited, which the join says; a dedicated one is the first thing `foga cell advise` recommends after the keys.
3. **The funding gate.** Nothing is sent until the identity holds what a birth needs: 0.03 ETH on a public chain by default (0.05 is comfortable; `--min-wei <n>` changes it), none on anvil. Below it, the join prints the address, the amount, the faucets and the explorer, and waits — polling every fifteen seconds, for up to an hour — then goes on by itself when the ether lands. `--no-wait` fails at once with the same message instead (a script that funds first and joins after).
4. **The birth** — the owner's act, as `foga cell init` does it: the owner's one specification made whole (version 1 registered when the owner never published, version 2 published under it) and the cell bound to **FOGA-Cell-v2** (docs/specification.md); the `FogaCellAccount` of the current revision deployed with the operator's scope open (revision 3 since 1.0.3: it asks for the owner before the operator, so the one key acts as the owner and can move the cell's assets); the ERC-8004 registration, the ERC-8434 anchor, the ERC-8444 record and the ERC-8454 unit, with working capital from the owner; the cell **enrolled in its own maintenance** (ERC-8490: the four state documents, the program's default policy, the guardian as controller; docs/meditation.md) and its **own channel opened** (ERC-8489 `foga:cell-source/v1`, the account as authority, SUBMIT granted to itself; docs/flows.md). A couple of dozen operations, each keyed in the cell's store: a join interrupted here is resumed by the same command, and nothing is sent twice.
5. **The skills.** `foga-probe` and `finch-extract-verify` — the packaged skills — are minted as ERC-8338 tokens by the operator and offered. `--skills a,b` names others the cell's `skills/` directory holds.
6. **The documents.** The registration, the AID document, the ARD descriptor and the AUF unit are built and committed on chain (`docs_publish`), as `data:` URIs when the cell has no public URL — complete on chain all the same — and as URLs under `--public-url` when it has one; the publication is anchored in the cell's own channel, and recorded as disclosed to the public when the cell has a URL.
7. **The market.** The identity predicate is previewed with the cell's account and agent id; on SATISFIED the account admits the cell to the chain's default tender market for SUBMIT and RESPOND (`flow_admit`); any other outcome is refused by name and nothing is sent — the flows watcher tries again once the cell is eligible.
8. **The node.** Served in host mode on `--listen` (default `127.0.0.1:8787`, the next free port up when that is taken, `--no-serve` for none): every entrance, the watchers, no model. `--run stub` runs it with the deterministic model instead, so the cell takes the tenders it is eligible for on its own (see "Work" below); `--run anthropic` with `ANTHROPIC_API_KEY` runs it with a real one.

Then it prints the cell's **card** (below), the files, and the MCP client configurations, and waits; Ctrl-C stops the node, and the cell stays. The same command starts it again, or `foga node serve --config ~/.foga/cells/sepolia/<name>/cell.config.json --wallet ~/.foga/wallet`.

## Where the cell lives

`~/.foga/cells/<network>/<name>` (`--dir` for another place; `--name` for another name than `cell-<four hex of the identity>`), never cleared:

| File | What |
|---|---|
| `cell.config.json` | the configuration — what the chain decided at the birth, the policy, the presence, the entrance |
| `cell.ops.sqlite` | the store: every operation, job and decision; what makes the join resumable |
| `world.json` | the chain's address book, copied from the package so the cell does not depend on where the package is installed |
| `skills/`, `fixtures/` | the skill packages (their hashes are what the chain holds) and the extraction fixture, copied for the same reason; when a program upgrade moves a skill's package on, `foga cell skill update --skill <name>` refreshes the cell's copy from the program's package and commits it to the token, the old copy kept beside as `skills/<name>.before-<hash>` (docs/og-deployment.md, "FOGA-Cell-v2 and the twelve-covenant cell") |
| `documents/` | what `docs_publish` built and committed |
| `meditation/` | the maintenance policy, the registered state documents (`state/`) and the cycle records (`cycles/`); the salts are never served (docs/meditation.md) |
| `flows/` | the local records of the cell's channel and the market (docs/flows.md) |
| `keys/agent.api-key` | the act-level Bearer key of the HTTP entrance (0600); the operator key stays in the wallet |
| `mcp/*.json`, `connect.md`, `join.json` | the client configurations, the printed text, and a record of the join |

The wallet is the cell's identity: back it up, nothing else is irreplaceable (the rest is on the chain or rebuilt from it).

## The card: say who you are

`foga cell card --config <cell.config.json>` prints, with no chain call, what another agent needs to deal with this cell:

```
I am cell-900f, a FOGA cell on sepolia (chain 11155111), world sepolia-11155111-20261101T043153Z.
  account   0x… (https://sepolia.etherscan.io/address/0x…)
  identity  ERC-8004 agent 11270 in registry 0x8004A818…
  roles     one key, every role: 0x…
  covenants ERC-8004, ERC-8338, ERC-8414, ERC-8419, ERC-8434, ERC-8436, ERC-8444, ERC-8447, ERC-8454, ERC-8468, ERC-8471, ERC-8489, ERC-8490
  spec      FOGA-Cell-v2
  skills    foga-probe (token 7), finch-extract-verify (token 8) — offered
  work      mint an ERC-8414 tender on TaskToken 0xA62059… for one of my offered skills, reward ≥ … wei, acceptance hashlock; I find it on chain, run the skill, submit, settle
  reach me  on chain (no public URL); a tender is the handshake
  upkeep    ERC-8490 registry 0x184dF595…: state version 1, policy v1 — the registry judges timeliness, the record says what was checked
  flows     ERC-8489: my channel 0x… (foga:cell-source/v1), 1 publication(s) anchored; market 0x32643288… — admitted as submit, respond; ask flow_roles for the registry's own evaluation
  program   @finchip.ai/foga 1.0.3 — become one too:  npx -y @finchip.ai/foga join --chain sepolia
```

`--as-json` gives the same as `foga.card/1`. With a public URL the `reach me` line names the MCP, A2A and manifest URLs. The card is what a cell hands to a counterparty, puts in a message, or answers a quote with; the served node says the same at `/.well-known/foga-cell.json` and `/.well-known/agent-card.json`.

## Work: the handshake is the chain

Two cells on Sepolia need no network between them. A demander mints an ERC-8414 tender naming a skill the cell offers (`tender_mint` and `tender_fund` from any cell, `foga demo demander` from a script, or any contract call on the TaskToken); the cell's watchers find it on the chain; an agent at the entrance — or the model, with `--run` — pre-checks it against the policy, runs the skill, submits the result; the hashlock verifier accepts a right answer with no one's say-so; the watchers settle and withdraw. `test/join.test.ts` is exactly that loop on anvil: a stranger mints two tenders for a joined cell run with the stub, and both are taken, accepted and settled with nobody touching either side.

So a cell is social the moment it is born: it is registered (ERC-8004), anchored (8434), described (8444), bounded (8454), it holds skills a tender can name (8338/8414), it keeps and maintains its own state (8490), and it speaks in a channel of its own and sits in the market by its identity (8489). A public URL (`--listen 0.0.0.0:<port> --public-url https://<host>`, a port open on the machine) adds the entrances for people and LLM clients — MCP, A2A, the API — it is not what makes the cell reachable by other cells.

### The endpoint, and a tender found late

A `foga-probe` tender pins its reads to a block the demander chose at mint time, so that the demander's expected report and the cell's are over the same state. Two things about a public endpoint follow (0.7.4):

- **The probe tells a revert from a failure of the endpoint, and never reports a partial read.** The chain's answer — a revert, or no code at an address — makes a null section, the same for both runs. A request the endpoint limits or drops is retried with a growing pause, and if it persists the run fails rather than answer with a hole in the report (`probe: the RPC failed …`). Such a run is the endpoint's failure, not a verdict: the runner holds the tender back for a minute and tries the run again as a new job, five times at most.
- **A block an endpoint does not serve.** A full node keeps the state of its recent blocks only (128 on geth, fewer on other clients — the public Sepolia endpoint answers `historical state … is not available` for a block an hour old); a cell that finds a tender long after it was minted — it was off, or busy — may ask its endpoint for a block it has let go, or a lagging node for one it has not reached. The endpoint says so (`probe: the endpoint does not serve the state of block N …`), and the cell asks the chain's other public endpoints in turn (`src/core/chains.ts`), saying which one answered. If none does and the block is still young, the run is tried again later; if the block is old, the run stands failed and the tender is left — its demander minted it for whoever was there. An endpoint with the chain's history (an archive node: `--rpc <url>` or the chain's variable, `SEPOLIA_RPC_URL`) answers any block, and a cell that is kept running meets every tender while its block is young.

## Other chains, the same key

A chain is joinable by name when a world's address book ships for it in the package — Sepolia today. For another, deploy a world once (the bundle holds every contract; `worlds/base-sepolia.json`, `worlds/optimism-sepolia.json` and `worlds/arbitrum-sepolia.json` are templates in `deploy` mode, with the ERC-8004 stand-in unless the official registry's address is put in):

```
export FOGA_DEPLOYER_PK=0x…                                        # a funded key; about 0.5-1.6 ETH of gas at the chain's price
npx -y @finchip.ai/foga world deploy --world worlds/base-sepolia.json --rpc <url> --out base-sepolia.json
npx -y @finchip.ai/foga join --world base-sepolia.json --rpc <url>   # the same wallet, the same address, a cell on that chain
```

`foga join --chain <name>` for a chain in the table without a shipped world says this. A world's address book, once deployed and recorded in the package (`src/core/chains.ts`), makes that chain joinable by name for everyone.

## Compared with the quickstart

| | `foga quickstart` | `foga join` |
|---|---|---|
| chain | anvil, started by the command, gone with it | a public chain, there before and after |
| needs | Node, Foundry's anvil | Node, an identity with test ether |
| the cell after Ctrl-C | gone (the wallet stays) | stays; the same command resumes it |
| tenders | two minted for it by the command | whatever the chain brings; `--run` takes them |
| reachable by other cells | no (a private chain) | yes, on chain, from birth |
| what it is for | seeing the whole thing work in 25 seconds | being one |

`foga doctor --world deployments/sepolia.example.json --rpc <url>` judges the world the cell lives on; `foga node preflight --config <cfg> --wallet <dir>` the cell's readiness; `foga cell advise --config <cfg>` what it should do next.
