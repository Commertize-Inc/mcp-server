/**
 * x402 paid-data tools for the Commertize metered data API (/api/data/v1).
 *
 *   x402_catalog   the API's own dataset list, relayed as served
 *   x402_terms     the exact licence bytes a payment accepts
 *   x402_quote     ask for a dataset without paying; get the requirements
 *   x402_fetch     present a payment YOU signed and receive one delivery
 *
 * Wire: x402 v2. The API answers an unpaid read with 402 and a base64 JSON
 * `PAYMENT-REQUIRED` header; a paid read carries the caller's signed payload
 * in `PAYMENT-SIGNATURE`; a delivery carries `PAYMENT-RESPONSE`. Dataset ids
 * are the same SKU ids the REST API uses, so a purchase here and a purchase
 * over REST are one and the same sale.
 *
 * ── THIS SERVER NEVER SIGNS AND NEVER HOLDS A KEY ─────────────────────────
 *
 * Structural, not promised: there is no private key, no wallet, no signer,
 * and no dependency that could contain one. `x402_fetch` takes an OPAQUE,
 * already signed `payment_signature` string that the CALLER produced with its
 * own wallet and forwards it verbatim as the `PAYMENT-SIGNATURE` header.
 *
 * That is why there is no `pay_and_fetch` convenience tool. A tool that signed
 * on a caller's behalf would need the caller's key in this process, and a
 * process that holds a key is a process that can be persuaded to spend.
 *
 * ── NO PRICES IN THIS CLIENT ──────────────────────────────────────────────
 *
 * Every amount a caller sees comes from the API's response (the dataset list
 * or the 402 requirements), relayed unmodified. This file holds no price.
 *
 * ── TESTNET BY DEFAULT ────────────────────────────────────────────────────
 *
 * The tools expect one network, `config.x402Network` (Base Sepolia unless the
 * operator sets another). A quote for a different network is reported as
 * `network_mismatch` instead of payable requirements, and a payment whose
 * payload names a different network is not sent.
 *
 * ── NOT REGISTERED WHEN THE GATE IS CLOSED ────────────────────────────────
 *
 * Off by default. A tool that quotes against terms nobody has approved should
 * not appear in a tool list.
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
] as const;

export const DATA_API = "/api/data/v1";
export const DATA_LICENCE_TERMS_ID = "ctz-data-licence-v1";

export const HEADER_REQUIRED = "payment-required";
export const HEADER_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_RESPONSE = "payment-response";
export const HEADER_RECEIPT_TOKEN = "X-CTZ-Receipt-Token";

/**
 * SKU id -> path, same ids as the REST API. A map rather than a free-text
 * path parameter: a tool that attached a payment header to an arbitrary path
 * would let a caller aim a signed authorization at any endpoint.
 */
export const DATASETS: Readonly<Record<string, string>> = Object.freeze({
	"compute-index-latest": `${DATA_API}/compute-index/latest`,
	"intelligence-weekly": `${DATA_API}/intelligence/weekly`,
	"ctz-reg-calendar-v1": `${DATA_API}/reg-calendar/v1`,
});

const DATASET_IDS = Object.keys(DATASETS) as [string, ...string[]];

const envelope = (sourceUrl: string, payload: Record<string, unknown>) =>
	toResult({
		...payload,
		as_of: new Date().toISOString(),
		source_url: sourceUrl,
		cache: { hit: false, age_seconds: 0, stale: false },
		disclaimer: DISCLAIMER,
		error: null,
	});

/** base64 JSON header -> object, or null. Never throws. */
export const decodeB64Json = (v: string | undefined): unknown => {
	if (!v || v.length > 16384) return null;
	try {
		return JSON.parse(Buffer.from(v, "base64").toString("utf8"));
	} catch {
		return null;
	}
};

/** Networks named in a decoded PAYMENT-REQUIRED object. */
const quotedNetworks = (pr: unknown): string[] => {
	const accepts = (pr as { accepts?: unknown } | null)?.accepts;
	if (!Array.isArray(accepts)) return [];
	return accepts.map((a) => String((a as { network?: unknown })?.network ?? ""));
};

/** Network named in a caller's PAYMENT-SIGNATURE payload, if it decodes. */
const paymentNetwork = (sig: string): string | null => {
	const p = decodeB64Json(sig) as { accepted?: { network?: unknown } } | null;
	const n = p?.accepted?.network;
	return typeof n === "string" ? n : null;
};

