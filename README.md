# Commertize Agents — MCP Server

The [MCP](https://modelcontextprotocol.io) server for **Commertize Agents**. It exposes
Commertize's **public** marketplace data — offerings, news, sponsor listings, platform
reference text — as typed tools any MCP-compatible agent can call directly, instead of
scraping commertize.com.

**Every tool registered by default is a read, and none needs a credential.** Further
tools exist in this codebase and are NOT registered by default — `get_disclosure_package`,
the two sponsor-services writes (`request_memo`, `file_sponsor_inquiry`), and the
`sandbox_*` / `x402_*` groups — each behind its own explicit opt-in flag. See
[What is actually live](#what-is-actually-live) and [Configuration](#configuration-all-optional-sane-defaults-point-at-production).

Commertize is a digital capital markets platform for real-world assets: it structures
an asset into a legal vehicle, issues the economic interest as an on-chain token,
verifies investors and sponsors under the applicable securities exemption, settles
subscriptions against escrow, and administers the position afterwards. This server is
the read surface of that platform, nothing more.

**Free. No API key. No account.** Every default tool reads a route that is public and
unauthenticated on `api.commertize.com`. Nothing in this server is an offer, a
solicitation, or a recommendation, nothing here can transact, and the disclaimer travels
with every response.

## What is actually live

Verified against `api.commertize.com` on 2026-09-10 by direct probe. A route that exists
answers 200/400/401 or a JSON 404; the plain-text `404 Not Found` below is the
unmounted-route default.

| Tool | Backing route | Production |
|---|---|---|
| `list_offerings`, `get_offering`, `search_offerings`, `compare_offerings`, `list_sponsors`, `get_sponsor` | `GET /api/listings` | **200** |
| `get_news`, `get_article` | `GET /api/news`, `GET /api/news/{slug}` | **200** (unknown slug: JSON 404) |
| `platform_info` | none — reads a local file | n/a |
| `request_memo` | `POST /api/agents/memo-request` | **404, not mounted** — gated OFF |
| `get_disclosure_package` | `GET /api/offerings/v1/{id}/disclosure` | **404, not mounted** — gated OFF |
| `sandbox_*` (4), `x402_*` (5) | `/api/agents/sandbox/*`, `/api/agents/x402/*` | **404, not mounted** — gated OFF |

The gated tools' code, schemas and tests are complete and unchanged; only their
registration is switched off. The
rule is the one this server already applied to the sandbox and paid-data groups: a tool
that can only 404 teaches a machine reader that the platform is broken rather than that
the capability is not offered.

## Tools

**Nine tools are registered by default, all reads.** Every tool is listed below; the
ones that are off by default are marked.

**Marketplace & content (7):**

| Tool | Input | Returns |
|---|---|---|
| `list_offerings` | `status?`, `asset_class?`, `state?`, `limit?` | The public offering set: asset class, city/state, status, exemption type, sponsor, tokenomics, derived offering size, SPV leverage disclosure. |
| `get_offering` | `offering_id` | One offering's full public detail. |
| `get_disclosure_package` (off by default: `COMMERTIZE_MCP_ENABLE_DISCLOSURE=1`) | `offering_id` | One publishable offering's SIGNED machine-readable disclosure package — terms, waterfall, covenants, risk factors, attestations, minimum investment, transfer-restriction profile and reason codes — every field with a provenance and an as-of, plus the Ed25519 signature, key id, verification endpoints and a PDF rendered from the same data. Assets under evaluation are never served. Off by default, like the offerings tools; the API endpoint is itself flag-gated (`AGENTS_DISCLOSURE_ENABLED`). |
| `get_news` | `limit?`, `category?`, `query?` | Published news and market commentary — headlines, summaries, categories, links. |
| `get_article` | `slug` | One article's full body as plain text. |
| `platform_info` | — | Curated "what is Commertize / what can an agent do here" reference text. Call this one first. |

**Screening & comparison (4):**

| Tool | Input | Returns |
|---|---|---|
| `search_offerings` | free-text query + asset class / geography / status / exemption filters + numeric range filters (cap rate, cash-on-cash, IRR, equity multiple, hold period, lockup, offering size, minimum ticket, SPV leverage) | The filtered public set, sortable on any numeric field. Undisclosed values never silently match a range filter — they land in `excluded_not_disclosed`, and `field_coverage` reports how many candidates disclose each figure at all. |
| `compare_offerings` | 2–5 `offering_ids` | Field-by-field comparison across offerings, with per-field disclosure/agreement counts — two undisclosed values are reported as two absences, never as agreement. |
| `list_sponsors` | — | Every sponsor with a public offering: count, status/asset-class breakdown, states, summed target raise where disclosed. This is an inventory of platform listings, not a track record. |
| `get_sponsor` | `sponsor` (id or name substring) | One sponsor's public listing record. Not a track record — prior deals, realized returns, AUM and verification status are not public data and are named as unavailable, not guessed at. |


**Sponsor services — writes, OFF in the default build:**

Neither tool below is registered unless its flag is set explicitly. The default public
build is the read-only tool set above; `platform_info` reports `read_only: true`.

| Tool | Opt-in flag | Input | Returns |
|---|---|---|---|
| `request_memo` | `COMMERTIZE_MCP_ENABLE_MEMO=1` (also needs `COMMERTIZE_AGENT_KEY`) | `asset_class`, `size_band`, `doc_link` | Files a request for a written feasibility read on an asset your principal controls. The memo goes to the address your credential was registered to and **cannot be directed anywhere else** — there is no recipient parameter. Returns the request id and the receipt time. Without a key the tool refuses and says so rather than silently filing nothing. |
| `file_sponsor_inquiry` | `COMMERTIZE_MCP_ENABLE_INQUIRY=1` | principal contact details + agent attribution | Files a sponsor inquiry about the principal's own asset. Returns the inquiry id and acceptance time; nothing else is promised. |

### What makes this safe to hand to an arbitrary agent

- **Public data only.** Every route backing these tools has no auth middleware — verified route-by-route against the backend source, not assumed.
- **No write tool by default.** As this server ships, every registered tool is a read and
  `platform_info` reports `read_only: true` — a value derived from the registered write
  list, not asserted. If a write gate is opened, the write tools file a request about the caller's OWN asset; `request_memo` takes no recipient address, so it cannot be used to mail a third party. Nothing in this server can subscribe, transfer, claim a distribution, or commit anyone to anything, and there are no credentials in the codebase — any agent key is read from the environment and only ever sent to Commertize's own API.
- **Honest nulls.** A missing value is `null` and named in `not_disclosed`. Never `0`, never a guess, never filled from a comparable.
- **Provenance on every response.** `as_of` (fetch time, not call time), `source_url`, cache metadata, and a standing disclaimer ride along with every payload.
- **Never fabricates on failure.** An upstream outage returns a typed error, never an empty list dressed up as "no offerings."
- **Offering tools are off by default.** `list_offerings` and `get_offering` return data only when `COMMERTIZE_MCP_ENABLE_OFFERINGS=1` is explicitly set; a missing or malformed value keeps them off. When enabled, any offering structured under Rule 506(b), which does not permit general solicitation, carries an explicit non-solicitation note.

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
- **The surface is an allowlist** (`src/httpAllowlist.ts`): the read tools plus
  `file_sponsor_inquiry`. `request_memo`, the simulation venue and the paid-data rail are
  not registered over HTTP whatever their gates say, and a `tools/call` naming any of
  them — or any unknown name — is HTTP 403 with a logged `tool_refused` event, before the
  MCP server sees it.
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
| `COMMERTIZE_MCP_ENABLE_OFFERINGS` | unset (tools return no offering data) | Set to `1` to enable `list_offerings` / `get_offering`. |
| `COMMERTIZE_MCP_ENABLE_MEMO` | unset (`request_memo` is not registered) | Set to `1` only against an API that mounts `POST /api/agents/memo-request`. The production API does not serve this route. |
| `COMMERTIZE_MCP_ENABLE_DISCLOSURE` | unset (`get_disclosure_package` is not registered) | Set to `1` only against an API that mounts `GET /api/offerings/v1/{id}/disclosure`. The production API does not serve this route. |
| `COMMERTIZE_AGENT_KEY` | unset (`request_memo` refuses) | Agent credential from `POST /api/agents/register`. The only tool that reads it is `request_memo`; it is sent to Commertize's own API and nowhere else. |
| `COMMERTIZE_MCP_ENABLE_INQUIRY` | unset (`file_sponsor_inquiry` is not registered) | Set to `1` only against an API whose `POST /contact` records the `agent` attribution object. The route itself is mounted on `api.commertize.com`; the attribution contract is what the gate waits for. |
| `COMMERTIZE_MCP_HTTP_HOST` / `_PORT` | `127.0.0.1` / `3920` | Bind address of `dist/httpMain.js`. |
| `COMMERTIZE_MCP_KEY_INTROSPECT_PATH` | `/agent-platform/keys/introspect` | Path on `COMMERTIZE_API_BASE_URL` that verifies a bearer key (HTTP transport only). |
| `COMMERTIZE_MCP_INTROSPECT_SECRET` | unset (every HTTP request is 503; no upstream call) | Service secret the introspection route requires. Never logged or served. |
| `COMMERTIZE_MCP_KEY_VERIFY_CACHE_MS` | `15000` (hard ceiling `15000`) | How long a verified key is trusted before re-checking; also bounded by the reported `expires_at`. |
| `COMMERTIZE_MCP_KEY_NEGATIVE_CACHE_MS` | `30000` (ceiling `300000`) | How long a refused key is remembered without re-asking. |
| `COMMERTIZE_MCP_HTTP_VERIFY_PER_IP_PER_MIN` | `20` | Per-client-IP ceiling on verification attempts (cache misses) per minute. |
| `COMMERTIZE_MCP_HTTP_RPM` / `COMMERTIZE_MCP_HTTP_INQUIRIES_PER_HOUR` | `60` / `2` | Per-key ceilings over HTTP. |
| `COMMERTIZE_MCP_HTTP_MAX_BODY_BYTES` | `65536` | Largest JSON-RPC body accepted over HTTP. |
| `COMMERTIZE_MCP_CONTENT_DIR` | unset (`content/` next to `dist/`) | Absolute path of `content/` when a packager moves the built files. |
| `COMMERTIZE_MCP_ENABLE_SANDBOX` / `COMMERTIZE_MCP_ENABLE_X402` | unset (not registered) | Opt-in for the `sandbox_*` and `x402_*` tool groups. |

## Tests

```bash
npm test
```

Runs the offline, screener, sandbox, x402, HTTP and banned-language suites. The
live-network suite is opt-in: `COMMERTIZE_MCP_LIVE_TESTS=1 npm test`, or
`npm run test:live` on its own.

## License

Apache-2.0. This is the open half of Commertize's open-core split: the public edge
(this server, the agent skill, `llms.txt`) is open source; the venue itself — onboarding,
KYC, custody, settlement, everything that actually transacts — is not.

## Links

- Platform: https://commertize.com
- Public API: https://api.commertize.com
- Agent skill: https://github.com/Commertize-Inc/agent-skill

---

Nothing in this repository, or returned by any tool in it, is an offer, a solicitation, or a recommendation to buy or sell any security, or investment, legal, or tax advice.
