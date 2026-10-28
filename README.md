# Commertize Agents

MCP server for Commertize, the digital capital markets platform for real-world assets.

This listing is reference information. It is not an offer to sell or a solicitation of an offer to buy any security.

## Tools

| Tool | Reads |
|---|---|
| `get_news` | `GET https://api.commertize.com/api/news` |
| `get_article` | `GET https://api.commertize.com/api/news/{slug}` |
| `platform_info` | `content/platform-info.md` (bundled with this server) |

## Install

### Claude Code

```bash
claude mcp add commertize -- node /absolute/path/to/mcp-server/dist/index.js
```

(Build from source first — see [From source](#from-source).)

### Any client using an `mcpServers` config block

```json
{
  "mcpServers": {
    "commertize": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/dist/index.js"]
    }
  }
}
```

### From source

```bash
git clone https://github.com/Commertize-Inc/mcp-server.git
cd mcp-server
npm ci
npm run build
node dist/index.js
```

The server speaks MCP over stdio; `node dist/index.js` is the command every client
config above points at (use the absolute path to `dist/index.js`).

Or point the official inspector at it directly:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

### Configuration (all optional; sane defaults point at production)

| Variable | Default | Purpose |
|---|---|---|
| `COMMERTIZE_API_BASE_URL` | `https://api.commertize.com` | Upstream API. |
| `COMMERTIZE_CACHE_TTL_MS` | `60000` | Fresh-response window. |
| `COMMERTIZE_MCP_CONTENT_DIR` | unset (`content/` next to `dist/`) | Absolute path of `content/` when a packager moves the built files. |

### Turning /mcp/public on and off

The gate is read once, when the server starts. A running deployment keeps the value it started with, so changing an environment variable does nothing until the next deployment.

- **On:** set `COMMERTIZE_MCP_ENABLE_PUBLIC=1` (exactly `1`), leave `COMMERTIZE_MCP_DISABLE_PUBLIC` unset, and redeploy. Turn it on only for a build whose `GET /health` reports `toolCalls`, because older builds give no public signal. Afterwards, check `GET /health`.
- **Off, fast:** roll back to the previous deployment, which was closed. Then set `COMMERTIZE_MCP_DISABLE_PUBLIC=1` and redeploy, so the next deployment cannot reopen it. Any non-empty value except `0` closes the endpoint, whatever `ENABLE` says.
- **Rate limit:** `COMMERTIZE_MCP_PUBLIC_RPM_PER_IP` (default `30`) caps requests per client IP per minute. The count is kept in memory **per running instance**, so N instances admit up to N times the value.

## Tests

```bash
npm test
```

Runs the offline suites. The live-network suite is opt-in: `COMMERTIZE_MCP_LIVE_TESTS=1 npm test`, or
`npm run test:live` on its own.

## License

Apache-2.0. See [LICENSE](LICENSE).

## Links

- Platform: https://commertize.com
- Privacy: https://commertize.com/privacy

---

Nothing in this repository, or returned by any tool in it, is an offer, a solicitation, or a recommendation to buy or sell any security, or investment, legal, or tax advice.
