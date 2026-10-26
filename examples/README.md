# Examples

## Manual Claude Code configuration

`maxify init` writes this for you. To do it by hand, put [`mcp.json`](mcp.json) in your project as `.mcp.json` and replace the path with your local build:

```json
{
  "mcpServers": {
    "maxify": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/tools/maxify/dist/cli.js", "serve"]
    }
  }
}
```

Equivalent command (project scope, writes `.mcp.json`):

```bash
claude mcp add --scope project maxify -- node /abs/path/to/maxify/dist/cli.js serve
```

Claude Code asks you to approve project-scoped servers the first time. `claude mcp list` should show `maxify` as connected.

## Optional CLAUDE.md snippet

The server already sends equivalent instructions, so this is only needed for clients that ignore MCP server instructions. Every line here is paid on every turn; keep it short. See [`CLAUDE.md.snippet`](CLAUDE.md.snippet).

## Configuration

[`maxify.config.json`](maxify.config.json) shows every option with its default.

## Typical session

```text
> Fix: users are logged out exactly at token expiry instead of after it.

maxify_context {task: "users are logged out exactly at token expiry instead of after it"}
  -> isExpired [src] + verifyToken [sig] + TokenPayload [src] + test/token.test.ts [map]
Read src/server/auth/token.ts offset=12 limit=20      (Edit requires a Read)
Edit ...
npm test 2>&1 | maxify compress --kind test           (failures verbatim, passes counted)
```
