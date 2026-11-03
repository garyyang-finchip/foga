# Client configuration examples

One server definition, three clients (docs/mcp.md, "Client configuration"). Each runs `npx -y @finchip.ai/foga mcp --config <cell.config.json>`, the stdio MCP server of one cell.

| File | Client | Where it goes |
|---|---|---|
| `claude_desktop_config.json` | Claude Desktop | the `mcpServers` block of the app's `claude_desktop_config.json` |
| `claude-code-mcp.json` | Claude Code | a project's `.mcp.json` (or `claude mcp add foga -e FOGA_OPERATOR_KEY_FILE=… -- npx -y @finchip.ai/foga mcp --config …`) |
| `cursor-mcp.json` | Cursor | `.cursor/mcp.json` (shown without a key: reads, dry runs and builds) |

`FOGA_OPERATOR_KEY_FILE` names a 0600 file holding the cell's operator key — a single-key wallet's `signer.key` (`foga wallet new`, docs/wallet.md: `~/.foga/wallet/signer.key`; a `--cell` wallet's `operator.key`), `foga keys export --role operator.A`, or any key the account names as operator; with it the server acts for the cell, without it the client gets reads, dry runs and builds. `FOGA_RPC_URL` is needed only when the cell configuration names no `rpc`. From a checkout, replace `npx -y @finchip.ai/foga` with `node /path/to/foga/bin/foga.js` after `npm run build`.

`foga quickstart` (docs/quickstart.md) makes the wallet on its first run, births a cell with it on a local chain and writes these three files, plus `http-mcp.json` for the served node (`{"url": "http://127.0.0.1:8787/mcp", "headers": {"Authorization": "Bearer <key>"}}`), with the real paths and key under `~/.foga/quickstart/mcp/`. A client of another cell's served node — one that issued no key — puts the header `foga wallet sign --url <that node's URL>` prints in place of the Bearer key: a session envelope signed by the wallet, good for ten minutes, at the level the cell's policy grants the address.

Windows: in PowerShell the package name needs quotes on the command line — `npx -y '@finchip.ai/foga' mcp --config D:\cells\D.json` — because a bare `@` starts a splatting expression; inside these JSON files nothing is quoted differently, and paths are written with escaped backslashes (`"D:\\cells\\D.json"`). `anvil` for a local chain comes from Foundry's `win32_amd64` release zip (https://github.com/foundry-rs/foundry/releases): unzip, put the folder holding `anvil.exe` on `PATH` or set `FOGA_FOUNDRY_DIR` to it.
