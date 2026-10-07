# Commertize data model (public fields)

## Listing status

| Code | Meaning | Open for subscription |
|---|---|---|
| `TOKENIZING` | Entities and contracts being finalised, tokens being minted | No |
| `ACTIVE` | Live offering, accepting subscriptions from verified investors | **Yes** |
| `FULLY_FUNDED` | Allocation reached, closed to new subscriptions | No |
| `DISTRIBUTED` | Escrow released and tokens distributed | No |
| `REFUNDED` | Escrow returned to subscribers | No |
| `FROZEN` | Halted | No |
| `PENDING_REVIEW`, `REJECTED`, `WITHDRAWN` | Not publicly viewable | No |

Only `ACTIVE`, `FULLY_FUNDED`, and `TOKENIZING` appear in the public list response.

## Securities exemption (`offeringType`)

| Code | Exemption | Participation |
|---|---|---|
| `RULE_506_B` | Regulation D, Rule 506(b) | No general solicitation. Requires a pre-existing substantive relationship. |
| `RULE_506_C` | Regulation D, Rule 506(c) | General solicitation permitted; every purchaser must be a verified accredited investor. |
| `REG_A` | Regulation A | Tier-based caps and disclosure requirements. |
| `REG_CF` | Regulation Crowdfunding | Portal-based, capped. |
| `REG_S` | Regulation S | Offshore. |

## Asset classes

`listingType`: `COMMERCIAL_REAL_ESTATE` (live), `CARBON_CREDITS`, `MINING_LAND`,
`OIL_AND_GAS`.

`propertyType` (CRE): `MULTIFAMILY`, `OFFICE`, `RETAIL`, `INDUSTRIAL`, `MIXED_USE`,
`HOSPITALITY`, `DATA_CENTERS`, `SELF_STORAGE`, `HEALTHCARE`, `STUDENT_HOUSING`,
`SENIOR_LIVING`, `AGRICULTURAL`, `PARKING`, `OTHER`.

## Tokenomics

| Field | Meaning |
|---|---|
| `totalTokenSupply` | All tokens minted for the asset |
| `tokensForInvestors` | Tokens available in this offering |
| `tokensForSponsor` | Tokens retained by the sponsor |
| `tokensForTreasury` | Tokens held in the platform treasury |
| `tokenPrice` | Price per token in the offering currency |
| `minInvestmentTokens` | Minimum tokens per subscription |
| `maxInvestmentTokens` | Per-investor cap; absent means none disclosed |
| `lockupMonths` | Post-purchase transfer restriction, in months |

Offering size = `tokensForInvestors x tokenPrice`. That is the figure the escrow
contract is deployed against, so use it rather than `totalTokenSupply x tokenPrice`
(which is an implied valuation of the whole asset, not the amount being raised).

## SPV leverage disclosure

A token is a membership interest in the SPV that holds the asset. If the SPV carries
debt, the token tracks the equity residual, so the debt ratio is material.

The sponsor discloses an outstanding debt **amount**; the ratio is always derived,
never accepted as a self-reported percentage:

```
ratio = spvDebtAmount / assetValue

assetValue = currentAppraisalValue        if > 0
           else financials.purchasePrice   if > 0
           else financials.acquisitionCost if > 0
           else -> not derivable
```

Rules:

- No disclosed debt amount, or no usable asset value, means **"Not disclosed"**. It
  does **not** mean unlevered. Never render it as 0%.
- A disclosed `0` is a disclosure and is a real 0% ratio.
- The ratio is not clamped. A value above 1.0 means disclosed debt exceeds the stated
  asset value — which is exactly the thing a reader needs to see.

Note: the public list endpoint does not carry the debt field, so leverage is
"Not disclosed" for every public listing. If the field appears, treat it as
additive, not as a change in meaning.

## Honest nulls

Across the whole surface: an absent or `null` field means the value has not been
disclosed. It is never a zero, never an average, and never something to fill in from a
comparable asset. Say "not disclosed".
