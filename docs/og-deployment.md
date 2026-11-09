# Deploying the OG instance (foga.finchip.ai)

The Finch OG Agent is one FOGA cell, run as a served node on a small Linux box (an EC2 instance), reachable at `https://foga.finchip.ai`. It runs in **host mode** by default: every entrance answers — `/mcp`, `/api`, `/a2a`, `/.well-known/*`, `/documents/*`, `/healthz` — the watchers keep whatever the cell committed to, and no model runs (design memo, section 10). A model is started only on demand (`foga node run`), for a Loop D run or a spell of autonomous work, and stopped after. This is the Phase 3d-3 runbook; `deploy/` holds the three files it refers to (`foga-og.service`, `Caddyfile`, `og.env.example`).

Nothing here is a local sandbox. The chain is Sepolia; the cell's state lives there, and the box holds only what is needed to serve and to sign: a configuration, a store, and one key.

## How the cell came to be

The OG cell was born on Sepolia by the path any cell takes; nothing about it is special to this box. On the box: `foga wallet new` (one key, the cell's identity, in a 0600 file; no network), `foga cell new` (the configuration: the world `deployments/sepolia.json`, the presence and the public face below), the owner address funded from a faucet, `foga cell init` (the birth — the revision-2 `FogaCellAccount` with its allow-list open to the operator, the ERC-8004 registration, the FOGA-Cell-v1 specification binding, the anchor), `skill_mint --offer` for `finch-extract-verify`, `foga cell docs publish` for its documents, then `foga node serve`. It is ERC-8004 agent 11261. The Finch OG Agent's earlier line on Sepolia, agent 11255 (name A-prime, `deployments/sepolia.cell.example.json`), is the revision-1 body the 2c genesis left at its T9 succession and stays as that evidence: a revision-1 account has no operator allow-list, so a node will not act on it, and rather than migrate it the OG was born complete. No key changed hands.

The box holds one key, the signer's, which is owner, operator and guardian at once — the default, right for a first run. `foga cell advise --config og.config.json` says what comes next for this cell as for any other, and the first item is to separate the roles: `foga cell migrate --config og.config.json --to <new.config.json> --operator <a fresh operator address>` moves the cell to an account whose operator is not its owner (the identity, the skill and the documents follow; docs/node.md, "Birth and migration"), after which only the **operator** key stays on the serving box and the owner key goes offline. `foga node preflight --config og.config.json --wallet <wallet>` is the readiness check either way.

Without a key the same deployment serves reads, dry runs and builds — a complete, useful public endpoint on its own.

## The box

One dedicated OS user, a checkout it only ever pulls, and the cell's three files beside it:

```
sudo useradd --system --home-dir /opt/foga --create-home --shell /usr/sbin/nologin foga
sudo -u foga git clone https://github.com/garyyang-finchip/foga /opt/foga/foga   # public repo: a read-only clone, never pushed
cd /opt/foga/foga && sudo -u foga npm ci && sudo -u foga npm run build            # the box builds dist/; it never needs git credentials
```

The box only ever `git -C /opt/foga/foga pull`s and runs; it never pushes, so no GitHub credentials live on it and no username/password prompt is ever reached. Node 22.13+ is the one requirement (`node:sqlite` needs no flag there); `nvm` or the distro's Node 22 both do. Foundry is **not** needed to serve — `anvil`/`forge` matter only for a local chain or a Sourcify run, not for host mode.

The cell is three files under `/opt/foga`, and they are the whole of it:

| File | What | Backed up |
|---|---|---|
| `/opt/foga/cell.config.json` | the configuration (`foga.cell-config/1`) — the account, the policy, the presence, `runtime.http` | yes |
| `/opt/foga/cell.ops.sqlite` (+ `-wal`, `-shm`) | the store: operations, jobs, decisions, facts | yes |
| `/opt/foga/wallet/signer.key` | the one key the node signs with (mode 0600, owner `foga`) | yes, and separately — it is the identity |

Everything else — the deployed contracts, the agent's on-chain documents, the skill token — lives on Sepolia, not on the box. Moving the cell to another machine is copying those three files and pointing the service at them (below).

## The configuration for serving

Beyond what `foga cell new` writes, the serving node needs its public face set (`src/node/config.ts`, `runtime.http`):

```json
"runtime": {
  "http": {
    "listen": "127.0.0.1:8787",
    "publicUrl": "https://foga.finchip.ai",
    "allowedHosts": ["foga.finchip.ai"],
    "allowedOrigins": [],
    "documentsDir": "documents"
  }
},
"presence": {
  "name": "Finch OG Agent",
  "homepage": "https://foga.finchip.ai",
  "provider": { "organization": "FinChip.ai", "url": "https://finchip.ai" }
}
```

`publicUrl` at `https://foga.finchip.ai` also makes this the cell that serves the maintainer's services catalog: every manifest points at `https://foga.finchip.ai/services.json`, and the node answers it (`foga.services/1`) from what its build knows; to change the live list without a release, drop a `services.json` on the box and have Caddy serve that path ahead of the proxy (`handle /services.json { root * /opt/foga/www; file_server }` before the `reverse_proxy`). `publicUrl` is what the cell commits its documents under and what the agent card advertises; `allowedHosts` must name the public host, because the node binds the loopback and checks the `Host` header the proxy forwards (a request whose Host is not allowed is refused — this is the Origin/Host check the protocol asks for, not CORS). Then build and publish the documents once, so `/.well-known/*` and `/documents/*` answer and the chain holds their URIs: `foga cell docs publish --config /opt/foga/cell.config.json --wallet /opt/foga/wallet` (docs/documents.md). `foga node preflight` reports whether the public URL answers for the cell and whether the host is allowed.

## systemd and Caddy

Caddy terminates TLS for `foga.finchip.ai` and forwards to the loopback node; systemd keeps the node running as the `foga` user with one key and nothing else in its environment.

```
sudo cp /opt/foga/foga/deploy/foga-og.service /etc/systemd/system/foga-og.service
sudo install -d -o foga -g foga /etc/foga
sudo cp /opt/foga/foga/deploy/og.env.example /etc/foga/og.env    # edit: the key file path and a Sepolia RPC
sudo chown foga:foga /etc/foga/og.env && sudo chmod 600 /etc/foga/og.env
sudo systemctl daemon-reload && sudo systemctl enable --now foga-og

sudo cp /opt/foga/foga/deploy/Caddyfile /etc/caddy/Caddyfile      # or import it into an existing one
sudo systemctl reload caddy
```

DNS: an `A`/`AAAA` record for `foga.finchip.ai` at the box's address (Caddy then gets the certificate on first request). `docs.foga.finchip.ai` is a separate `CNAME` to GitHub Pages — the documentation site is not served from this box. The unit's environment is deliberately two lines (`deploy/og.env.example`): the operator key file and the RPC. A node refuses to start if its environment also carries an owner, guardian, deployer or mnemonic key (`src/node/keys.ts`), so keep it to those two.

Without a key in `og.env` the node serves reads, dry runs and builds — valid and public. With the operator key, the watchers run beside the server and the cell acts.

## Bring-up and verification

```
sudo systemctl status foga-og                                        # active (running)
curl -s https://foga.finchip.ai/healthz                              # {"ok":true,"cell":"…","account":"0x…","chainId":11155111,…}
curl -s https://foga.finchip.ai/.well-known/agent-card.json | jq .name
foga node preflight --config /opt/foga/cell.config.json --wallet /opt/foga/wallet   # the readiness reconciliation (docs/node.md)
```

A first smoke of the public entrances from anywhere: `npx -y @finchip.ai/foga` is not needed — any HTTP client does. An A2A quote over the wire:

```
curl -s -X POST https://foga.finchip.ai/a2a -H 'content-type: application/json' -H 'A2A-Version: 1.0' \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"message":{"messageId":"hello","role":"ROLE_USER","parts":[{"text":"what can you do?"}]}}}'
```

should answer a `TASK_STATE_COMPLETED` quote of the cell's offered skills and the terms a tender must meet.

## The cell's own maintenance (0.8.0)

The OG was born before the ERC-8490 registry was known, so its world file has no entry for it and it is not enrolled; the extension in place (docs/meditation.md) brings it on without touching its identity, account, store or documents. With the 0.8.0 build in place (`git pull`, `npm ci`, `npm run build`), the owner's key — the box's one key — extends the cell, the service restarts so the node opens the world with the registry in it, and the first cycle is run and read back:

```
foga cell extend --covenants 8490 --config /opt/foga/cell.config.json --wallet /opt/foga/wallet   # the world file (a .before-8490.bak beside it), the scope, the enrollment, read back
sudo systemctl restart foga-og
foga meditate status --config /opt/foga/cell.config.json                                        # enrolled, state version 1, every layer FRESH and never completed
foga meditate run --config /opt/foga/cell.config.json --wallet /opt/foga/wallet --dry-run        # the cycle computed and shown; nothing sent
foga meditate run --config /opt/foga/cell.config.json --wallet /opt/foga/wallet                  # the first cycle: the routines, the four documents, one report
curl -s https://foga.finchip.ai/documents/maintenance/policy.json | jq .onchain
curl -s https://foga.finchip.ai/.well-known/foga-cell.json | jq .maintenance
```

The cycle's record lands under `<configuration directory>/meditation/cycles/` (`maintenance.dir`) and is served at `https://foga.finchip.ai/documents/maintenance/cycles/<id>.json`, where anyone recomputes the hash the registry holds. `foga node preflight` gains a `maintenance` area. A cell joined with `foga join` is extended the same way, with its own configuration (`~/.foga/cells/sepolia/<name>/cell.config.json`) and wallet (`~/.foga/wallet`), after stopping the join and before starting it again (the join never overwrites the world file it finds). Since 0.8.2 the served node runs the cycles that fall due by itself (`maintenance.auto`, docs/meditation.md "Automatic cycles"); the tick line in `journalctl -u foga-og` says what the watcher found. A cell upgraded from 0.8.0/0.8.1 has a new policy document hash (the watcher's pace and cooldown are part of it): `foga meditate policy --config <cfg> --wallet <wallet>` records it as policy v2 (the owner's key; optional — the on-chain fields are unchanged).

## The cell's information flows (0.9.0)

ERC-8489 enters the same way (docs/flows.md), with one step more because a market is a shared context: the maintainer bootstraps the chain once — FOGA's two paradigms registered in the family `foga`, the default tender market opened, through the reference cell's account, whose owner key is the box's one key — before any cell on that chain can open a channel or join the market. The seven upstream registries are in the packaged Sepolia world, and the OG's own world file (`deployments/sepolia.json`, written before the covenant) has none of them, so the bootstrap adds them to that file first (a `.before-8489.bak` beside it); FOGA's identity predicate verifier is not deployed upstream, so the bootstrap deploys it next from the bundle (the owner's own transaction) and records it in the same file; then the paradigms and the market go through the account. With the 0.9.0 build in place:

