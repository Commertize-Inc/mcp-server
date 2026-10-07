# Commertize public API reference

Base URL: `https://api.commertize.com`. Every route below is unauthenticated and
read-only. Paths are also served without the `/api` prefix; prefer `/api`.

## GET /api/listings

The live public marketplace set. No parameters. Returns a JSON array.

Included statuses: `ACTIVE`, `FULLY_FUNDED`, `TOKENIZING`. Anything in review,
withdrawn, rejected, or frozen is absent from this response.

Returned fields per listing:

```jsonc
{
  "id": "uuid",
  "name": "string",
  "city": "string",
  "state": "string",
  "propertyType": "MULTIFAMILY | OFFICE | RETAIL | INDUSTRIAL | MIXED_USE | HOSPITALITY | DATA_CENTERS | SELF_STORAGE | HEALTHCARE | STUDENT_HOUSING | SENIOR_LIVING | AGRICULTURAL | PARKING | OTHER",
  "status": "ACTIVE | FULLY_FUNDED | TOKENIZING",
  "offeringType": "RULE_506_B | RULE_506_C | REG_A | REG_CF | REG_S",
  "sponsor": { "id": "uuid", "businessName": "string" },
  "financials": { /* sponsor-supplied; may be empty */ },
  "tokenomics": { /* may be empty */ },
  "images": ["url"],
  "impliedEquityValuation": null,
  "investorTokenShare": null,
  "sponsorTokenShare": null,
  "derivedCapRate": null,
  "year1CashOnCash": null,
  "effectiveAppraisalValue": null
}
```

The six trailing fields are platform-derived and are `null` unless the inputs they
depend on have been disclosed. `financials` and `tokenomics` are JSON objects that may
be empty for a listing still being structured.

Rate limit: 120 requests per minute per client.

## GET /api/listings/{id}

**Authenticated.** Returns 401 without a session token. Not part of this skill. It is
the only source of funding progress, investor counts, escrow state, documents, and
street address — none of which are public.

## GET /api/news

Query: `limit` (default 50, maximum 100). Returns `{ "data": [ ... ] }`, published
articles only, newest first.

Article fields: `id`, `slug`, `title`, `summary`, `content` (HTML, with an embedded
JSON-LD `<script>` block), `category`, `tags`, `imageUrl`, `readTime`, `publishedAt`,
`createdAt`, `updatedAt`.

Rate limit: 120 requests per minute.

## GET /api/news/{slug}

One published article, same shape, wrapped in `{ "data": { ... } }`. 404 for an unknown
or unpublished slug.

## Everything else

All other routes require a session token or a server key and are out of scope:
`/api/invest`, `/api/investments`, `/api/dividends`, `/api/profile`, `/api/sponsor`,
`/api/onboarding`, `/api/notifications`, `/api/upload`, `/api/reviews`, `/api/admin`,
`/api/ai-content`, `/api/carbon-credit`, `/api/oracle/*`, `/api/sumsub/*`,
`/api/stats/platform` (session required since 2026-09-26).

`/api/docs/content` and `/api/docs/search` are technically open but proxy a
retrieval service with real per-call cost. Do not put them in an agent loop.
