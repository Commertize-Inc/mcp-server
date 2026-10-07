---
name: commertize
description: Read the Commertize marketplace of tokenized real-world assets — list live offerings and their public terms (asset class, location, status, exemption, tokenomics, SPV leverage disclosure) and read published market commentary. Use for questions about what is listed on Commertize, how a specific Commertize offering is structured, or how the platform verifies investors and sponsors. Do NOT use for other tokenization platforms, for generic real-estate data, or to transact — nothing here can transact, and as the server ships it has no write tool at all.
---

# Commertize

Commertize is a digital capital markets platform for real-world assets. Sponsors list offerings on it, and investors complete identity verification on the platform before they can take part.

This skill covers the **public, read-only** surface. Everything below can be called
with no credentials. There is no authenticated route, no key, and no action that moves
value in this skill.

## Start here

1. **Platform reference**: read §"What is listed" below for how offerings are structured.
2. **Offerings**: `GET https://api.commertize.com/api/listings` — the live public
   marketplace set.
3. **Commentary**: `GET https://api.commertize.com/api/news?limit=20` — published
   articles; `GET /api/news/{slug}` for one full body.
4. **MCP alternative**: if your runtime speaks MCP, the same surface is available as
   typed tools (`list_offerings`, `get_offering`, `get_news`, `get_article`,
   `platform_info`) with schemas, cache metadata, and a
   disclaimer on every response. See `references/mcp-server.md`.

## Quick setup

```bash
export COMMERTIZE_API="https://api.commertize.com"
curl -sS "$COMMERTIZE_API/api/listings" | jq '.[] | {id, name, city, state, propertyType, status, offeringType}'
```

No key, no header, no registration. Cache responses for about 60 seconds; the public
read routes are rate limited (120 requests/minute for listings and news).

## 1. Read the marketplace

```http
GET /api/listings
```

Returns the offerings in a publicly viewable status (`ACTIVE`, `FULLY_FUNDED`,
`TOKENIZING`) with the fields the public marketplace renders:

| Field | Meaning |
|---|---|
| `id` | Offering UUID. Use it to reference a specific offering. |
| `name`, `city`, `state` | Asset identity. Street address is not public. |
| `propertyType` | Asset class, e.g. `MULTIFAMILY`, `HOSPITALITY`, `OFFICE`, `DATA_CENTERS`. |
| `status` | `ACTIVE` is the only status open for subscription. |
| `offeringType` | Securities exemption: `RULE_506_B`, `RULE_506_C`, `REG_A`, `REG_CF`, `REG_S`. |
| `sponsor` | `{ id, businessName }` — the issuer of that offering. |
| `tokenomics` | `tokenPrice`, `totalTokenSupply`, `tokensForInvestors`, `tokensForSponsor`, `tokensForTreasury`, `minInvestmentTokens`, `maxInvestmentTokens`, `lockupMonths`. Fields may be absent. |
| `financials` | Sponsor-supplied figures for the asset. Fields may be absent. |

Derived values, computed the same way the platform computes them:

- Offering size = `tokenomics.tokensForInvestors x tokenomics.tokenPrice`
- Minimum subscription = `tokenomics.minInvestmentTokens x tokenomics.tokenPrice`
- SPV leverage = `spvDebtAmount / assetValue`, where `assetValue` is the current
  appraisal, else the purchase price, else the acquisition cost — in that order.

**A missing field means "not disclosed". It never means zero.** Report undisclosed
figures as "Not disclosed"; never render an offering with no disclosed debt as
unlevered, and never substitute `0` for an absent number.

## 2. Read one offering

There is no public detail endpoint. Filter the list response by `id`:

```bash
curl -sS "$COMMERTIZE_API/api/listings" | jq --arg id "$OFFERING_ID" '.[] | select(.id == $id)'
```

The full listing record — offering documents, sponsor diligence, funding progress,
investor data, escrow state, street address — is authenticated and is not reachable
from this skill. Do not infer those values; say they are not public.

## 3. Platform statistics

Not public. `GET /api/stats/platform` requires a signed-in session and is out of scope
for this skill; do not report platform-wide counts.

## 4. Read market commentary

```http
GET /api/news?limit=20
GET /api/news/{slug}
```

Articles carry `slug`, `title`, `summary`, `category`, `publishedAt`, `readTime`,
`imageUrl`, and an HTML `content` body. The body embeds a JSON-LD `<script>` block —
strip script tags before reading it as prose, or you will read the metadata twice.
Public permalink: `https://commertize.com/news/{slug}`.

This is Commertize's own editorial view. Attribute it as such; it is not independent
research.

## 5. What is listed, and how it is structured

- Asset classes modelled by the platform: commercial real estate (the live category),
  carbon credits, mining land, oil and gas.
- Each asset sits in its own special-purpose vehicle (SPV). A token is a membership
  interest in that SPV, not direct title to the asset. Where the SPV carries debt, the
  token tracks the equity residual — which is why the leverage disclosure matters.
- Each distribution the issuer declares is calculated and recorded per holder. Frequency
  and waterfall terms are set per offering and are disclosed in that offering's
  documents.
- A token moves only between wallets verified in the identity registry or exempted by
  the platform; minting needs a verified or exempt receiver.

## 6. Verification and who may participate

- Investors complete identity verification and sanctions screening before they can
  subscribe; accreditation is established where the exemption requires it.
- Sponsors complete business verification covering the entity, its beneficial owners,
  and its authority to make the offering, before a listing goes live.
- Verification attaches to a natural or legal person. An agent has no standing of its
  own; any agent-initiated action must resolve to a verified principal who
  authorised it.

## Rules for agents using this skill

1. **Nothing here transacts.** The default server registers no write tool at all: the
   feasibility-memo request (`request_memo`) is not deployed and is switched off, so
   `tools/list` is all reads. Where an operator has enabled it, it still moves no value:
   it records a request for a memo about the user's own asset. Nothing subscribes,
   transfers, claims, or commits anyone to anything. If a user asks you to invest,
   explain that participation runs through verified onboarding at
   https://app.commertize.com and stop.
2. **Never present this data as an offer.** Offerings are private placements under
   exemptions from registration. Rule 506(b) offerings in particular permit no general
   solicitation: treat those records as reference information only.
3. **Carry the disclaimer** into anything you report: informational only; not an offer,
   solicitation, or recommendation; not investment, legal, or tax advice.
4. **Distinguish disclosed from derived from projected.** Sponsor disclosures, values
   you computed, and sponsor projections are three different things, and projections
   are estimates that may not be achieved.
5. **Timestamp everything.** State when you fetched the data. Listing status changes.
6. **Say "not public" rather than estimating.** Funding progress, documents, and
   investor data are not available; an estimate would be a fabrication.

## Typical errors

| HTTP | Meaning |
|---|---|
| 401 | You called an authenticated route. No route in this skill requires auth; re-read the path. |
| 404 | Unknown article slug, or an offering that is not in a publicly viewable status. |
| 429 | Rate limited. Back off and reuse cached responses; the read limits are per minute. |
| 500 | Upstream error. Retry with backoff; do not report an empty list as "no offerings". |

## References

- `references/api-reference.md`: endpoint-by-endpoint reference for the public surface
- `references/data-model.md`: enumerations, tokenomics fields, and the leverage derivation
- `references/mcp-server.md`: the same surface as MCP tools, with typed schemas

## Links

- Platform: https://commertize.com
- How it works: https://commertize.com/how-it-works
- Documentation: https://commertize.com/docs
- News: https://commertize.com/news
- App (sign-in required): https://app.commertize.com
