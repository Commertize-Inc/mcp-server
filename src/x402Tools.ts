/**
 * x402 paid-data tools for the Commertize metered data API (/api/data/v1).
 *
 *   x402_catalog   each dataset with the API's own unpaid quote, relayed as served
 *   x402_terms     the exact licence bytes a payment accepts
 *   x402_quote     ask for a dataset without paying; get the requirements
 *   x402_fetch     present a payment (or #1278 free read) YOU signed; one delivery
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
/** #1278 free read tier: the caller's signed passport read, and its answer. */
export const HEADER_FREE_READ = "X-CTZ-Free-Read";
export const HEADER_FREE_RECEIPT = "x-ctz-free-read-receipt";
export const HEADER_FREE_REMAINING = "x-ctz-free-reads-remaining";
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

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

/** The only x402 wire version these tools quote or pay on. */
const X402_VERSION = 2;

type PaymentCheck =
	| { ok: true }
	| { ok: false; code: "payment_signature_undecodable" | "x402_version_unsupported" | "network_mismatch" };

/**
 * Fail-closed check of a caller's PAYMENT-SIGNATURE payload.
 * Only a payload that decodes, is x402 v2, and names config.x402Network in
 * accepted.network is sent. Anything else (undecodable, the v1 top-level
 * `network` shape, no network) is refused before any request is made.
 */
const checkPayment = (sig: string): PaymentCheck => {
	const p = decodeB64Json(sig) as
		| { x402Version?: unknown; accepted?: { network?: unknown } }
		| null;
	if (p === null || typeof p !== "object") {
		return { ok: false, code: "payment_signature_undecodable" };
	}
	if (p.x402Version !== X402_VERSION) {
		return { ok: false, code: "x402_version_unsupported" };
	}
	const n = p.accepted?.network;
	if (typeof n !== "string" || n !== config.x402Network) {
		return { ok: false, code: "network_mismatch" };
	}
	return { ok: true };
};

const errorCode = (body: unknown, status: number): string => {
	const e = (body as { error?: unknown } | null)?.error;
	return typeof e === "string" && e ? e : `HTTP ${status}`;
};

type QuoteOutcome = {
	status: number;
	payment_required: unknown;
	body: unknown;
	unavailable_reason: string | null;
	sourceUrl: string;
};

/**
 * One unpaid request to a dataset path. The decoded PAYMENT-REQUIRED is
 * returned only when it is x402 v2 and every accept names the expected
 * network; otherwise it is null with the reason. Throws what getRaw throws.
 */