```
foga flow bootstrap --config /opt/foga/cell.config.json --wallet /opt/foga/wallet      # the maintainer's one-time act: the paradigms, the market; prints the world file's flows block
foga cell extend --covenants 8489 --config /opt/foga/cell.config.json --wallet /opt/foga/wallet   # the scope, the OG's own channel and its SUBMIT grant; a one-key cell also anchors its publication and joins the market
sudo systemctl restart foga-og                                                          # the node opens the world with the registries and the flows in it
foga flow status --config /opt/foga/cell.config.json
curl -s https://foga.finchip.ai/.well-known/foga-cell.json | jq .flows
curl -s https://foga.finchip.ai/documents/flows/channel.json
```

This was done on 2026-11-09: the OG's account `0xD7155E48f83e1fEa9eAFED0200671638f290ED49` is the controller of the family `foga` on Sepolia and the authority of the default market channel `0x32643288…`; `foga:cell-source/v1` is `0xc5a7f453…` (the same id on every chain) and `foga:tender-market/v1` for Sepolia's registries is `0xb6d5d67b…`; FOGA's identity verifier is at `0x7d5301B3CCee159341a25791001e295F7F226685`. Since 0.9.1 the `flows` block and the verifier are in `worlds/sepolia.json` and `deployments/sepolia.example.json`, so every cell that joins Sepolia opens its channel at birth and is admitted to the market by `foga join`; a cell joined before 0.9.1 is extended with `foga cell extend --covenants 8489` (the packaged world carries everything it needs; no `--from`), after stopping its join and before starting it again. The watcher anchors each new publication, keeps the market admission and, for a cell with a public URL, records the disclosure of a publication anchored before the record existed; `foga node preflight` gains a `flows` area. The OG's own publication was anchored by the extension and is served at `https://foga.finchip.ai/documents/flows/channel.json`; the paradigms' descriptors at `…/documents/flows/paradigms/`.

