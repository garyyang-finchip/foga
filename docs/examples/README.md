# Client configuration examples

One server definition, three clients (docs/mcp.md, "Client configuration"). Each runs `npx -y foga mcp --config <cell.config.json>`, the stdio MCP server of one cell.

| File | Client | Where it goes |
|---|---|---|
| `claude_desktop_config.json` | Claude Desktop | the `mcpServers` block of the app's `claude_desktop_config.json` |
| `claude-code-mcp.json` | Claude Code | a project's `.mcp.json` (or `claude mcp add foga -e FOGA_OPERATOR_KEY_FILE=… -- npx -y foga mcp --config …`) |
| `cursor-mcp.json` | Cursor | `.cursor/mcp.json` (shown without a key: reads, dry runs and builds) |

`FOGA_OPERATOR_KEY_FILE` names a 0600 file holding the cell's operator key (`foga keys export --role operator.A`, or any key the account names as operator); with it the server acts for the cell, without it the client gets reads, dry runs and builds. `FOGA_RPC_URL` is needed only when the cell configuration names no `rpc`. From a checkout before publication, replace `npx -y foga` with `node /path/to/foga/bin/foga.js` after `npm run build`.
