/**
 * Per-call Commertize data products (backend /api/agent-data, x402 v2).
 *
 *   data_products_catalog   what is listed, at what constant price, with
 *                           its free quota and daily caps
 *   get_supplier_profile    P4: the dated sanctions-screen status of each
 *                           party Commertize screened for one supplier
 *
 * THIS SERVER NEVER SIGNS AND NEVER HOLDS A KEY (the x402Tools.ts rule).
 * `get_supplier_profile` takes an optional, OPAQUE `payment_signature` that
 * the CALLER produced with its own wallet and forwards it verbatim as the
 * x402 v2 `PAYMENT-SIGNATURE` header. Without it the backend serves a free
 * call or answers 402 with the requirements, which this tool relays.
 *
 * The payee is fixed by the backend (a compile-time Commertize address); no
 * input here can name one. The supplier id is validated to a narrow
 * charset and is the only path segment a caller controls.
 *
 * NOT REGISTERED unless COMMERTIZE_MCP_ENABLE_DATA_PRODUCTS=1.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { config } from "./config.js";
import { DISCLAIMER } from "./disclaimer.js";
import { envelopeShape } from "./schemas.js";
import { fail, toResult } from "./envelope.js";
import { getRaw } from "./http.js";

export const DATA_PRODUCT_TOOL_NAMES = [
	"data_products_catalog",
	"get_supplier_profile",
] as const;

const envelope = (sourceUrl: string, payload: Record<string, unknown>) =>
	toResult({
		...payload,
		as_of: new Date().toISOString(),
		source_url: sourceUrl,
		cache: { hit: false, age_seconds: 0, stale: false },
		disclaimer: DISCLAIMER,
		error: null,
	});

const str = (v: unknown): string | null =>
	typeof v === "string" ? v : v === undefined || v === null ? null : String(v);

/** A transaction hash relayed from the backend, or null (never invented). */
const txHash = (v: unknown): string | null =>
	typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v) ? v : null;

/**
 * DP-FLAG-18: the backend's `payment` block on a 403/409/503 for an
 * authorization that already settled. Relayed only when it is well formed
 * (a tx hash and a job id); otherwise no claim either way. The note is
 * client-facing copy (AXIOM review with DP-FLAG-9 before flag-on).
 */
const JOB_ID = /^[A-Za-z0-9-]{1,64}$/;
export const settledRefusal = (b: Record<string, unknown>) => {
	const p = (b.payment ?? null) as Record<string, unknown> | null;
	const tx = p && p.settled === true ? txHash(p.transaction) : null;
	const job = p && typeof p.job_id === "string" && JOB_ID.test(p.job_id) ? p.job_id : null;
	if (!tx || !job) return {};
	const receipt = p!.receipt_issued === true ? job : null;
	return {
		payment_settled: true,
		transaction: tx,
		receipt_id: receipt,
		payment_note: receipt
			? `Payment settled, receipt ${receipt}. This call was not charged again.`
			: `Payment settled (transaction ${tx}, job ${job}). This call was not charged again.`,
	};
};

/**
 * DP-FLAG-23 (independent M-2 on f555e93b): a 402 or a 503 answered to a
 * request that CARRIED a payment_signature does not prove nothing was
 * charged. The signed authorization stays settleable by anyone holding it
 * until its validBefore, and the backend does not relay validBefore, so the
 * note is fixed copy (AXIOM review with DP-FLAG-9 before flag-on). Never
 * added when the backend reported a settlement (settledRefusal wins).
 */
export const UNSETTLED_SIGNATURE_CAUTION =
	"No result was delivered for this call, and the payment authorization you signed may still settle until its expiry. Do not re-sign with a new nonce; to retry, resend the same payment_signature.";

const cautionIfSigned = (
	signed: boolean,
	settled: ReturnType<typeof settledRefusal>,
): { payment_note?: string } =>
	signed && !("payment_settled" in settled) ? { payment_note: UNSETTLED_SIGNATURE_CAUTION } : {};

/** A one-line fix the backend sent next to its refusal code, or null. */
export const fixOf = (body: unknown): string | null => {
	const f = (body as Record<string, unknown> | null)?.fix;
	return typeof f === "string" && f.length > 0 && f.length <= 200 && !/[\r\n]/.test(f) ? f : null;
};

/**
 * The backend 402's `sign-in-with-x` extension (x402 SIWX): how an agent
 * proves its wallet to claim the free calls. Relayed field by field, each
 * bounded; anything off-shape relays as null rather than as caller-visible
 * garbage.
 */