## The MCP registry listing

With `https://foga.finchip.ai/mcp` answering, the cell was listed in the MCP registry as `io.github.garyyang-finchip/foga` so clients and other agents discover it (docs/mcp.md, "The package"). `server.json` at the repository root is the npm-package manifest; the OG cell also writes its own `server.json` among its documents (`foga cell docs build`) with this cell's MCP URL as the remote. Publishing is the package owner's, from a checkout, and needs the remote reachable:

```
mcp-publisher login github            # a browser device-code flow; no long-lived credential on the box
mcp-publisher publish                 # publishes the manifest whose mcpName the npm package already carries
```

This is a one-time registration (and a re-publish when the manifest changes), not part of the running service.

## The documentation site

`docs.foga.finchip.ai` is a static site served by GitHub Pages, not from this box. The `site/` folder is it: `index.html` (a landing page with the covenants, the one-command quickstart and the links), `llms.txt` (the machine-readable index answer engines and agents ingest — llmstxt.org), and `CNAME` (the custom domain). Point GitHub Pages at it in the repository settings (Pages → deploy from the `main` branch, folder `/site`) and add a DNS `CNAME` record for `docs.foga.finchip.ai` at `garyyang-finchip.github.io`. This is the free discovery surface that pairs with the cell's own `/.well-known/foga-cell.json` (docs/propagation.md): being well-described and findable, at no cost, is what gets FOGA adopted.