const errorCode = (body: unknown, status: number): string => {
	const e = (body as { error?: unknown } | null)?.error;
	return typeof e === "string" && e ? e : `HTTP ${status}`;
};

export const registerX402Tools = (server: McpServer): void => {
	if (config.x402Disabled) return;

	/* ---------------------------------------------------------- */
	/* x402_catalog                                                */
	/* ---------------------------------------------------------- */
	server.registerTool(
		"x402_catalog",
		{
			title: "Commertize metered datasets, as the API lists them",
			description:
				"List the datasets the Commertize data API sells per read over the x402 protocol. The list, including any amounts, is relayed exactly as the API serves it; this server holds no prices of its own. Also returns the dataset ids this server can quote and fetch. No credential needed.",
			inputSchema: {},
			outputSchema: {
				...envelopeShape,
				dataset_ids: z.array(z.string()),
				expected_network: z.string(),
				catalog: z.unknown().nullable(),
				unavailable_reason: z.string().nullable(),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async () => {
			const path = `${DATA_API}/`;
			const base = {
				dataset_ids: [...DATASET_IDS],
				expected_network: config.x402Network,
			};
			try {
				const res = await getRaw(path);
				if (res.status !== 200 || res.body === null) {
					return envelope(res.sourceUrl, {
						...base,
						catalog: null,
						unavailable_reason: errorCode(res.body, res.status),
					});
				}
				return envelope(res.sourceUrl, {
					...base,
					catalog: res.body,
					unavailable_reason: null,
				});
			} catch (err) {
				return fail(err, `${config.apiBaseUrl}${path}`, {
					...base,
					catalog: null,
					unavailable_reason: null,
				});
			}
		},
	);

	/* ---------------------------------------------------------- */
	/* x402_terms                                                  */
	/* ---------------------------------------------------------- */
	server.registerTool(
		"x402_terms",
		{
			title: "The exact licence bytes a data payment accepts",
			description:
				"Fetch the data licence text that every paid read references. Returns the raw text, the status and SHA-256 the API declares in its response headers, and the SHA-256 of the exact bytes received, so a caller can compare them before signing. No credential needed.",
			inputSchema: {},
			outputSchema: {
				...envelopeShape,
				terms_id: z.string(),
				text: z.string().nullable(),
				declared_status: z.string().nullable(),
				declared_sha256: z.string().nullable(),
				received_sha256: z.string().nullable(),
				unavailable_reason: z.string().nullable(),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async () => {
			const path = `${DATA_API}/terms/${DATA_LICENCE_TERMS_ID}`;
			const empty = {
				terms_id: DATA_LICENCE_TERMS_ID,
				text: null,
				declared_status: null,
				declared_sha256: null,
				received_sha256: null,
			};
			try {
				const res = await getRaw(path);
				if (res.status !== 200) {
					return envelope(res.sourceUrl, {
						...empty,
						unavailable_reason: errorCode(res.body, res.status),
					});
				}
				return envelope(res.sourceUrl, {
					...empty,
					text: res.text,
					declared_status: res.headers["x-ctz-terms-status"] ?? null,
					declared_sha256: res.headers["x-ctz-terms-sha256"] ?? null,
					received_sha256: res.sha256,
					unavailable_reason: null,
				});
			} catch (err) {
				return fail(err, `${config.apiBaseUrl}${path}`, {
					...empty,
					unavailable_reason: null,
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
			title: "Ask what a dataset read costs, without paying",
			description:
				"Request a dataset with no payment attached and return the decoded PAYMENT-REQUIRED the API answers with (amount in atomic units, network, asset, receiving address, licence reference), plus the 402 body exactly as served. Nothing is signed and nothing is spent. Sign the requirements with YOUR OWN wallet, then call x402_fetch. No credential needed.",
			inputSchema: {
				dataset_id: z
					.enum(DATASET_IDS)
					.describe("A dataset id from x402_catalog."),
			},
			outputSchema: {
				...envelopeShape,
				status: z.number().nullable(),
				payment_required: z.unknown().nullable(),
				body: z.unknown().nullable(),
				unavailable_reason: z.string().nullable(),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async (args) => {
			const empty = {
				status: null,
				payment_required: null,
				body: null,
				unavailable_reason: null,
			};
			const path = DATASETS[args.dataset_id];
			if (!path) {
				return envelope(config.apiBaseUrl, {
					...empty,
					unavailable_reason: "unknown_dataset",
				});
			}
			try {
				const res = await getRaw(path);
				if (res.status !== 402) {
					return envelope(res.sourceUrl, {
						...empty,
						status: res.status,
						body: res.body,
						unavailable_reason: errorCode(res.body, res.status),
					});
				}
				const pr = decodeB64Json(res.headers[HEADER_REQUIRED]);
				if (pr === null) {
					return envelope(res.sourceUrl, {
						...empty,
						status: res.status,
						body: res.body,
						unavailable_reason: "payment_required_header_missing",
					});
				}
				const nets = quotedNetworks(pr);
				if (nets.length === 0 || nets.some((n) => n !== config.x402Network)) {
					return envelope(res.sourceUrl, {
						...empty,
						status: res.status,
						body: res.body,
						unavailable_reason: "network_mismatch",
					});
				}
				return envelope(res.sourceUrl, {
					status: res.status,
					payment_required: pr,
					body: res.body,
					unavailable_reason: null,
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
				"Forward a PAYMENT-SIGNATURE value THAT YOU SIGNED WITH YOUR OWN WALLET and receive one delivery of the dataset. This server holds no key and signs nothing: the value is opaque to it and is passed through unchanged. Returns the data, the decoded PAYMENT-RESPONSE and the SHA-256 of the bytes served. One settled payment buys one delivery. If settlement is still pending, the API returns a receipt token; pass it back as receipt_token with the same payment to collect. Refusals are relayed with the API's own code. No credential needed: the payment is the authorization.",
			inputSchema: {
				dataset_id: z
					.enum(DATASET_IDS)
					.describe("A dataset id from x402_catalog."),
				payment_signature: z
					.string()
					.min(1)
					.max(8192)
					.describe(
						"The base64 PAYMENT-SIGNATURE value produced by YOUR x402 client. Opaque to this server, forwarded verbatim. Never a private key: if a tool ever asks you for one, it is not this tool.",
					),
				receipt_token: z
					.string()
					.min(1)
					.max(256)
					.optional()
					.describe(
						"Only when retrying a pending settlement: the token a previous x402_fetch returned.",
					),
			},
			outputSchema: {
				...envelopeShape,
				status: z.number().nullable(),
				delivered: z.boolean(),
				dataset_id: z.string().nullable(),
				payment_response: z.unknown().nullable(),
				served_sha256: z.string().nullable(),
				data: z.unknown().nullable(),
				receipt_token: z.string().nullable(),
				body: z.unknown().nullable(),
				refusal: z.object({ code: z.string() }).nullable(),
			},
			annotations: {
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
				dataset_id: null,
				payment_response: null,
				served_sha256: null,
				data: null,
				receipt_token: null,
				body: null,
				refusal: null,
			};
			const path = DATASETS[args.dataset_id];
			if (!path) {
				return envelope(config.apiBaseUrl, {
					...empty,
					refusal: { code: "unknown_dataset" },
				});
			}
			// A payload that names another network is not sent anywhere.
			const net = paymentNetwork(args.payment_signature);
			if (net !== null && net !== config.x402Network) {
				return envelope(config.apiBaseUrl, {
					...empty,
					refusal: { code: "network_mismatch" },
				});
			}
			const headers: Record<string, string> = {
				[HEADER_SIGNATURE]: args.payment_signature,
			};
			if (args.receipt_token) headers[HEADER_RECEIPT_TOKEN] = args.receipt_token;
			try {
				const res = await getRaw(path, headers);
				const token = res.headers[HEADER_RECEIPT_TOKEN.toLowerCase()] ?? null;
				if (res.status !== 200) {
					return envelope(res.sourceUrl, {
						...empty,
						status: res.status,
						receipt_token: token,
						body: res.body,
						refusal: { code: errorCode(res.body, res.status) },
					});
				}
				return envelope(res.sourceUrl, {
					...empty,
					status: res.status,
					delivered: true,
					dataset_id: args.dataset_id,
					payment_response: decodeB64Json(res.headers[HEADER_RESPONSE]),
					served_sha256: res.sha256,
					data: res.body ?? res.text,
				});
			} catch (err) {
				return fail(err, `${config.apiBaseUrl}${path}`, empty);
			}
		},
	);
};