export const relaySiwx = (body: unknown) => {
	const ext = ((body as Record<string, unknown> | null)?.extensions ?? null) as Record<string, unknown> | null;
	const x = (ext?.["sign-in-with-x"] ?? null) as Record<string, unknown> | null;
	if (!x || typeof x !== "object") return null;
	const info = (x.info ?? {}) as Record<string, unknown>;
	const s300 = (v: unknown) => (typeof v === "string" && v.length <= 300 && !/[\r\n]/.test(v) ? v : null);
	const chains = Array.isArray(x.supportedChains) ? x.supportedChains : [];
	return {
		header: x.header === "SIGN-IN-WITH-X" ? "SIGN-IN-WITH-X" : null,
		domain: s300(info.domain),
		uri: s300(info.uri),
		version: s300(info.version),
		nonce: s300(info.nonce),
		issued_at: s300(info.issuedAt),
		statement: s300(info.statement),
		supported_chains: chains
			.map((c) => c as Record<string, unknown>)
			.filter((c) => typeof c.chainId === "string" && /^eip155:[0-9]{1,16}$/.test(c.chainId) && c.type === "eip191")
			.map((c) => ({ chain_id: c.chainId as string, type: "eip191" as const })),
	};
};

/** The first x402 v2 `accepts` entry of a 402 body, field names kept. */
const relayAccepts = (body: unknown) => {
	const b = (body ?? {}) as Record<string, unknown>;
	const first = (Array.isArray(b.accepts) ? b.accepts[0] : null) as
		| Record<string, unknown>
		| null;
	if (!first) return null;
	return {
		scheme: str(first.scheme),
		network: str(first.network),
		amount: str(first.amount),
		asset: str(first.asset),
		pay_to: str(first.payTo),
		max_timeout_seconds: Number(first.maxTimeoutSeconds ?? 0),
	};
};

