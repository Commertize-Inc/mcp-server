---
name: commertize
description: Read Commertize's public listing records (informational only) for tokenized real-world assets, including each record's public fields (asset class, location, status, exemption code, token terms, SPV leverage disclosure), and read Commertize's published news. Use it for questions about what Commertize lists or how a specific Commertize listing record is described. Do NOT use it for other platforms, for generic real-estate data, or to transact. Nothing here can transact, and as shipped there is no write tool.
---

# Commertize

Commertize builds infrastructure for tokenizing real-world assets and for agentic commerce. This skill reads its public listing records. They are informational records, not offers. No offering is open on Commertize today, and nothing in this skill can be used to buy, sell or commit to anything.

This skill covers the **public, read-only** surface. Everything below can be called with no credentials. There is no authenticated route, no key, and no action that moves value.

## Start here

1. **Platform reference**: read §5 below for how an asset is typically structured.
2. **Listing records**: `GET https://api.commertize.com/api/listings` returns the set of records that are publicly viewable.
3. **News**: `GET https://api.commertize.com/api/news?limit=20` returns published articles. `GET /api/news/{slug}` returns one full body.
4. **MCP alternative**: if your runtime speaks MCP, the same surface is available as typed tools (`list_offerings` and `get_offering`, which read listing records despite their names, plus `get_news`, `get_article` and `platform_info`). Each tool has a schema, cache metadata and a disclaimer on every response. See `references/mcp-server.md`.

## Quick setup

```bash
export COMMERTIZE_API="https://api.commertize.com"
curl -sS "$COMMERTIZE_API/api/listings" | jq '.[] | {id, name, city, state, propertyType, status, offeringType}'
```

No key, no header, no registration. Cache responses for about 60 seconds. The public read routes are rate limited to 120 requests per minute for listings and news.

## 1. Read the listing records

```http
GET /api/listings
```

This returns records whose `status` is `ACTIVE`, `FULLY_FUNDED` or `TOKENIZING`, with these fields:

| Field | Meaning |
|---|---|
| `id` | Record UUID. Use it to refer to one listing. |
| `name`, `city`, `state` | Asset identity. The street address is not public. |
| `propertyType` | Asset class, e.g. `MULTIFAMILY`, `HOSPITALITY`, `OFFICE`, `DATA_CENTERS`. |
| `status` | Record status code (see `references/data-model.md`). A status code is a label on the record. It does not mean anything is open or available to buy. |
| `offeringType` | Code for the securities exemption the sponsor has named for the asset (`RULE_506_B`, `RULE_506_C`, `REG_A`, `REG_CF`, `REG_S`). It is a record field only. |
| `sponsor` | `{ id, businessName }`, the sponsor that supplied the record. |
| `tokenomics` (per-asset token terms; not a Commertize token) | `tokenPrice`, `totalTokenSupply`, `tokensForInvestors`, `tokensForSponsor`, `tokensForTreasury`, `minInvestmentTokens`, `maxInvestmentTokens`, `lockupMonths`. These are sponsor-entered record fields: informational; no offering is open on Commertize today. Fields may be absent. |
| `financials` | Figures the sponsor supplied for the asset. Fields may be absent. |

The one derived value this skill supports:

- SPV leverage = `spvDebtAmount / assetValue`, where `assetValue` is the current appraisal, else the purchase price, else the acquisition cost, in that order.

Report each token field as the sponsor entered it. Some surfaces (the MCP server's `derived` block, and the trailing fields of `/api/listings`) return arithmetic on these fields, such as `target_raise`, `min_investment_amount`, an implied equity valuation and a cap rate. Report them as returned and label each one as arithmetic on sponsor-entered figures. None is an amount being raised, a minimum anyone can invest, an appraisal or a forecast: no offering is open on Commertize today. Do not compute any of them yourself where the surface does not return them.

`status.accepting_investment` (MCP only) is always `false`; no offering is open on Commertize today.

**A missing field means "not disclosed". It never means zero.** Report an undisclosed figure as "Not disclosed". Never describe a record with no disclosed debt as unlevered, and never put `0` in place of an absent number.

## 2. Read one listing record

There is no public detail endpoint. Filter the list response by `id`:

```bash
curl -sS "$COMMERTIZE_API/api/listings" | jq --arg id "$LISTING_ID" '.[] | select(.id == $id)'
```

Anything beyond these public fields (documents, sponsor diligence, personal data, street address) is not public and cannot be reached from this skill. Do not infer it. Say it is not public.

## 3. Platform statistics

Not public. `GET /api/stats/platform` requires a signed-in session and is outside this skill. Do not report platform-wide counts.

## 4. Read news

```http
GET /api/news?limit=20
GET /api/news/{slug}
```

Articles carry `slug`, `title`, `summary`, `category`, `publishedAt`, `readTime`, `imageUrl`, and an HTML `content` body. The body embeds a JSON-LD `<script>` block. Strip script tags before reading the body as prose, or you will read the metadata twice. Public permalink: `https://commertize.com/news/{slug}`.

This is Commertize's own editorial view. Attribute it to Commertize. It is not independent research.

## 5. How an asset is typically structured

- The platform's data model covers commercial real estate, carbon credits, mining land, and oil and gas. Listing data is informational only.
- An asset is usually held in its own special-purpose vehicle (SPV). A token is designed to represent an interest in that SPV, not direct title to the asset. If the SPV carries debt, that interest sits behind the debt, which is why the leverage disclosure matters.
- Any terms for distributions, transfers and eligibility are set by the sponsor in that asset's own documents.
- The contracts are designed so that a token moves only to wallets the asset's transfer rules allow. They are deployed on test networks only. Nothing on-chain described here is live on a main network.

## Rules for agents using this skill

1. **Nothing here transacts.** The default server registers no write tool. The feasibility-memo request (`request_memo`) is not deployed and is switched off, so `tools/list` returns reads only. Nothing buys, transfers, claims or commits anyone to anything. If a user asks to put money into an asset, say that no offering is open on Commertize today and that this skill cannot take part in any transaction, then stop.
2. **Never present this data as an offer.** These records are informational. No offering is open on Commertize today. Do not describe any record as available, open or investable.
3. **Carry the disclaimer** into anything you report: informational only; not an offer, solicitation or recommendation; not investment, legal or tax advice.
4. **Keep disclosed, derived and projected apart.** What the sponsor disclosed, what you computed (leverage only) and what the sponsor projects are three different things. Projections are estimates that may not be achieved.
5. **Timestamp everything.** State when you fetched the data. Record status changes.
6. **Say "not public" rather than estimating.** Any estimate of a non-public value would be a fabrication.

## Typical errors

| HTTP | Meaning |
|---|---|
| 401 | You called an authenticated route. No route in this skill needs auth. Re-read the path. |
| 404 | Unknown article slug, or a record that is not publicly viewable. |
| 429 | Rate limited. Back off and reuse cached responses. The read limits are per minute. |
| 500 | Upstream error. Retry with backoff. Do not report an empty list as "no listings". |

## References

- `references/api-reference.md`: endpoint-by-endpoint reference for the public surface
- `references/data-model.md`: status codes, token terms fields, and the leverage derivation
- `references/mcp-server.md`: the same surface as MCP tools, with typed schemas

## Links

- Platform: https://commertize.com
- Documentation: https://commertize.com/docs
- News: https://commertize.com/news
- Disclaimer: https://commertize.com/disclaimer
