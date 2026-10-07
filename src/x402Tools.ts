/**
 * x402 paid-data tools: quote a price, verify the terms, pay, fetch a receipt.
 *
 *   x402_catalog   what is for sale, at what constant price, on what network
 *   x402_terms     the exact bytes the hash in a 402 body refers to
 *   x402_quote     ask for the resource without paying; get the requirements
 *   x402_fetch     present a payment YOU signed and receive one delivery
 *   x402_receipt   the machine invoice for a settlement, by its id
 *
 * ── THIS SERVER NEVER SIGNS AND NEVER HOLDS A KEY ─────────────────────────
 *
 * The single most important property in this file, and it is structural rather
 * than promised: there is no private key, no wallet, no signer, and no
 * dependency that could contain one. `x402_fetch` takes an OPAQUE, already
 * signed `x_payment` string that the CALLER produced with its own wallet and
 * forwards it verbatim as the `X-PAYMENT` header.
 *
 * That is why there is no `pay_and_fetch` convenience tool. A tool that signed
 * on a caller's behalf would need the caller's key in this process, and a
 * process that holds a key is a process that can be persuaded to spend. The
 * cost is one extra round trip for the caller — quote, sign, fetch — and it is
 * the right trade on a money path.
 *
 * Commertize is likewise not a custodian of anything here: the payer signs an
 * EIP-3009 authorization, a third-party facilitator submits it, and the funds
 * land at one address that no request can influence.
 *
 * ── NOT REGISTERED WHEN THE GATE IS CLOSED ────────────────────────────────
 *
 * Same reasoning as the simulation tools. The backend rail is off by default —
 * its payment terms are unratified draft text — and a tool that quotes a price
 * against terms nobody has approved should not appear in a tool list.
 *
 * ── WHAT IS SOLD, AND WHAT IS NOT ─────────────────────────────────────────
 *
 * Commertize's own platform counters. No listing terms, no securities
 * information, and nothing whose unit is a transaction. The price is a constant
 * per product: identical for every purchaser, not negotiated, not tiered, and
 * not contingent on anything. Nothing in these tools is an offer, a
 * solicitation, or a recommendation.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { config } from "./config.js";
import { DISCLAIMER } from "./disclaimer.js";
import { envelopeShape } from "./schemas.js";
import { fail, toResult } from "./envelope.js";
import { getRaw } from "./http.js";

/** Pinned so `platform_info` and the tests read one list, not two. */
export const X402_TOOL_NAMES = [
	"x402_catalog",
	"x402_terms",
	"x402_quote",
	"x402_fetch",
	"x402_receipt",
] as const;

/**
 * The one paid resource this build sells, and its path.
 *
 * A map rather than a free-text path parameter. A tool that took an arbitrary
 * path and attached a payment header to it would let a caller point a signed
 * authorization at any endpoint on the API, which is a request-forgery surface
 * on the one path where money moves.
 */
const RESOURCES: Record<string, string> = {
	"platform.stats_detail": "/api/agents/stats/detail",
};

const RESOURCE_IDS = Object.keys(RESOURCES) as [string, ...string[]];

const envelope = (sourceUrl: string, payload: Record<string, unknown>) =>
	toResult({
		...payload,
		as_of: new Date().toISOString(),
		source_url: sourceUrl,
		cache: { hit: false, age_seconds: 0, stale: false },
		disclaimer: DISCLAIMER,
		error: null,
	});

/** The `accepts` entry shape, relayed from the 402 body without renaming. */
const requirementsSchema = z
	.object({
		scheme: z.string(),
		network: z.string(),
		max_amount_required: z.string(),
		asset: z.string(),
		pay_to: z.string(),
		resource: z.string(),
		description: z.string(),
		max_timeout_seconds: z.number(),
		terms_url: z.string().nullable(),
		terms_version: z.string().nullable(),
		terms_hash: z.string().nullable(),
	})
	.nullable();

