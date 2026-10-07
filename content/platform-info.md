# Commertize — platform information for AI agents

_Curated reference text served by the `platform_info` tool. Static, human-maintained,
and deliberately conservative: if a claim cannot be verified from the product, it is
not in this file._

## What Commertize is

Commertize is a digital capital markets platform for real-world assets. It handles the
full lifecycle of an asset-backed private offering: structuring the asset into a legal
vehicle, issuing the economic rights as on-chain tokens, verifying and onboarding
investors under the applicable exemption, settling subscriptions on-chain against
escrow, and administering the position afterwards — reporting, distributions, and
transfer controls.

Tokenization is one layer of that stack, not the product. The product is the
infrastructure a private offering needs in order to exist and be administered
programmatically.

Commertize provides software infrastructure for private capital markets. Nothing
returned by this tool is an offer, a solicitation, or a recommendation to buy or sell
any security, or investment, legal, or tax advice.

## What is listed

Asset classes currently modelled by the platform: commercial real estate (the live
category — multifamily, hospitality, office, retail, industrial, data centers, and
related property types), carbon credits, mining land, and oil and gas. Additional
classes are added as structuring and diligence support for them is completed.

Each listing is a distinct offering with its own sponsor, legal entity, and terms.
Commertize does not pool assets across listings.

## How an offering is structured

- The asset is held in a special-purpose vehicle (SPV). An investor's token
  represents a membership interest in that SPV, not direct title to the asset.
- Because the SPV may carry property-level debt, the token tracks the equity residual.
  Where a sponsor has disclosed outstanding SPV debt, the platform derives and displays
  the leverage ratio against the asset's appraised value, purchase price, or
  acquisition cost. Where nothing has been disclosed, the platform shows
  "Not disclosed" — it never renders an undisclosed listing as unlevered.
- Subscriptions settle into an escrow contract. Funds are released to the sponsor only
  on a successful close; a failed raise refunds subscribers through the same contract.
- Distributions, when an offering makes them, are administered on-chain through a
  distribution vault. Frequency and waterfall terms are set per offering and are
  disclosed in that offering's documents.

## Exemptions and who can participate

Offerings are private placements made under exemptions from registration — principally
Regulation D (Rule 506(b) and Rule 506(c)), with Regulation A, Regulation
Crowdfunding, and Regulation S supported by the data model. The exemption governs who
may participate and how an offering may be discussed:

- **Rule 506(b)** permits no general solicitation. Participation requires a
  pre-existing substantive relationship with the issuer.
- **Rule 506(c)** permits general solicitation, but every purchaser must be an
  accredited investor whose status the issuer has taken reasonable steps to verify.

Listing data exposed to agents is reference information for research. It is not an
offer, not a solicitation, and not a recommendation.

## How verification works

- **Investors** complete identity verification (KYC) and sanctions/AML screening
  before they can subscribe. Accreditation status is established where the exemption
  requires it.
- **Sponsors** complete business verification (KYB) covering the entity, its
  beneficial owners, and its authority to make the offering, before a listing can go
  live.
- Both flows run through Sumsub, the platform's identity provider. Verification
  artefacts are held by the provider and the platform; they are never exposed through
  any public or agent-facing interface.
- Verification attaches to a natural or legal person. An agent acting on someone's
  behalf does not hold standing of its own; any agent-initiated action resolves
  to a verified principal who authorised it.

## What agents can and cannot do

**Can (this server, no credentials required):**

- read the live marketplace listing set and each listing's public terms;
- read platform-level counts and totals;
- read published news and market commentary;
- read this reference text.

**Cannot, through any public interface:**

- read a listing's full detail record, documents, sponsor diligence file, or investor
  data — all of that is authenticated and access-controlled;
- subscribe, transfer, claim a distribution, or take any other action that moves value
  or creates an obligation. No tool in this server can transact, and as this server
  ships it has no write tool at all.

**Not available on this server by default: the feasibility-memo request.**

A tool named `request_memo` — a services inquiry about an asset the calling agent's
principal owns, answered by a person — exists in this codebase but is NOT registered by
default, because the endpoint it posts to is not deployed on Commertize's production
API. Rather than list a tool that could only fail, the server does not offer it. If you
are reading this from a server where `request_memo` IS listed, the operator has
enabled it against an API that serves it.

## On-chain status

Smart contracts (asset tokens, escrow, distribution vault, compliance and transfer
controls) are deployed to test networks. Any listing state served here
reflects the platform's records for the environment it is running against.

## Links

- Platform: https://commertize.com
- How it works: https://commertize.com/how-it-works
- Documentation: https://commertize.com/docs
- FAQ: https://commertize.com/faq
- News and commentary: https://commertize.com/news
- Investor and sponsor app (sign-in required): https://app.commertize.com
- Terms: https://commertize.com/terms
- Privacy: https://commertize.com/privacy
- AML policy: https://commertize.com/aml-policy
- KYB policy: https://commertize.com/kyb-policy
- Disclaimer: https://commertize.com/disclaimer

## Data notes for agents

- Every response from this server carries an `as_of` timestamp, the upstream source
  URL, cache metadata, and a standing disclaimer. Treat `as_of` as the age of the
  data, not the time you called.
- Undisclosed values are `null` and are named in a `not_disclosed` array. `null` means
  "not disclosed", never zero.
- Values under `derived` are computed by this server from disclosed inputs; values
  under `projections` are forward-looking figures supplied by a sponsor and are
  estimates, not statements of fact.
- Responses are cached briefly. Repeated identical calls are served from cache rather
  than hitting the API.
