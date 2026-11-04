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