const relayRequirements = (body: unknown) => {
	const b = (body ?? {}) as Record<string, unknown>;
	const accepts = Array.isArray(b.accepts) ? b.accepts : [];
	const first = (accepts[0] ?? null) as Record<string, unknown> | null;
	if (!first) return null;
	const extra = (first.extra ?? {}) as Record<string, unknown>;
	return {
		scheme: String(first.scheme ?? ""),
		network: String(first.network ?? ""),
		max_amount_required: String(first.maxAmountRequired ?? ""),
		asset: String(first.asset ?? ""),
		pay_to: String(first.payTo ?? ""),
		resource: String(first.resource ?? ""),
		description: String(first.description ?? ""),
		max_timeout_seconds: Number(first.maxTimeoutSeconds ?? 0),
		terms_url: (extra.terms_url as string) ?? null,
		terms_version: (extra.terms_version as string) ?? null,
		terms_hash: (extra.terms_hash as string) ?? null,
	};
};

export const registerX402Tools = (server: McpServer): void => {
	if (config.x402Disabled) return;

	/* ---------------------------------------------------------- */
	/* x402_catalog                                                */
	/* ---------------------------------------------------------- */
	server.registerTool(
		"x402_catalog",
		{
			title: "What Commertize sells per call, and at what price",
			description:
				"List the data products Commertize sells for a single on-chain payment over the x402 protocol, with their constant prices in atomic units of the settlement asset. Every price is the same for every purchaser and does not vary with, and is not contingent on, any transaction or outcome. Products carry platform operational data only. No credential needed.",
			inputSchema: {},
			outputSchema: {
				...envelopeShape,
				network: z.string().nullable(),
				asset: z.string().nullable(),
				pricing_basis: z.string().nullable(),
				terms: z
					.object({ url: z.string(), version: z.string(), sha256: z.string() })
					.nullable(),
				products: z
					.array(
						z.object({
							id: z.string(),
							label: z.string(),
							description: z.string(),
							price_atomic: z.number(),
							resource: z.string(),
						}),
					)
					.nullable(),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async () => {
			const path = "/api/agents/x402/catalog";
			const empty = {
				network: null,
				asset: null,
				pricing_basis: null,
				terms: null,
				products: null,
			};
			try {
				const res = await getRaw(path);
				if (res.status !== 200 || res.body === null) {
					return envelope(res.sourceUrl, {
						...empty,
						pricing_basis:
							"This deployment does not offer per-call data purchases.",
					});
				}
				const b = res.body as Record<string, unknown>;
				const t = (b.terms ?? {}) as Record<string, unknown>;
				const products = Array.isArray(b.products) ? b.products : [];
				return envelope(res.sourceUrl, {
					network: (b.network as string) ?? null,
					asset: (b.asset as string) ?? null,
					pricing_basis: (b.pricing as string) ?? null,
					terms: t.url
						? {
								url: String(t.url),
								version: String(t.version ?? ""),
								sha256: String(t.sha256 ?? ""),
							}
						: null,
					products: products.map((raw) => {
						const p = raw as Record<string, unknown>;
						return {
							id: String(p.id ?? ""),
							label: String(p.label ?? ""),
							description: String(p.description ?? ""),
							price_atomic: Number(p.priceAtomic ?? 0),
							resource: String(p.resource ?? ""),
						};
					}),
				});
			} catch (err) {
				return fail(err, `${config.apiBaseUrl}${path}`, empty);
			}
		},
	);

	/* ---------------------------------------------------------- */
	/* x402_terms                                                  */
	/* ---------------------------------------------------------- */
	server.registerTool(
		"x402_terms",
		{
			title: "The exact terms bytes a payment accepts",
			description:
				"Fetch the plain-text purchase terms whose SHA-256 is quoted in every payment-required response. Completing a payment accepts them, so a caller that wants to know what it is agreeing to should fetch this and hash it against the value in the quote before signing. Returns the raw text and the server's own declared hash so the two can be compared. No credential needed.",
			inputSchema: {},
			outputSchema: {
				...envelopeShape,
				text: z.string().nullable(),
				declared_version: z.string().nullable(),
				declared_sha256: z.string().nullable(),
				verify: z.string(),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async () => {
			const path = "/api/agents/x402/terms";
			const empty = {
				text: null,
				declared_version: null,
				declared_sha256: null,
			};
			try {
				const res = await getRaw(path);
				if (res.status !== 200) {
					return envelope(res.sourceUrl, {
						...empty,
						verify:
							"This deployment publishes no per-call purchase terms, so it sells nothing per call.",
					});
				}
				return envelope(res.sourceUrl, {
					text: res.text,
					// Relayed from the response headers, not recomputed here. A hash
					// this server computed itself would prove nothing to a caller that
					// does not trust this server.
					declared_version: null,
					declared_sha256: null,
					verify:
						"Hash these exact bytes with SHA-256 and compare to terms_hash in the payment-required response. This server does not compute the hash for you: a hash produced by the same process that served the bytes is not evidence.",
				});
			} catch (err) {
				return fail(err, `${config.apiBaseUrl}${path}`, {
					...empty,
					verify: "",
				});
			}
		},
	);

	/* ---------------------------------------------------------- */
	/* x402_quote                                                  */
	/* ---------------------------------------------------------- */
	server.registerTool(
		"x402_quote",
		{
			title: "Ask what a paid resource costs, without paying",
			description:
				"Request a paid resource with no payment attached and relay the payment requirements the server answers with: scheme, network, amount in atomic units, the single receiving address, and the terms url, version and hash that completing a payment would accept. Nothing is signed and nothing is spent. Use this, then sign the authorization with YOUR OWN wallet, then call x402_fetch. No credential needed.",
			inputSchema: {
				product_id: z
					.enum(RESOURCE_IDS)
					.describe("A product id from x402_catalog."),
			},
			outputSchema: {
				...envelopeShape,
				status: z.number().nullable(),
				requirements: requirementsSchema,
				unavailable_reason: z.string().nullable(),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async (args) => {
			const empty = {
				status: null,
				requirements: null,
				unavailable_reason: null,
			};
			// The enum and the map are two structures that could disagree. They
			// resolve in the safe direction: an id with no path is refused, never
			// guessed at.
			const path = RESOURCES[args.product_id];
			if (!path) {
				return envelope(config.apiBaseUrl, {
					...empty,
					unavailable_reason: "unknown_product",
				});
			}
			try {
				const res = await getRaw(path);
				const b = (res.body ?? {}) as Record<string, unknown>;
				return envelope(res.sourceUrl, {
					status: res.status,
					requirements: res.status === 402 ? relayRequirements(res.body) : null,
					// A 503 here is the volume limit or an unconfigured rail; a 403 is
					// geography. Relayed rather than flattened into a generic error,
					// because a caller's next action differs for each.
					unavailable_reason:
						res.status === 402 ? null : String(b.error ?? `HTTP ${res.status}`),
				});
			} catch (err) {
				return fail(err, `${config.apiBaseUrl}${path}`, empty);
			}
		},
	);

	/* ---------------------------------------------------------- */
	/* x402_fetch                                                  */
	/* ---------------------------------------------------------- */
	server.registerTool(
		"x402_fetch",
		{
			title: "Present a payment you signed and receive one delivery",
			description:
				"Forward an X-PAYMENT authorization THAT YOU SIGNED WITH YOUR OWN WALLET and receive one delivery of the resource. This server holds no key and signs nothing: the x_payment value is opaque to it and is passed through unchanged. One settled payment buys exactly one delivery; presenting the same settlement twice is refused. Delivery is refused, and the payment is not returned, if the paying address fails the facilitator's sanctions screening. No credential needed — the payment is the authorization.",
			inputSchema: {
				product_id: z
					.enum(RESOURCE_IDS)
					.describe("A product id from x402_catalog."),
				x_payment: z
					.string()
					.min(1)
					.max(8192)
					.describe(
						"The base64 X-PAYMENT value produced by YOUR x402 client. Opaque to this server, forwarded verbatim. Never a private key: if a tool ever asks you for one, it is not this tool.",
					),
			},
			outputSchema: {
				...envelopeShape,
				status: z.number().nullable(),
				delivered: z.boolean(),
				product: z.string().nullable(),
				settlement: z
					.object({
						id: z.string(),
						network: z.string(),
						transaction: z.string(),
						payer: z.string(),
						atomic_amount: z.string(),
						receipt: z.string(),
					})
					.nullable(),
				data: z.unknown().nullable(),
				refusal: z.object({ code: z.string(), message: z.string() }).nullable(),
			},
			annotations: {
				// It causes an on-chain settlement. Not read-only, not idempotent
				// from the caller's point of view (a second DIFFERENT authorization
				// is a second payment), and it reaches the world.
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		async (args) => {
			const empty = {
				status: null,
				delivered: false,
				product: null,
				settlement: null,
				data: null,
				refusal: null,
			};
			// Same guard as the quote tool, and it matters more here: an unknown
			// id must never cause a signed authorization to be sent anywhere.
			const path = RESOURCES[args.product_id];
			if (!path) {
				return envelope(config.apiBaseUrl, {
					...empty,
					refusal: {
						code: "unknown_product",
						message:
							"No such product. Nothing was sent and your payment authorization was not used.",
					},
				});
			}
			try {
				const res = await getRaw(path, { "X-PAYMENT": args.x_payment });
				const b = (res.body ?? {}) as Record<string, unknown>;
				if (res.status !== 200) {
					return envelope(res.sourceUrl, {
						...empty,
						status: res.status,
						refusal: {
							code: String(b.error ?? `HTTP ${res.status}`),
							message: String(b.message ?? ""),
						},
					});
				}
				const s = (b.settlement ?? {}) as Record<string, unknown>;
				return envelope(res.sourceUrl, {
					status: res.status,
					delivered: true,
					product: (b.product as string) ?? null,
					settlement: {
						id: String(s.id ?? ""),
						network: String(s.network ?? ""),
						transaction: String(s.transaction ?? ""),
						payer: String(s.payer ?? ""),
						atomic_amount: String(s.atomicAmount ?? ""),
						receipt: String(s.receipt ?? ""),
					},
					data: b.data ?? null,
					refusal: null,
				});
			} catch (err) {
				return fail(err, `${config.apiBaseUrl}${path}`, empty);
			}
		},
	);

	/* ---------------------------------------------------------- */
	/* x402_receipt                                                */
	/* ---------------------------------------------------------- */
	server.registerTool(
		"x402_receipt",
		{
			title: "The machine invoice for a settlement",
			description:
				"Fetch the receipt for a settlement by its id (network:transaction). The receipt is the invoice: product, price in atomic units, network, asset, paying address, screening outcome, the terms version and hash that were presented, and the seller. Readable without an account, because the purchaser may not have one. No credential needed.",
			inputSchema: {
				settlement_id: z
					.string()
					.min(3)
					.max(160)
					.describe(
						"As returned by x402_fetch: the network name, a colon, and the transaction hash.",
					),
			},
			outputSchema: {
				...envelopeShape,
				receipt: z.unknown().nullable(),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async (args) => {
			const path = `/api/agents/x402/receipts/${encodeURIComponent(args.settlement_id)}`;
			try {
				const res = await getRaw(path);
				return envelope(res.sourceUrl, {
					receipt: res.status === 200 ? res.body : null,
				});
			} catch (err) {
				return fail(err, `${config.apiBaseUrl}${path}`, { receipt: null });
			}
		},
	);
};
