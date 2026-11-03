# The wallet, signed calls, and becoming a cell (foga wallet, FOGA-EIP712, become-a-cell)

The principle (design memo, section 10): **the wallet is the first step, made by default, never a reason to stop; identity is one's own; only the genome replicates.** Every agent that touches FOGA — one that will be a cell, one that only calls other cells — starts by making its own keys on its own machine. Nothing in the install path requires it: a caller without a wallet keeps everything it has today (anonymous reads and builds, a Bearer key for acts), and a wallet is never made for someone else or sent anywhere. What a wallet adds is a credential that is the agent's own: a signature any FOGA cell can check, instead of a secret one cell issued.

## foga wallet new

```
foga wallet new                      # ~/.foga/wallet: one signer.key (0600) and wallet.json — your identity
foga wallet new --name agent-x       # ~/.foga/wallets/agent-x
foga wallet new --cell               # the separated owner/operator/guardian set, for a guarded cell account
foga wallet show [--rpc <url>]       # the address (and balance with an RPC)
```

**The base is one key.** A wallet is, by default, a single `signer` key — the agent's identity — and that one key answers for every role a cell needs: a cell born with a single-key wallet has the same address as its owner, operator and guardian. One key is all it takes to be covenant-complete, to call cells as yourself, and to run a cell of your own. The three-role split — a cold owner that holds the assets, a hot operator that signs day to day, a separate guardian that can intervene — is the `FogaCellAccount` guarded profile's hardening, not a requirement of the ten covenants; it is opt-in with `--cell` (or `--roles owner,operator,guardian`), for when a cell runs real value and wants the keys separated.

Pure entropy, no network, no chain: it does not fail unless the disk refuses the write, and then whatever needed the key goes on with a key made in memory and says it is not kept (`foga quickstart` does exactly that). A wallet is never overwritten: `foga wallet new` on a directory that holds one prints it and stops; a second identity is `--name <another>`. `FOGA_HOME` moves `~/.foga` elsewhere.

The wallet's files are what the node's key rules read (docs/node.md): `FOGA_OPERATOR_KEY_FILE=~/.foga/wallet/signer.key` is a node's environment, and `--wallet <dir>` is the CLI's shorthand for the key each command needs — `foga cell new --wallet` fills the account's roles (all from the one key, unless the wallet is a `--cell` one), `foga cell init --wallet` births with the owner's, `foga cell <act> --wallet` acts with the operator's, `foga cell owner|guardian <admin> --wallet` with theirs, `foga node serve|run|mcp|tick|watch|preflight --wallet` take the operator's (and refuse to run beside `FOGA_OPERATOR_KEY[_FILE]`: a node's key comes from one place). For a single-key wallet every one of these is the same key; for a `--cell` wallet each is its own.

`foga quickstart` makes the default wallet on its first run and reuses it after: the chain is new every time, the identity is the one the agent made on day one, and `foga cell new --wallet ~/.foga/wallet` on a public chain is the same key, funded.

## Signed calls: FOGA-EIP712

A third way in beside no credential and `Authorization: Bearer <key>`:

```
Authorization: FOGA-EIP712 <base64url(JSON envelope)>
```

The envelope is EIP-712 typed data signed by the caller's wallet, with the domain `{name: "FOGA", version: "1", chainId, verifyingContract: <the cell's account>}` — so a signature made for one cell means nothing to another — in one of two shapes:

| Shape | Message | Validity | Use |
|---|---|---|---|
| `Request` | `method`, `path` (with its query), `bodyHash` (keccak256 of the body; of nothing for a GET), `issuedAt`, `expiresAt`, `nonce` | 120 s at most; good once (the node keeps the nonce until it expires) | an act: whoever captures the header can replay nothing with it |
| `Session` | `issuedAt`, `expiresAt`, `nonce` | 600 s at most; presented as often as the session lasts | a client with static headers (an MCP client given `Authorization` once); the policy decides how far it reaches |

The envelope's JSON: `{"v": 1, "signer": "0x…", "agentId": "11255" (optional), "issuedAt": …, "expiresAt": …, "nonce": "0x…", "request": {"method", "path", "bodyHash"} (absent for a session), "signature": "0x…"}`. `foga wallet sign (--config <cell.config.json> | --url <its node's URL> | --cell <account> --chain-id <n>) [--dir <wallet>] [--role signer|operator|owner|guardian] [--ttl <s>] [--agent-id <id>] [--method POST --path /api/x --body '<json>']` prints a header for a cell — the operator names its configuration, anyone else the node's URL (`/healthz` says which account on which chain) or the two values by hand; in code (`src/http/signed.ts`), `signAuthorization(wallet, {chainId, cell, request?, ttlSeconds?, agentId?})` is the same thing with ethers, and any EIP-712 library reproduces it from the types above.

**What a signer is granted** is the cell's configuration, `access.signers`:

```json
"access": {
  "keys": [ … ],
  "signers": {
    "default": "build",
    "allow": [
      { "address": "0x…", "level": "act", "visibility": "caller", "note": "a partner's agent" },
      { "agentId": "42", "level": "act" }
    ],
    "standing": { "minLevel": 2, "level": "act" },
    "actsNeedRequestBinding": true
  }
}
```

In order: the cell's own operator or owner signing remotely is granted act with the operator's view; an `allow` entry by address; an `allow` entry by ERC-8004 agent id, when the signer is that agent's owner or agent wallet on this world's registry (the envelope names the id, the node checks the registry); a signer whose KYA standing under the cell's scheme reaches `standing.minLevel`; otherwise `default` — `build` (what the public gets, but as itself: its decisions are recorded under its address), `read`, or `none` (signatures refused). With `actsNeedRequestBinding` (the default), a session envelope reaches `build` whatever the grant: an act wants an envelope bound to its request. A valid signature at `build` can pre-check, simulate and build calldata for its own account; nothing it says changes a gate.

The HTTP entrance tells a caller what it is (`GET /api/capabilities` → `caller.via`: `anonymous`, `key` or `signature`), and `/mcp` and `/a2a` take the same header. Over stdio there is nothing to sign: the local client holds the operator key or is the machine's user.

## become-a-cell

Every cell's MCP server carries the genome's instructions: the prompt `become-a-cell` and the resource `foga://docs/quickstart` (this repository's docs/quickstart.md). An agent that meets a cell — connects to its MCP entrance, as the public or with any credential — can read how to make itself one: the wallet first, then `npx -y @finchip.ai/foga quickstart` for a living cell on a local chain, then `foga cell new --wallet … && foga cell init --wallet …` on a public chain — and, with the wallet alone, how to call the cell it met as itself (`foga wallet sign --url <that node>`). What replicates is the program (the package, the catalog, the acceptance); the identity the new cell makes is its own and nothing of the first cell's is copied. The relation between cells is between peers on the chain — tenders minted and taken — not between a model and copies of it.
