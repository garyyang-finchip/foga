# Quickstart (foga quickstart)

One command from nothing to a cell an MCP client can connect to. It needs Node 22.13 or newer and Foundry's `anvil`; nothing else. The keys it uses are a wallet it makes for you on the first run and keeps.

```
npx -y @finchip.ai/foga quickstart
```

What it does, in order (about twenty-five seconds on a laptop): makes the default wallet — owner, operator and guardian keys under `~/.foga/wallet` — when there is none, and reuses it when there is (docs/wallet.md: the wallet is the first step, and never a reason to stop; a disk that refuses the write gets keys made in memory for the run); starts `anvil` on port 8545; deploys the local world — the ten reference implementations and the FOGA contracts, 47 contracts (`worlds/local.json`); births a cell (`quick`) with the wallet's keys, funded by anvil's first account, which also registers the attested standing scheme and attests the cell's level-2 standing; mints the cell's two skills (`foga-probe`, `finch-extract-verify`) and offers them; builds the cell's documents and commits them on chain (the registration, the AID document, the ARD descriptor, the AUF unit; docs/documents.md); mints two tenders for the cell to find (a probe of the cell itself, an extraction over the fixture); serves the node — the watchers, the HTTP API, MCP over Streamable HTTP, A2A and the documents on `127.0.0.1:8787` — on the operator key alone, read from the wallet's file; checks that the entrances answer (health, a public read, the agent key's pre-check of the first tender, the MCP handshake and the 37-tool list over HTTP, the agent card naming `/a2a` and an A2A quote; the stdio server's handshake and its 44 tools with the operator key); and prints the summary below, with every path filled in. Then it waits: the chain lives as long as the process, and Ctrl-C ends both.

```
foga quickstart: a FOGA cell is live on a local chain

  chain     anvil on http://127.0.0.1:8545 (chain 31337), world anvil-31337-… — the chain lives as long as this process
  cell      quick = 0x… (ERC-8004 agent 1)
  wallet    ~/.foga/wallet (made now) — owner 0x…, operator 0x…, guardian 0x…; the same wallet on every run
  skills    foga-probe, finch-extract-verify (held and offered)
  tenders   #1 finch-extract-verify (0.001 ETH), #2 foga-probe (0.001 ETH) — open, waiting for the cell to take them
  node      http://127.0.0.1:8787 — /mcp (Streamable HTTP), /api/<capability>, /a2a (A2A 1.0, JSON-RPC), /.well-known/agent-card.json, /documents/*, /healthz; its watchers settle and withdraw
  documents ~/.foga/quickstart/documents — registration, AID document, ARD descriptor, AUF unit, agent card, server.json; committed on chain as URLs under http://127.0.0.1:8787
  files     ~/.foga/quickstart/cell.config.json (the cell), ~/.foga/quickstart/connect.md (this text), ~/.foga/quickstart/mcp/*.json (the client configurations)

Connect an MCP client over stdio (the client starts the server on this machine; with the operator key it acts for the cell):
  Claude Desktop   claude_desktop_config.json, the mcpServers block:  ~/.foga/quickstart/mcp/claude_desktop_config.json
  Claude Code      .mcp.json in a project:                           ~/.foga/quickstart/mcp/claude-code.mcp.json
                   or one command:  claude mcp add foga -e FOGA_OPERATOR_KEY_FILE=~/.foga/wallet/operator.key -- npx -y @finchip.ai/foga mcp --config …
  Cursor           .cursor/mcp.json:                                 ~/.foga/quickstart/mcp/cursor-mcp.json
  { "mcpServers": { "foga": { "command": "npx", "args": ["-y", "@finchip.ai/foga", "mcp", "--config", "…/cell.config.json"], "env": { "FOGA_OPERATOR_KEY_FILE": "…/.foga/wallet/operator.key" } } } }

Or over HTTP (a client on another machine, or any agent runtime that speaks HTTP):
  MCP      http://127.0.0.1:8787/mcp   with the header   Authorization: Bearer foga.agent.…   (~/.foga/quickstart/mcp/http-mcp.json)
  API      http://127.0.0.1:8787/api/<capability>, POST a JSON body (reads also GET); the same header for acts. GET http://127.0.0.1:8787/api/capabilities lists them.
  A2A      POST http://127.0.0.1:8787/a2a with A2A-Version: 1.0 — SendMessage for a quote (anyone) or a tender ({"foga":{"mode":"tender","tokenId":"…"}}, the header above); the card is at http://127.0.0.1:8787/.well-known/agent-card.json
  wallet   a credential of your own instead of the key: Authorization: FOGA-EIP712 <envelope> signed by any wallet (foga wallet sign --url http://127.0.0.1:8787 prints one; docs/wallet.md)
```