const quoteOnce = async (path: string): Promise<QuoteOutcome> => {
	const res = await getRaw(path);
	const refuse = (reason: string): QuoteOutcome => ({
		status: res.status,
		payment_required: null,
		body: res.body,
		unavailable_reason: reason,
		sourceUrl: res.sourceUrl,
	});
	if (res.status !== 402) return refuse(errorCode(res.body, res.status));
	const pr = decodeB64Json(res.headers[HEADER_REQUIRED]);
	if (pr === null) return refuse("payment_required_header_missing");
	if ((pr as { x402Version?: unknown }).x402Version !== X402_VERSION) {
		return refuse("x402_version_unsupported");
	}
	const nets = quotedNetworks(pr);
	if (nets.length === 0 || nets.some((n) => n !== config.x402Network)) {
		return refuse("network_mismatch");
	}
	return {
		status: res.status,
		payment_required: pr,
		body: res.body,
		unavailable_reason: null,
		sourceUrl: res.sourceUrl,
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
			title: "Commertize metered datasets, with the API's own quote for each",
			description:
				"List the datasets the Commertize data API sells per read over the x402 protocol, each with the decoded PAYMENT-REQUIRED the API answers an unpaid read with (one unpaid request per dataset; nothing is signed or spent). Every amount is relayed exactly as the API serves it; this server holds no prices of its own. No credential needed.",
			inputSchema: {},
			outputSchema: {
				...envelopeShape,
				dataset_ids: z.array(z.string()),
				expected_network: z.string(),
				catalog: z
					.array(
						z.object({
							dataset_id: z.string(),
							status: z.number().nullable(),
							payment_required: z.unknown().nullable(),
							unavailable_reason: z.string().nullable(),
						}),
					)
					.nullable(),
				unavailable_reason: z.string().nullable(),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async () => {
			const base = {
				dataset_ids: [...DATASET_IDS],
				expected_network: config.x402Network,
			};
			// The data API serves no dataset index (no GET /api/data/v1/ on
			// the #1260 -> #1278 chain), so the catalogue is the API's own
			// unpaid answer for each dataset, in SKU order.
			try {
				const catalog = [];
				for (const id of DATASET_IDS) {
					const path = DATASETS[id];
					if (!path) throw new Error(`no path for ${id}`);
					const q = await quoteOnce(path);
					catalog.push({
						dataset_id: id,
						status: q.status,
						payment_required: q.payment_required,
						unavailable_reason: q.unavailable_reason,
					});
				}
				const anyOk = catalog.some((e) => e.unavailable_reason === null);
				return envelope(`${config.apiBaseUrl}${DATA_API}`, {
					...base,
					catalog,
					unavailable_reason: anyOk ? null : "no_dataset_quoted",
				});
			} catch (err) {
				return fail(err, `${config.apiBaseUrl}${DATA_API}`, {
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
				const q = await quoteOnce(path);
				return envelope(q.sourceUrl, {
					status: q.status,
					payment_required: q.payment_required,
					body: q.body,
					unavailable_reason: q.unavailable_reason,
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
					.optional()
					.describe(
						"The base64 PAYMENT-SIGNATURE value produced by YOUR x402 client. Opaque to this server, forwarded verbatim. Never a private key: if a tool ever asks you for one, it is not this tool. Give this OR free_read, not both.",
					),
				free_read: z
					.string()
					.min(1)
					.max(4096)
					.optional()
					.describe(
						"Instead of a payment: the base64url X-CTZ-Free-Read value YOUR agent signed for its passport, if the API's free read tier is on. Opaque to this server, forwarded verbatim; this server signs nothing. Give this OR payment_signature, not both.",
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
				free_read_receipt: z.string().nullable(),
				free_reads_remaining: z.string().nullable(),
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
				free_read_receipt: null,
				free_reads_remaining: null,
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
			// Exactly one authorization: a payment or a free read. The API
			// only considers a free read when no payment is attached, so
			// sending both would make the outcome depend on server order.
			const refuse = (code: string) =>
				envelope(config.apiBaseUrl, { ...empty, refusal: { code } });
			const sig = args.payment_signature;
			const free = args.free_read;
			if (sig !== undefined && free !== undefined) {
				return refuse("payment_and_free_read");
			}
			if (sig === undefined && free === undefined) {
				return refuse("payment_or_free_read_required");
			}
			const headers: Record<string, string> = {};
			if (sig !== undefined) {
				// A payload that does not decode, is not v2, or names another
				// network is not sent anywhere (fail closed).
				const verdict = checkPayment(sig);
				if (!verdict.ok) return refuse(verdict.code);
				headers[HEADER_SIGNATURE] = sig;
				if (args.receipt_token) {
					headers[HEADER_RECEIPT_TOKEN] = args.receipt_token;
				}
			} else {
				if (!BASE64URL.test(free as string)) {
					return refuse("free_read_undecodable");
				}
				headers[HEADER_FREE_READ] = free as string;
			}
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
				// Free-read headers are reported only for a free read: a paid
				// delivery never claims a free receipt.
				const isFree = sig === undefined;
				return envelope(res.sourceUrl, {
					...empty,
					status: res.status,
					delivered: true,
					dataset_id: args.dataset_id,
					free_read_receipt: isFree
						? (res.headers[HEADER_FREE_RECEIPT] ?? null)
						: null,
					free_reads_remaining: isFree
						? (res.headers[HEADER_FREE_REMAINING] ?? null)
						: null,
					payment_response: isFree
						? null
						: decodeB64Json(res.headers[HEADER_RESPONSE]),
					served_sha256: res.sha256,
					data: res.body ?? res.text,
				});
			} catch (err) {
				return fail(err, `${config.apiBaseUrl}${path}`, empty);
			}
		},
	);
};
