# Commertize MCP server

The same public surface as this skill, exposed as Model Context Protocol tools with
typed schemas. Use it when your runtime speaks MCP; use the raw HTTP calls in
`SKILL.md` when it does not.

Transport is stdio (run locally). Install from source:
https://github.com/Commertize-Inc/mcp-server (`git clone`, `npm ci`, `npm run build`, then point your client at `node dist/index.js`).

## Tools

| Tool | Input | Output |
|---|---|---|
| `list_offerings` | `status?`, `asset_class?`, `state?`, `limit?` | `offerings[]`, `count`, `total_available` |
| `get_offering` | `offering_id` | `offering`, `public_fields_only` |
| `get_news` | `limit?`, `category?`, `query?` | `articles[]`, `count` |
| `get_article` | `slug` | `article` with `content_text` (markup stripped) |
| `platform_info` | — | `markdown`, `capabilities` |

## Response envelope

Every response, success or failure, carries:

| Field | Meaning |
|---|---|
| `as_of` | ISO-8601 time the data was **fetched upstream**, not the time you called |
| `source_url` | The public API URL the response came from |
| `cache` | `{ hit, age_seconds, stale }` |
| `disclaimer` | Standing disclaimer — carry it into anything you report |
| `error` | `null` on success; `{ code, message, retryable }` on failure |

`cache.stale: true` means the API was unreachable and a previously cached body was
served; the data is real but old, and `as_of` says how old.

## Reading the output honestly

- `null` means not disclosed. Every null field is also named in the offering's
  `not_disclosed` array.
- `tokenomics.*` are sponsor disclosures.
- `derived.*` are computed from those disclosures by the server (`target_raise`,
  `min_investment_amount`, and the platform's own derived valuation and cap rate).
- `projections.*` are forward-looking sponsor estimates and carry a note saying so.
- `spv_leverage: null` with `spv_leverage_display: "Not disclosed"` is not zero
  leverage.
- `status.accepting_investment` is `true` only for `ACTIVE`.

## Error codes

| Code | Meaning | Retry |
|---|---|---|
| `UPSTREAM_UNREACHABLE` | API could not be reached | Yes |
| `UPSTREAM_TIMEOUT` | API did not respond in time | Yes |
| `UPSTREAM_ERROR` | API returned a non-2xx status | Only for 5xx / 429 |
| `UPSTREAM_BAD_BODY` | API returned a body that is not valid JSON | Yes |
| `NOT_FOUND` | Unknown offering id or article slug | No |
| `TOOL_DISABLED` | Offering tools disabled on this instance | No |

An error response never returns partial or invented data: lists come back empty and
objects come back `null`, with `isError` set. Never report "no offerings" from an
error response.