export const registerDataProductTools = (server: McpServer): void => {
	if (config.dataProductsDisabled) return;

	server.registerTool(
		"data_products_catalog",
		{
			title: "Commertize per-call data products",
			description:
				"List the data products Commertize sells per call over x402, each with one constant price in atomic USDC units, a number of free calls per day, and daily spending caps. The price is the same for every caller. A product with no cap is not listed. No credential needed.",
			inputSchema: {},
			outputSchema: {
				...envelopeShape,
				products: z
					.array(
						z.object({
							id: z.string(),
							name: z.string(),
							description: z.string(),
							payment: z.string(),
							price_atomic: z.string(),
							free_calls_per_day: z.number(),
							free_calls_per_wallet_per_day: z.number(),
							cap_per_payer_per_day_atomic: z.string(),
							cap_global_per_day_atomic: z.string(),
							network: z.string(),
							pay_to: z.string(),
						}),
					)
					.nullable(),
				note: z.string().nullable(),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async () => {
			const path = "/api/agent-data/products";
			const empty = { products: null, note: null };
			try {
				const res = await getRaw(path);
				if (res.status !== 200 || res.body === null) {
					return envelope(res.sourceUrl, {
						...empty,
						note: "This deployment does not offer per-call data products.",
					});
				}
				const b = res.body as Record<string, unknown>;
				const list = Array.isArray(b.products) ? b.products : [];
				return envelope(res.sourceUrl, {
					note: null,
					products: list.map((raw) => {
						const p = raw as Record<string, unknown>;
						return {
							id: String(p.id ?? ""),
							name: String(p.name ?? ""),
							description: String(p.description ?? ""),
							payment: String(p.payment ?? ""),
							price_atomic: String(p.price_atomic ?? ""),
							free_calls_per_day: Number(p.free_calls_per_day ?? 0),
							free_calls_per_wallet_per_day: Number(p.free_calls_per_wallet_per_day ?? 0),
							cap_per_payer_per_day_atomic: String(
								p.cap_per_payer_per_day_atomic ?? "",
							),
							cap_global_per_day_atomic: String(
								p.cap_global_per_day_atomic ?? "",
							),
							network: String(p.network ?? ""),
							pay_to: String(p.pay_to ?? ""),
						};
					}),
				});
			} catch (err) {
				return fail(err, `${config.apiBaseUrl}${path}`, empty);
			}
		},
	);

	server.registerTool(
		"get_supplier_profile",
		{
			title: "Supplier screen status (dated)",
			description:
				"For one compute supplier, return the sanctions-screen status of each party Commertize has screened, with the date of each screen, the list version and the date the status expires. An expired or missing screen reads as not_screened. It is not a score, a rating or an approval, and it does not mean the supplier's supply chain has been screened. The first calls each day are free; after that the backend answers with x402 payment requirements. To pay, sign them with your own wallet and pass the encoded payment as payment_signature. This server never signs.",
			inputSchema: {
				supplier_id: z
					.string()
					.regex(/^[A-Za-z0-9-]{1,64}$/)
					.describe("The supplier id."),
				payment_signature: z
					.string()
					.max(8192)
					.optional()
					.describe(
						"Optional. An x402 v2 PAYMENT-SIGNATURE value you signed yourself; forwarded unchanged.",
					),
				wallet_proof: z
					.string()
					.max(4096)
					.optional()
					.describe(
						"Optional. A SIGN-IN-WITH-X value you signed yourself, to use your wallet's free calls; forwarded unchanged.",
					),
			},
			outputSchema: {
				...envelopeShape,
				status: z.enum([
					"delivered",
					"payment_required",
					"pending",
					"not_found",
					"refused",
					// The payment moved and a refund is queued: do not pay again.
					"refund_queued",
					"daily_cap",
					"rate_limited",
					"unavailable",
				]),
				free: z.boolean().nullable(),
				profile: z.unknown().nullable(),
				receipt: z.unknown().nullable(),
				requirements: z
					.object({
						scheme: z.string().nullable(),
						network: z.string().nullable(),
						amount: z.string().nullable(),
						asset: z.string().nullable(),
						pay_to: z.string().nullable(),
						max_timeout_seconds: z.number(),
					})
					.nullable(),
				buyer_terms: z.unknown().nullable(),
				refusal_code: z.string().nullable(),
				/** The settlement tx the backend reported on a 202, else null. */
				transaction: z.string().nullable(),
				/**
				 * true when a refusal (403/409/503) is for a payment that already
				 * settled: it was not charged again. null = no claim either way.
				 */
				payment_settled: z.boolean().nullable(),
				/** The receipt's job_id when one was issued for that payment. */
				receipt_id: z.string().nullable(),
				payment_note: z.string().nullable(),
				/** How to claim this wallet's free calls (the 402's sign-in-with-x). */
				wallet_proof_challenge: z
					.object({
						header: z.string().nullable(),
						domain: z.string().nullable(),
						uri: z.string().nullable(),
						version: z.string().nullable(),
						nonce: z.string().nullable(),
						issued_at: z.string().nullable(),
						statement: z.string().nullable(),
						supported_chains: z.array(z.object({ chain_id: z.string(), type: z.string() })),
					})
					.nullable(),
				/** The backend's one-line next step for a refusal, relayed. */
				fix: z.string().nullable(),
			},
			annotations: {
				readOnlyHint: false,
				openWorldHint: true,
				idempotentHint: true,
			},
		},
		async ({ supplier_id, payment_signature, wallet_proof }) => {
			const path = `/api/agent-data/suppliers/${encodeURIComponent(supplier_id)}/screen`;
			const empty: {
				status: string;
				free: boolean | null;
				profile: unknown;
				receipt: unknown;
				requirements: ReturnType<typeof relayAccepts>;
				buyer_terms: unknown;
				refusal_code: string | null;
				transaction: string | null;
				payment_settled: boolean | null;
				receipt_id: string | null;
				payment_note: string | null;
				wallet_proof_challenge: ReturnType<typeof relaySiwx>;
				fix: string | null;
			} = {
				status: "unavailable",
				free: null,
				profile: null,
				receipt: null,
				requirements: null,
				buyer_terms: null,
				refusal_code: null,
				transaction: null,
				payment_settled: null,
				receipt_id: null,
				payment_note: null,
				wallet_proof_challenge: null,
				fix: null,
			};
			try {
				const res = await getRaw(path, {
					...(payment_signature ? { "PAYMENT-SIGNATURE": payment_signature } : {}),
					...(wallet_proof ? { "SIGN-IN-WITH-X": wallet_proof } : {}),
				});
				const b = (res.body ?? {}) as Record<string, unknown>;
				const out = (over: Partial<typeof empty> & { status: string }) =>
					envelope(res.sourceUrl, { ...empty, fix: fixOf(b), ...over });
				switch (res.status) {
					case 200:
						return out({
							status: "delivered",
							free: b.free === true,
							profile: b.output ?? null,
							receipt: b.receipt ?? null,
						});
					case 202:
						// Keep the on-chain reference (AEGIS mcp #12 L-2).
						return out({
							status: "pending",
							transaction: txHash(b.transaction),
						});
					case 402:
						return out({
							status: "payment_required",
							requirements: relayAccepts(b),
							wallet_proof_challenge: relaySiwx(b),
							buyer_terms: b.buyer_terms ?? null,
							refusal_code: str(b.error),
							...cautionIfSigned(!!payment_signature, {}),
						});
					case 403:
						return out({ status: "refused", refusal_code: str(b.error), ...settledRefusal(b) });
					case 404:
						return out({ status: "not_found" });
					case 409:
						// AEGIS mcp #12 L-1: a queued refund means money moved; a buyer
						// reading only `status` must not take it for "nothing charged".
						return out({
							status: b.error === "refund_queued" ? "refund_queued" : "refused",
							refusal_code: str(b.error),
							...settledRefusal(b),
						});
					case 429:
						return out({
							status: b.error === "daily_cap" ? "daily_cap" : "rate_limited",
							refusal_code: str(b.error),
						});
					default:
						// The backend's code is relayed (e.g. output_drift: a paid
						// replay that no longer matches its receipt, never re-charged).
						{
							const settled = settledRefusal(b);
							return out({
								status: "unavailable",
								refusal_code: str(b.error),
								...cautionIfSigned(!!payment_signature, settled),
								...settled,
							});
						}
				}
			} catch (err) {
				// A transport failure after the signature left this process is
				// the same unknown: the backend may have settled it.
				return fail(err, `${config.apiBaseUrl}${path}`, {
					...empty,
					...cautionIfSigned(!!payment_signature, {}),
				});
			}
		},
	);
};
