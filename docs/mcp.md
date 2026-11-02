# MCP and HTTP (foga node mcp, foga node serve, foga node key)

`src/mcp/server.ts` and `src/http/server.ts` are the second and third entrances onto the capability catalog of docs/node.md (design memo, Phase 3, sections 4 and 5). They add no rule of their own: a request becomes a **caller** — who is asking, at what level, seeing which data — and `Catalog.invoke` decides as it does for the CLI. What the entrances own is the edge: which transport, how a caller is established, what a refusal looks like on the wire, and what a request may carry.

## Two transports, two trust premises

| Transport | Started by | Who uses it | Who the caller is |
|---|---|---|---|
| stdio | `foga node mcp --config <cell.config.json>` (`foga mcp --config …` is the same command; `npx -y @finchip/foga mcp --config …` from the npm package) | a local client on the same machine: Claude Desktop, Claude Code, Cursor | with `FOGA_OPERATOR_KEY[_FILE]` in the environment, the **operator** (every level and the operator's data); without a key, the **local user**: build level (reads, dry runs, builds) with the operator's view of the store |
| Streamable HTTP | `foga node serve --config <cell.config.json> [--listen host:port]`, path `/mcp` | remote clients, the public endpoint of the OG instance (3d) | without `Authorization`, the **public**: build level, public data; with `Authorization: Bearer <key>`, the grant the key names (`access.keys`, below); an unknown key is 401 |

The stdio server's stdout carries protocol messages alone; everything it says goes to stderr. A node process runs in a **node environment** (docs/node.md, "The watchers"): the operator key alone or no key at all, and an environment that also holds a phrase, a deployer key, an owner's or a guardian's key is refused before anything is read. Admin capabilities (`operator_rotate`, `guardian_suspend`, `guardian_resume`, `binding_present`, `identity_transfer`) are not offered over MCP or HTTP at all in Phase 3: they are the owner's and the guardian's CLI commands, run once with the key loaded for that command.

## Protocol revisions

The server is built with the official TypeScript SDK v2 (`@modelcontextprotocol/server` 2.4.0) and serves both protocol eras on both transports:

- **2026-07-28**, the current revision, is the main path: no `initialize` handshake, `server/discover` answers what the server is and offers, every request carries its protocol version and client identity in `_meta`, Streamable HTTP has no session id. A client pinned to this revision connects with one `server/discover`.
- **2025-era** clients (`initialize` / `initialized`, protocol versions 2025-11-25 and earlier) are served by the SDK's compatibility layer in stateless form (`legacy: "stateless"`): the handshake is answered, no session is kept, and the same tools, resources and prompt come back.

Which era a client speaks is the client's business. As of this writing Claude Code negotiates 2026-07-28 for stdio servers by default from 2.1.292 (October 2026; `MCP_PROTOCOL_NEGOTIATION=legacy` keeps the old handshake) and falls back to the 2025 handshake for a server that does not answer the probe; Cursor (3.21) speaks 2025-11-25 and earlier and opens with `initialize`, so it takes the compatibility path; both paths are tested in `test/mcp.test.ts` with the reference client (`@modelcontextprotocol/client`) pinned to 2026-07-28, in legacy mode and in auto mode, over Streamable HTTP and over stdio. The server speaks 2026-07-28 over stdio as well (the SDK's stdio client probes with `server/discover` before it attaches).

## The tool face

The tool list is the catalog filtered by the caller (`catalog.list(caller)`): a capability above the caller's visibility is not listed, and asking for it anyway is refused by the catalog, so hiding is never the authorization and showing never grants anything. Tool annotations are static in MCP, so a write capability becomes up to three tool definitions over one handler:

| Tool | Mode | Annotations | Offered when |
|---|---|---|---|
| `<name>` (a read) | — | `readOnlyHint`, `idempotentHint`, `openWorldHint` | the capability is visible to the caller |
| `<name>` (an act) | `act` | `destructiveHint: true` for a commitment or a transfer; `tender_precheck` and `aid_heartbeat` are not marked destructive | the caller's level is `act` |
| `<name>_simulate` | `simulate` | not read-only (a decision record is written), not destructive | the caller's level is `build` or above |
| `<name>_build` | `build` | `readOnlyHint: true`, `openWorldHint: false` (calldata for the caller's own account, `as`) | level `build` or above; not for `tender_precheck` (nothing to sign) or `skill_run` (nothing on chain) |

So the public gets 11 tools (the ten public reads and `tender_precheck_simulate`), a local keyless user 31 (the 15 reads and every dry run and build), the holder of an `act`/`caller` key 36, the operator 40; the catalog has 29 capabilities. Input and output schemas are the capability's zod schemas published as JSON Schema 2020-12.

Results are `structuredContent` under the tool's output schema (and the same JSON as text):

- A read answers with the capability's output; an output that is not an object (a nullable job or operation) rides under `result`, since `structuredContent` must be an object.
- An act that passed every gate answers `{ok: true, decisionId, jobId, operations, output}`; a dry run `{ok: true, decisionId, jobId, output}`; a build `{ok: true, as, calls: [{to, value, data, label}], decisionId}`.
- **A refused act is `isError: true`** with text `refused at <gate>: <reason>` and `structuredContent: {ok: false, gate, reason, decisionId, jobId}`. In MCP's terms a business refusal is a tool execution error, and the model reads the gate and the decision record's id rather than a protocol failure. Idempotency is unchanged: the same job asked again is `ok: true` with the stored result (decision gate `idempotent`), the same job under another request is refused at `conflict`.
- **`tender_precheck` reports an ineligible tender as an ordinary result**, `{eligible: false, gate, reason, decisionId}`: finding out is what it is for. An eligible one is `{eligible: true, decisionId, jobId, result}`.
- Bad input is a tool error (`isError`, gate `input`); a tool that is not offered to the caller is an unknown tool to the SDK.

Resources: `foga://world` (world id, chain, contracts, bundle hash), `foga://cell/status`, `foga://policy` (the budget and tender rules applied to every act), `foga://spec/foga-cell-v1` (the ERC-8468 specification every cell adopts), `foga://docs/compatibility-matrix` (text/markdown). One prompt, `take-tender` (`tokenId`): work one tender the way the operator would — inspect, pre-check, run the skill, submit, settle — and stop at a refusal rather than look for a way around it. `spec_read` is the same material as a tool, for clients that read tools only.

## The HTTP API

Same port, same catalog (`node:http`, no framework; the dependency tree stays ethers, zod and the MCP SDK):

| Path | What |
|---|---|
| `POST /mcp` (and `GET`/`DELETE` as the protocol era defines them) | MCP over Streamable HTTP |
| `GET /healthz` | `{ok, cell, account, worldId, chainId, block, version}`; 503 when the chain does not answer |
| `GET /` | the version, `cell_status` as the caller sees it, the number of decision records, the endpoints |
| `GET /api/capabilities` | the catalog as this caller sees it (name, action, visibility, principal, modes, schemas) |
| `POST /api/<capability>` `[?mode=simulate\|build\|act]` | the capability with the JSON body as input (`application/json`); `act` is the default mode |
| `GET /api/<read capability>?<field>=<value>` | a read with query parameters as input |
| `GET /api/jobs/<jobId>`, `GET /api/operations/<operationId>`, `GET /api/decisions[?capability=&verdict=&limit=]` | `job_status`, `operation_status`, `decision_list` |
| `/.well-known/*`, `/documents/*` | 404 `not published yet` (3d) |

Status codes say what kind of refusal it is: **401** the Authorization header carries no key the node knows; **403** a permission refusal (the capability is not the caller's, the mode is above the caller's level, the Host or Origin is not allowed); **400** invalid input or an unknown mode; **404** an unknown capability or path; **405** an act asked with GET; **413** a body over `maxBodyBytes`; **415** a body that is not `application/json`; **429** more than `rateLimitPerMinute` requests from one address. **A business refusal is 200 with `{ok: false, gate, reason, decisionId}`** — the catalog's answer, as the CLI prints it — and an allowed act is 200 with `{ok: true, output, decisionId, jobId, operations}`.

## API keys

`foga node key new --config <cfg> --id <id> [--level read|build|act] [--visibility public|caller|operator] [--note <text>]` mints a key for the HTTP entrance (defaults `act`, `caller`). The key is `foga.<id>.<24 random bytes, base64url>`, printed once on stdout and never again; the config keeps `{id, sha256, level, visibility, note}` under `access.keys` — the SHA-256 of the whole key, compared in constant time — so the file can be read, backed up and shown without giving the key away. A request's `Authorization: Bearer <key>` becomes the caller `{id, entrance: "http", level, visibility}`; its jobs, operations and decision records are its own (`caller` visibility), and the operator sees them all. To revoke a key, remove its entry from the config and restart the server; to rotate, mint a new id. Nothing of a key ever reaches a log or an error message, and `foga node serve` reports only how many keys are configured.

Keys are for the operator's own integrations and named partners; the public endpoint reads and builds without one. OAuth is not in Phase 3 (design memo, section 4).

## The edge

- `runtime.http.listen` defaults to `127.0.0.1:8787`: the server binds the loopback and a reverse proxy (Caddy on the OG host, 3d) terminates TLS in front of it. On a loopback listener the `Host` header must be a local one unless `allowedHosts` names the public host names the proxy forwards; an `Origin` header, when a browser sends one, must be local or in `allowedOrigins` (no CORS headers are ever sent — this is the Origin check the protocol asks for, not a cross-origin grant); `X-Forwarded-For` is trusted only when the socket is the loopback.
- Bodies are capped (`maxBodyBytes`, default 256 KiB) on `/mcp` and on the API; a capability's input is parsed by its schema, nothing else is read from a body.
- A token bucket per client address (`rateLimitPerMinute`, default 60); 60-second request and 15-second header timeouts; `cache-control: no-store` on every answer; no cookies.
- The MCP handler receives the request headers without `Authorization`; the caller rides in the SDK's `authInfo`.

## Running

```
FOGA_OPERATOR_KEY_FILE=~/.foga/keys/operator.key foga node serve --config cell.config.json
foga node serve --config cell.config.json                 # no key: reads, dry runs and builds; the watchers do not run
foga node serve --config cell.config.json --no-watch      # the server without the watchers
```

With the operator key and a born cell, the watchers (heartbeat, tender discovery, settlement, safety) run beside the server on `runtime.pollSeconds`; their lines go to stderr. `SIGINT`/`SIGTERM` close the server and the store. `foga node run` is the same server with the runner beside the watchers — a model proposing acts the catalog judges (docs/loop-d.md). The systemd unit and the Caddy site of the OG host are part of 3d.

## Client configuration

The three local clients take the same server definition; `docs/examples/` has one file per client:

- Claude Desktop — `docs/examples/claude_desktop_config.json` (the `mcpServers` block of `claude_desktop_config.json`)
- Claude Code — `docs/examples/claude-code-mcp.json` (a project's `.mcp.json`), or on the command line:
  `claude mcp add foga -e FOGA_OPERATOR_KEY_FILE=/home/me/.foga/keys/operator.key -- npx -y @finchip/foga mcp --config /home/me/cells/D.json`
- Cursor — `docs/examples/cursor-mcp.json` (`.cursor/mcp.json`)

Each runs `npx -y @finchip/foga mcp --config <cell.config.json>` with, optionally, `FOGA_OPERATOR_KEY_FILE` (the operator acts) and `FOGA_RPC_URL` (when the config names no RPC) in `env`. Before the package is published, or from a checkout, the command is `node` with `/path/to/foga/bin/foga.js mcp --config …` after `npm run build`. Without a key file the client gets reads, dry runs and builds: enough to inspect tenders, pre-check them and prepare calldata; nothing it says can make the cell act. A remote endpoint is added to Claude Code with `claude mcp add --transport http foga https://foga.finchip.ai/mcp --header "Authorization: Bearer <key>"` (the public OG endpoint goes live in 3d).

## The package

The npm package is `@finchip/foga` — npm refuses the unscoped name `foga` as too similar to `ora` and `koa`, so it lives under the `finchip` scope; the binary is `foga` and `foga mcp` is the stdio server. `package.json` carries `mcpName: "io.github.garyyang-finchip/foga"`, the name the MCP registry verifies npm ownership by, and `server.json` at the repository root is the registry manifest: the npm package as a stdio server (`npx -y @finchip/foga node mcp --config …`, `FOGA_OPERATOR_KEY_FILE` and `FOGA_RPC_URL` as its environment) and `https://foga.finchip.ai/mcp` as the remote. `engines.node` is `>=22.13`, where `node:sqlite` runs without a flag; CI runs Node 22. Publication to npm and to the registry is part of 3d (the memo's steps: `npm publish` by the package's owner, then `mcp-publisher login github` and `mcp-publisher publish`); the manifest's remote must be reachable when it is published.

What ships: `bin/`, `dist/`, `artifacts/bundle.json` (the ABIs), `worlds/`, `docs/` (the rule texts `spec_read` serves), `scenarios/` (the skill packages and the fixture), the prover bridge and the circuit's verification key, `server.json`. `scripts/pack-smoke.mjs <rpc> <world.json>` is the pre-publication check and a CI step: `npm pack`, a clean `npm install` of the tarball in an empty directory, then the packaged CLI alone — `--help`, the public catalog, a schema, a cell born with `foga cell new` and `foga cell init` on the given world, and `foga node mcp` without a key driven by a raw 2025-era JSON-RPC client over stdio (stdout protocol-only, the keyless tool set, `cell_status`, `resources/list`, `spec_read` of the compatibility matrix from inside the package, no key-shaped value on stderr).

## Acceptance

`test/mcp.test.ts` (anvil; the 3b gate of the design memo, section 11): a cell born through the CLI (`test/helpers/anvil-cell.ts`), two tenders minted by a demander (a to take, c for a skill the cell lacks), an API key minted by `foga node key new` and checked in the config as its hash alone. Over Streamable HTTP, in process: the health and front pages; the edge (401 for a bad, a foreign-id and a non-Bearer credential, 403 for a foreign Origin and Host, 413, 415, 400, 404, 405); the JSON API as the public (reads and dry runs, 403 for an act and for a caller-visible capability, a business refusal as 200 `ok: false`); a client pinned to 2026-07-28 as the public (the 11 tools and their annotations, `cell_status`, `tender_precheck_simulate` on c → `eligible: false` at `skill` and on a → eligible, no act offered, resources, the prompt); the key holder walking case a — `tender_precheck`, `skill_run` reproducing the demander's answer, `tender_submit`, the same job answered once, another request under the same job refused at `conflict`, `tender_settle` paying the reward to the account, `credit_withdraw` when credited — then reading its own job, operation and decision records (and none of the public's), and a `tender_mint_build` for a third party's account; a legacy client and an auto-negotiating client listing the same tools; the rate limiter on a second server. Over stdio: `foga node mcp` without a key (31 tools, `evidence_export` with every caller's records, no act) and with the operator key (every act, no admin), and a mixed environment refused before anything is read.
