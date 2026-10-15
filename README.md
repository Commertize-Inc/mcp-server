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

### Streamable HTTP transport (remote MCP)

The same server over the MCP Streamable HTTP transport, for clients that connect to a
URL instead of spawning a process. It runs where you run it: start it yourself and
point your client at the address you bind.

```bash
node dist/httpMain.js            # 127.0.0.1:3920 by default
```

```bash
# a client, once an instance is reachable at <url>:
claude mcp add --transport http commertize <url>/mcp --header "Authorization: Bearer <agent key>"
```

What is different over HTTP, by design:

- **Every request needs a key.** `Authorization: Bearer cfa_…`, the agent-platform key
  format. The key is verified against the API named by `COMMERTIZE_API_BASE_URL` at
  `COMMERTIZE_MCP_KEY_INTROSPECT_PATH` (200 with the matching `key_id` = yes; 401/403 =
  no; anything else, or no answer, = 503 and the request is refused). There is no
  anonymous mode and no "skip verification" switch. The route itself requires a service
  secret (`COMMERTIZE_MCP_INTROSPECT_SECRET`, sent as `x-commertize-introspect-secret`);
  without one this server refuses every call with 503 and never calls upstream, and a
  route that refuses OUR secret is reported as "cannot verify", never as "bad key".
- **Caching, both ways, bounded.** A verified key is trusted for at most 15 s
  (`COMMERTIZE_MCP_KEY_VERIFY_CACHE_MS`, hard ceiling 15 000 — an environment can lower
  it, not raise it) and never past the `expires_at` the route reported, so a revoked key
  works for at most 15 s. A refused key is remembered for
  `COMMERTIZE_MCP_KEY_NEGATIVE_CACHE_MS` (30 s) so a flood of one bad key costs one
  upstream call per window; a revocation is honoured at the first re-check, at most
  15 s away, and then remembered the same way.
- **Per-IP verification brake.** Requests whose key is not answered from cache count
  against the client's address (`x-vercel-forwarded-for`, then `x-real-ip`, then the
  socket; never the caller-settable `x-forwarded-for`): `COMMERTIZE_MCP_HTTP_VERIFY_PER_IP_PER_MIN`
  (20) per minute, then 429 before any upstream call. The route's own Postgres-counted
  ceilings (per IP, per key, global) are the ceiling that holds across serverless
  instances; this brake is the first, free one.
- **The surface is an allowlist** (`src/httpAllowlist.ts`). A `tools/call` naming any
  other tool is HTTP 403 with a logged `tool_refused` event, before the MCP server sees it.
- **Per-key ceilings**: `COMMERTIZE_MCP_HTTP_RPM` requests per minute (60) and
  `COMMERTIZE_MCP_HTTP_INQUIRIES_PER_HOUR` inquiries per hour (2), each 429 with
  `Retry-After`. In-memory and per process: on a serverless platform every warm
  instance counts on its own. The API's own per-IP limits remain the floor.
- **CORS is off.** No `Access-Control-*` header is ever sent; `OPTIONS` is 405. A key
  pasted into a web page cannot be used from a browser.
- **Stateless.** Each POST builds a fresh server and transport and tears them down. No
  sessions, no SSE streams: `GET /mcp` is 405. Clients must send
  `Accept: application/json, text/event-stream` (the SDK and Claude Code do).
- **`GET /health`** answers 200 with the version, transport and `verifier_configured`, needs no key, and names
  no upstream.
- **Structured log**, one JSON object per request on stderr: method, path, the key's
  public id, JSON-RPC methods, tool name, status, outcome, duration. Never the key, a
  header, or a body.

`api/mcp.js`, `api/health.js` and `vercel.json` are a serverless packaging of the same
handler, for self-hosting.

### Configuration (all optional; sane defaults point at production)

| Variable | Default | Purpose |
|---|---|---|
| `COMMERTIZE_API_BASE_URL` | `https://api.commertize.com` | Upstream API. |
| `COMMERTIZE_CACHE_TTL_MS` | `60000` | Fresh-response window. |
| `COMMERTIZE_MCP_HTTP_HOST` / `_PORT` | `127.0.0.1` / `3920` | Bind address of `dist/httpMain.js`. |
| `COMMERTIZE_MCP_KEY_INTROSPECT_PATH` | `/agent-platform/keys/introspect` | Path on `COMMERTIZE_API_BASE_URL` that verifies a bearer key (HTTP transport only). |
| `COMMERTIZE_MCP_INTROSPECT_SECRET` | unset (every HTTP request is 503; no upstream call) | Service secret the introspection route requires. Never logged or served. |
| `COMMERTIZE_MCP_KEY_VERIFY_CACHE_MS` | `15000` (hard ceiling `15000`) | How long a verified key is trusted before re-checking; also bounded by the reported `expires_at`. |
| `COMMERTIZE_MCP_KEY_NEGATIVE_CACHE_MS` | `30000` (ceiling `300000`) | How long a refused key is remembered without re-asking. |
| `COMMERTIZE_MCP_HTTP_VERIFY_PER_IP_PER_MIN` | `20` | Per-client-IP ceiling on verification attempts (cache misses) per minute. |
| `COMMERTIZE_MCP_HTTP_RPM` / `COMMERTIZE_MCP_HTTP_INQUIRIES_PER_HOUR` | `60` / `2` | Per-key ceilings over HTTP. |
| `COMMERTIZE_MCP_HTTP_MAX_BODY_BYTES` | `65536` | Largest JSON-RPC body accepted over HTTP. |
| `COMMERTIZE_MCP_CONTENT_DIR` | unset (`content/` next to `dist/`) | Absolute path of `content/` when a packager moves the built files. |

## Tests

```bash
npm test
```

Runs the offline, screener, sandbox, x402, HTTP and banned-language suites. The
live-network suite is opt-in: `COMMERTIZE_MCP_LIVE_TESTS=1 npm test`, or
`npm run test:live` on its own.

## License

Apache-2.0. See [LICENSE](LICENSE).

## Links

- Platform: https://commertize.com
- Privacy: https://commertize.com/privacy
- Public API: https://api.commertize.com
- Agent skill: https://github.com/Commertize-Inc/agent-skill

---

Nothing in this repository, or returned by any tool in it, is an offer, a solicitation, or a recommendation to buy or sell any security, or investment, legal, or tax advice.