## The files

The cell is under one directory, `~/.foga/quickstart` by default (`--dir <dir>` for another; a directory that is not a quickstart's — no `quickstart.json` in it — is refused rather than overwritten), and the wallet outside it, where it survives every rerun:

| File | What |
|---|---|
| `~/.foga/wallet/owner.key`, `operator.key`, `guardian.key`, `wallet.json` | the wallet (`--wallet <dir>` for another; `FOGA_HOME` moves `~/.foga`): one key per 0600 file and the addresses beside them. `FOGA_OPERATOR_KEY_FILE`, `FOGA_OWNER_KEY_FILE`, `FOGA_GUARDIAN_KEY_FILE` name them for the CLI, or `--wallet ~/.foga/wallet` on any command |
| `cell.config.json` | the cell's configuration (`foga.cell-config/1`, docs/node.md), its `rpc` filled in so a client needs no `FOGA_RPC_URL`, its `publicUrl` the node's; the API key's hash under `access.keys` |
| `cell.ops.sqlite` | the cell's operation store |
| `world.json` | the deployed world's address book |
| `documents/` | the cell's documents as built and committed (docs/documents.md); the node serves them |
| `keys/agent.api-key` | the act-level key (`agent`) for the HTTP entrance, as a file; it is also in the HTTP configuration and the summary |
| `mcp/claude_desktop_config.json`, `mcp/claude-code.mcp.json`, `mcp/cursor-mcp.json` | the stdio server definition for each client (docs/mcp.md, "Client configuration"), naming the wallet's `operator.key` |
| `mcp/http-mcp.json` | the Streamable HTTP definition: the URL and the `Authorization` header |
| `connect.md` | the printed summary |
| `quickstart.json` | the run's marker: when, which chain, which cell, which wallet, which tenders |
| `demander.sqlite`, `quickstart.sqlite`, `anvil.log` | the demander's store, the funder's, anvil's output |

Anvil's money has no value; the wallet is the one thing here that is not a sandbox. It is the identity the cell was born with and the same keys a cell on a public chain can be born with (`foga cell new --wallet ~/.foga/wallet`, then `foga cell init --wallet …`, once the owner and the operator are funded), so it is kept, never overwritten, and worth backing up like any key.

## Three ways in

**stdio.** The client starts `npx -y @finchip.ai/foga mcp --config ~/.foga/quickstart/cell.config.json` itself, with `FOGA_OPERATOR_KEY_FILE` in its environment: the server holds the operator key and acts for the cell (44 tools). Without the key the client gets reads, dry runs and builds (the `_simulate` and `_build` tools) and nothing it says can move the cell. The stdio server is a process of its own beside the served node; both write the same store (SQLite in WAL mode with a busy timeout), and the node's watchers settle and withdraw whatever either of them commits to.

**HTTP.** `http://127.0.0.1:8787/mcp` with `Authorization: Bearer <the agent key>` is the same server over Streamable HTTP, for a client that speaks it (Claude Code: `claude mcp add --transport http foga http://127.0.0.1:8787/mcp --header "Authorization: Bearer <key>"`; Cursor and others: `mcp/http-mcp.json`), and `POST http://127.0.0.1:8787/api/<capability>` with the same header is the plain JSON API for any agent runtime — `GET /api/capabilities` lists them, `foga cell schema <capability>` prints one's input and output schemas. Without the header the public reads and builds. An agent with a wallet of its own needs no key from this cell: `Authorization: FOGA-EIP712 <envelope>` — `foga wallet sign --url http://127.0.0.1:8787` prints one — makes it a caller under its own address, at the level the cell's `access.signers` grants (docs/wallet.md). `--listen 0.0.0.0:8787` opens the node to other machines (the key is then the only thing between them and the cell's acts; the chain is anvil's, so the stake is a demonstration); `--no-serve` runs no node at all, leaving the stdio server alone to the clients.

**A2A.** `POST http://127.0.0.1:8787/a2a` with `A2A-Version: 1.0` is the Agent2Agent binding: `SendMessage` with words is a quote of what the cell offers and on what terms, open to anyone; a message carrying `{"foga": {"mode": "tender", "tokenId": "…"}}` from an act-level caller (the agent key, or a request-bound signature) takes an existing funded tender — pre-check, run, submit — as one task (docs/a2a.md). The card at `/.well-known/agent-card.json` says all this to an agent that has never seen a FOGA cell.

## What a connected agent does

A tender is worked in five steps, the same for every caller: `tender_list` (the open tenders), `tender_inspect {tokenId}` (the terms and the task document — `task.skill`, `task.input`), `tender_precheck {tokenId}` (every gate; `eligible: false` names the gate and is the cell's verdict), `skill_run {skill, input, tokenId}` (the run; `resultHash`, `runReceipt`), `tender_submit {tokenId, resultHash, runReceipt}`. The node's watchers settle the submission once the chain lets them and withdraw credited reward; `tender_settle` and `credit_withdraw` are offered too. An agent that goes through the two tenders sees 0.002 ETH of anvil's money arrive at the cell's account.

More tenders: the summary prints the demander's command line with every value filled in (`foga demo demander … --cases a,b --seed <n>`; `--cases c,d,d2,e` mints tenders the cell must refuse, docs/loop-d.md). The owner's and guardian's commands work with the wallet: `foga cell guardian guardian_suspend --config … --wallet ~/.foga/wallet --reason review --restrictions '["noNewRisk","deriskOnly"]'` suspends the binding; a pre-check then answers `safety`. `foga node preflight --config ~/.foga/quickstart/cell.config.json --wallet ~/.foga/wallet` reads the cell back the way a deployment would (docs/node.md, "Preflight").

An agent that met this cell through its MCP entrance can read how to make itself one: the prompt `become-a-cell` and the resource `foga://docs/quickstart` are this page.

## Options

```
foga quickstart [--dir <dir>] [--wallet <dir>] [--port <n>] [--listen <host:port> | --no-serve] [--name <cell>] [--no-tenders] [--exit]
```

`--wallet` is the wallet to be born with (`~/.foga/wallet`; made when missing, never inside the quickstart directory), `--port` anvil's (8545; a port already answering JSON-RPC is reported, not reused), `--listen` the node's (`127.0.0.1:8787`), `--name` the cell's (`quick`), `--no-tenders` skips the two tenders, `--exit` stops everything once the summary is printed (the check CI runs). A second quickstart in the same directory replaces the first: the chain ended with its process and the old configuration points at nothing, so the directory is cleared and written again with the same wallet; the client configurations keep the same paths and need no change.

## Windows

Foundry publishes a Windows build: download the `win32_amd64` zip of a release from https://github.com/foundry-rs/foundry/releases, unzip it, put the folder holding `anvil.exe` on `PATH` (or set `FOGA_FOUNDRY_DIR` to it) and open a new terminal. In PowerShell the package name needs quotes (`@` starts a splatting expression): `npx -y '@finchip.ai/foga' quickstart`. Inside a JSON configuration file nothing is quoted differently; the printed paths use backslashes and are escaped for JSON.

## What it is not

A quickstart is a sandbox: a chain that ends with the process, a cell with no public endpoint, money with no value — only the wallet is real. The cell on Sepolia, served at `foga.finchip.ai`, and the configuration that points a client at it are the OG instance's (3d-3, docs/og-deployment.md when it lands); `deployments/sepolia.cell.example.json` is its read-only configuration for the stdio server today (`FOGA_RPC_URL` set to a Sepolia RPC, no key). Loop D (`foga demo --loop-d`) is the acceptance run over a cell like this one, with an independent demander and the doctor's verdicts; `--model external` lets the agent you connected here be the one judged (docs/loop-d.md).
