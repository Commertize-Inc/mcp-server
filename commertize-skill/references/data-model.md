# Commertize data model (public fields)

All fields below are informational record fields. No offering is open on Commertize today.

## Record status (`status`)

| Code | What the label records |
|---|---|
| `TOKENIZING` | The sponsor's entity and contract setup is in progress |
| `ACTIVE` | The sponsor has marked the record active |
| `FULLY_FUNDED` | The sponsor's stated allocation is recorded as reached |
| `DISTRIBUTED` | Tokens are recorded as distributed |
| `REFUNDED` | Funds are recorded as returned |
| `FROZEN` | Halted |
| `PENDING_REVIEW`, `REJECTED`, `WITHDRAWN` | Not publicly viewable |

Only `ACTIVE`, `FULLY_FUNDED` and `TOKENIZING` appear in the public list response. A status code is a label on a record. No status means that a record is open, available or investable on Commertize today.

## Exemption code (`offeringType`)

The field holds the code for the securities exemption the sponsor has named. The field name is historical. It does not mean an offering is open.

| Code | Exemption named |
|---|---|
| `RULE_506_B` | Regulation D, Rule 506(b) |
| `RULE_506_C` | Regulation D, Rule 506(c) |
| `REG_A` | Regulation A |
| `REG_CF` | Regulation Crowdfunding |
| `REG_S` | Regulation S |

Do not explain to a user who may qualify under an exemption. Report only the code and its name.

## Asset classes

`listingType`: `COMMERCIAL_REAL_ESTATE`, `CARBON_CREDITS`, `MINING_LAND`, `OIL_AND_GAS`. These are categories in the data model. They are not claims that any asset is available.

`propertyType` (commercial real estate): `MULTIFAMILY`, `OFFICE`, `RETAIL`, `INDUSTRIAL`, `MIXED_USE`, `HOSPITALITY`, `DATA_CENTERS`, `SELF_STORAGE`, `HEALTHCARE`, `STUDENT_HOUSING`, `SENIOR_LIVING`, `AGRICULTURAL`, `PARKING`, `OTHER`.

## Token terms (`tokenomics`: per-asset token terms; not a Commertize token)

Sponsor-entered record fields: informational; no offering is open on Commertize today.

| Field | Record meaning |
|---|---|
| `totalTokenSupply` | Total token count the sponsor entered for the asset |
| `tokensForInvestors` | Token count the sponsor allocated to outside holders |
| `tokensForSponsor` | Token count the sponsor entered as retained |
| `tokensForTreasury` | Token count the sponsor entered as treasury |
| `tokenPrice` | Per-token price figure the sponsor entered |
| `minInvestmentTokens` | Minimum-quantity figure the sponsor entered |
| `maxInvestmentTokens` | Per-holder cap the sponsor entered; absent means none disclosed |
| `lockupMonths` | Transfer-restriction period the sponsor entered, in months |

Report these fields as entered. Do not multiply them into a raise size, a minimum amount or a valuation.

## SPV leverage disclosure

A token is designed to represent an interest in the SPV that holds the asset. If the SPV carries debt, that interest sits behind the debt, so the debt ratio matters.

The sponsor discloses an outstanding debt **amount**. The ratio is always derived. A self-reported percentage is never accepted:

```
ratio = spvDebtAmount / assetValue

assetValue = currentAppraisalValue        if > 0
           else financials.purchasePrice   if > 0
           else financials.acquisitionCost if > 0
           else -> not derivable
```

Rules:

- No disclosed debt amount, or no usable asset value, means **"Not disclosed"**. It does **not** mean unlevered. Never show it as 0%.
- A disclosed `0` is a disclosure, and it is a real 0% ratio.
- The ratio is not clamped. A value above 1.0 means the disclosed debt exceeds the stated asset value, and a reader needs to see that.

Note: the public list endpoint does not carry the debt field, so leverage is "Not disclosed" for every public record. If the field appears later, treat it as an addition, not as a change in meaning.

## Honest nulls

This applies to the whole surface. An absent or `null` field means the value has not been disclosed. It is never a zero, never an average, and never something to fill in from a comparable asset. Say "not disclosed".
