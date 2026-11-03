# Commertize: platform information for AI agents

_Reference text served by the `platform_info` tool. It is static, maintained by people, and conservative on purpose: if a claim cannot be checked against the product, it is not in this file._

## What Commertize is

Commertize builds infrastructure for tokenizing real-world assets and for agentic commerce. For assets, the software keeps an on-chain register of holders and applies the transfer rules that the asset's sponsor sets. Each sponsor is responsible for its own asset, its legal structure and its documents.

Nothing returned by this tool is an offer to sell, a solicitation of an offer to buy, or a recommendation about any security or asset. Nor is it investment, legal or tax advice.

## Assets shown

The platform's data model covers commercial real estate, carbon credits, mining land, and oil and gas. Each listing is a separate asset with its own sponsor, legal entity and terms. Commertize does not pool assets across listings. Listing data is informational only.

## How an asset is typically structured

- The asset is usually held in a special-purpose vehicle (SPV). A token represents an interest in that SPV, not direct title to the asset.
- If the SPV carries debt, the platform shows the leverage the sponsor discloses. If the sponsor has disclosed nothing, it shows "Not disclosed", never zero.
- Any terms for distributions, transfers and eligibility are set by the sponsor in that asset's own documents.
- The contracts are designed so a token moves only to wallets that the asset's transfer rules allow.

## What agents can and cannot do

**Can (this server, no credentials):** read public listing data, platform-level counts, published news and commentary, and this reference text.

**Cannot:** read non-public records, documents or personal data; subscribe, transfer, claim or take any action that moves value or creates an obligation. This server has no write tool.

The `request_memo` tool exists in the code but is not registered by default, because the endpoint it uses is not deployed.

## On-chain status

The smart contracts are deployed on test networks only. Nothing on-chain described here is live on a main network.

## Links

- Platform: https://commertize.com
- Documentation: https://commertize.com/docs
- News: https://commertize.com/news
- Terms: https://commertize.com/terms
- Privacy: https://commertize.com/privacy
- Disclaimer: https://commertize.com/disclaimer

## Data notes for agents

- Every response carries an `as_of` timestamp, the source URL, cache metadata and a standing disclaimer. Treat `as_of` as the age of the data.
- Undisclosed values are `null` and are listed in `not_disclosed`. `null` means "not disclosed", never zero.
- `derived` values are computed from disclosed inputs. `projections` are a sponsor's estimates, not facts.
- Responses are cached briefly.