## Sourcify — verifying the Sepolia sources

The 15 FOGA-deployed contracts of the Sepolia world are verified from the bundle's own compiler runs (docs/world.md, "Verifying the sources"). This needs the build-info (so Foundry on the box, or run it from a checkout that has already done `npm run bundle:verify`) and a Sepolia RPC, and it sends nothing to the chain:

```
npm run bundle:verify                                                # leaves .foga-build/out/<repo>/build-info/
foga world verify --world deployments/sepolia.json --sourcify        # submits each FOGA-deployed contract to Sourcify
```

A local chain would be a dry run; Sepolia is live, so this is the real submission. The report (`foga.sourcify/1`) names each contract `exact_match` / `match` / `already` / `failed`, and the command exits non-zero if anything is missing or failed.

## Backup, restore, move

The cell is portable because it is three files and a public chain. To back up: copy `cell.config.json`, the store (`cell.ops.sqlite` and its `-wal`/`-shm` siblings — stop the service first, or copy them together while it is briefly stopped so the write-ahead log is consistent), and the key file (which is the identity — keep it somewhere a server backup does not reach). To restore or move to another box: install Node and Caddy as above, drop the three files in place, point `/etc/foga/og.env` at the key, and `systemctl enable --now foga-og`. Nothing on-chain changes — the same account, the same documents, the same agent id; the new box simply serves and signs for the cell that already exists on Sepolia. There is no database to migrate and no local chain to re-seed.

To retire a box without moving the cell, stop and disable the service and keep the three files; the cell goes quiet (its anchor eventually STALE until a heartbeat) but loses nothing. Bringing it back up anywhere restores it, and the first watcher tick sends the heartbeat that makes the anchor ACTIVE again.

## If the OG is off

Nothing that makes a new cell passes through this box: the replication pointer names the npm package, `foga quickstart` needs the npm registry alone, a public-chain birth needs the registry, an RPC and the world's contracts on the chain. Off, the OG loses its own surface — `foga.finchip.ai`, its manifest and card, its place as a counterparty — and the package, the repository, the registry's package entry and the documentation site carry on (docs/extending.md). Once it is back, `foga cell advise --config <cfg>` is the checklist for this cell as for any other.
