/**
 * OmniGrid per-call data tools (backend /api/omnigrid/v1, x402 v2), the
 * agent surface for ATLAS A2 (interconnection queue) and A1 (site
 * feasibility). Tool names per DELTA PLAN 2026-10-20 §2:
 *
 *   omnigrid_interconnection_queue   lookup (0.10 USDC) or, with
 *                                    region_snapshot, one ISO's totals (1.00)
 *   omnigrid_site_feasibility        basic (0.50) or, with radius_km, 2.00
 *
 * Same rules as dataProductTools.ts: THIS SERVER NEVER SIGNS AND NEVER HOLDS
 * A KEY; payment_signature is forwarded verbatim as PAYMENT-SIGNATURE; no
 * input names a payee; every backend answer is relayed as itself. The
 * backend offers no free calls on these products, so there is no wallet
 * proof input.
 *
 * Query building: only known fields, each validated here, sorted and
 * URL-encoded exactly as the backend's canonicalQuery does, so the relay
 * identity scope (og:<product>:<query>) matches the one the backend checks.
 *
 * COPY: titles and descriptions are DRAFT, AXIOM-pending (handoff
 * forge-axiom-omnigrid-strings-2026-10-20). DELTA's draft said "published
 * headroom" and "likelihood band"; both are removed (ATLAS: substation
 * capacity is CEII and never claimed; no forecast is computed).
 *
 * NOT REGISTERED unless COMMERTIZE_MCP_ENABLE_OMNIGRID=1 AND the data
 * products gate is open (registered from registerDataProductTools).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { config } from "./config.js";
import { envelopeShape } from "./schemas.js";
import { fail } from "./envelope.js";
import { getRaw } from "./http.js";
import { relayIdentityHeaders } from "./relayIdentity.js";
import {
	cautionIfSigned,
	envelope,
	fixOf,
	relayAccepts,
	settledRefusal,
	txHash,
} from "./dataProductTools.js";

export const OMNIGRID_TOOL_NAMES = [
	"omnigrid_interconnection_queue",
	"omnigrid_site_feasibility",
] as const;

const ISOS = ["CAISO", "ERCOT", "ISONE", "MISO", "NYISO", "PJM", "SPP"] as const;

/** The backend's canonicalQuery: sorted keys, both sides URL-encoded. */
export const canonical = (q: Record<string, string | undefined>): string =>
	Object.keys(q)
		.filter((k) => q[k] !== undefined)
		.sort()
		.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(q[k] as string)}`)
		.join("&");

const num = (n: number | undefined): string | undefined =>
	n === undefined ? undefined : String(n);

const STATUSES = [
	"delivered",
	"payment_required",
	"pending",
	"bad_input",
	"not_found",
	"refused",
	"refund_queued",
	"daily_cap",
	"rate_limited",
	"unavailable",
] as const;

const outputShape = {
	...envelopeShape,
	status: z.enum(STATUSES),
	data: z.unknown().nullable(),
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
	terms_url: z.string().nullable(),
	refusal_code: z.string().nullable(),
	field: z.string().nullable(),
	reason: z.string().nullable(),
	transaction: z.string().nullable(),
	payment_settled: z.boolean().nullable(),
	receipt_id: z.string().nullable(),
	payment_note: z.string().nullable(),
	fix: z.string().nullable(),
};

const s200 = (v: unknown, max = 300): string | null =>
	typeof v === "string" && v.length <= max && !/[\r\n]/.test(v) ? v : null;

/** Only a commertize.com terms link is relayed. */
const termsOf = (b: Record<string, unknown>): string | null => {
	const t = s200(b.terms_url);
	return t && /^https:\/\/commertize\.com\/omnigrid\//.test(t) ? t : null;
};

/** GET one paid OmniGrid path and relay the backend's answer as itself. */
const relayPaid = async (path: string, scope: string, payment_signature?: string) => {
	const empty = {
		status: "unavailable" as string,
		data: null as unknown,
		receipt: null as unknown,
		requirements: null as ReturnType<typeof relayAccepts>,
		buyer_terms: null as unknown,
		terms_url: null as string | null,
		refusal_code: null as string | null,
		field: null as string | null,
		reason: null as string | null,
		transaction: null as string | null,
		payment_settled: null as boolean | null,
		receipt_id: null as string | null,
		payment_note: null as string | null,
		fix: null as string | null,
	};
	try {
		const res = await getRaw(path, {
			...relayIdentityHeaders(scope),
			...(payment_signature ? { "PAYMENT-SIGNATURE": payment_signature } : {}),
		});
		const b = (res.body ?? {}) as Record<string, unknown>;
		const code = s200(b.error, 64);
		const out = (over: Partial<typeof empty> & { status: string }) =>
			envelope(res.sourceUrl, { ...empty, fix: fixOf(b), terms_url: termsOf(b), ...over });
		switch (res.status) {
			case 200:
				return out({ status: "delivered", data: b.output ?? null, receipt: b.receipt ?? null });
			case 202:
				return out({ status: "pending", transaction: txHash(b.transaction) });
			case 400:
				return out({ status: "bad_input", refusal_code: code, field: s200(b.field, 40) });
			case 402:
				return out({
					status: "payment_required",
					requirements: relayAccepts(b),
					buyer_terms: b.buyer_terms ?? null,
					refusal_code: code,
					...cautionIfSigned(!!payment_signature, {}),
				});
			case 403:
				return out({ status: "refused", refusal_code: code, ...settledRefusal(b) });
			case 404:
				return out({ status: "not_found" });
			case 409:
				return out({
					status: b.error === "refund_queued" ? "refund_queued" : "refused",
					refusal_code: code,
					...settledRefusal(b),
				});
			case 429:
				return out({ status: b.error === "daily_cap" ? "daily_cap" : "rate_limited", refusal_code: code });
			default: {
				const settled = settledRefusal(b);
				return out({
					status: "unavailable",
					refusal_code: code,
					reason: s200(b.reason, 64),
					...cautionIfSigned(!!payment_signature, settled),
					...settled,
				});
			}
		}
	} catch (err) {
		return fail(err, `${config.apiBaseUrl}${path}`, {
			...empty,
			...cautionIfSigned(!!payment_signature, {}),
		});
	}
};

// Second opinion #16: an x402 v2 PAYMENT-SIGNATURE is base64(JSON); any
// other byte (CR/LF, spaces, header syntax) is refused before it is forwarded.
const PAYMENT = z
	.string()
	.max(8192)
	.regex(/^[A-Za-z0-9+/_-]+={0,2}$/)
	.optional()
	.describe("Optional. An x402 v2 PAYMENT-SIGNATURE value you signed yourself; forwarded unchanged.");

export const registerOmnigridTools = (server: McpServer): void => {
	if (config.omnigridDisabled || config.dataProductsDisabled) return;

	server.registerTool(
		"omnigrid_interconnection_queue",
		{
			title: "Interconnection queue filings (US ISOs)",
			description:
				"Use when you need interconnection queue filings across US ISOs. Input: an ISO, a state or a project id, with an optional MW range; or region_snapshot with an ISO for that ISO's totals. Returns normalized public queue filings (for region_snapshot: totals by state, fuel and filed in-service year) with each source and as-of date. An ISO that cannot be served is named as unavailable, never shown as zero. A record of filings, not a forecast. Paid per call with x402: sign the returned requirements with your own wallet and pass the encoded payment as payment_signature. This server never signs.",
			inputSchema: {
				iso: z.enum(ISOS).optional().describe("ISO or RTO."),
				state: z.string().regex(/^[A-Za-z]{2}$/).optional().describe("Two-letter US state."),
				mw_min: z.number().min(0).max(20000).optional(),
				mw_max: z.number().min(0).max(20000).optional(),
				project_id: z.string().regex(/^[A-Za-z0-9 ._\-/]{1,40}$/).optional().describe("Queue id; needs iso."),
				status: z.enum(["pending", "all"]).optional(),
				region_snapshot: z.boolean().optional().describe("Return one ISO's totals instead of filings (needs iso, nothing else)."),
				payment_signature: PAYMENT,
			},
			outputSchema: outputShape,
			annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
		},
		async (a) => {
			if (a.region_snapshot) {
				if (!a.iso) return envelope("", { ...emptyBad("iso") });
				// AEGIS r2 L-1: any other filter is refused, never dropped into a
				// 1.00 USDC ISO-totals purchase the caller did not ask for.
				for (const k of ["state", "mw_min", "mw_max", "project_id", "status"] as const)
					if (a[k] !== undefined) return envelope("", { ...emptyBad(k) });
				const query = canonical({ iso: a.iso });
				return relayPaid(`/api/omnigrid/v1/interconnection-queue/region?${query}`, `og:OG-R1:${query}`, a.payment_signature);
			}
			const query = canonical({
				iso: a.iso,
				state: a.state,
				mw_min: num(a.mw_min),
				mw_max: num(a.mw_max),
				project_id: a.project_id,
				status: a.status,
			});
			return relayPaid(`/api/omnigrid/v1/interconnection-queue?${query}`, `og:OG-Q1:${query}`, a.payment_signature);
		},
	);

	server.registerTool(
		"omnigrid_site_feasibility",
		{
			title: "Site screening data (US)",
			description:
				"Use when you need public screening data for a US site for a data center or compute load. Returns, for a point in the US, its county and the pending public interconnection queue filings in that county, or in counties within a radius, with each field's source and status. Substation capacity, transmission, fiber and zoning are reported as not available. Screening data, not an engineering, interconnection or site study, and not a statement that the site can be powered. Paid per call with x402 (radius search costs more): sign the returned requirements with your own wallet and pass the encoded payment as payment_signature. This server never signs.",
			inputSchema: {
				lat: z.number().min(18).max(72),
				lon: z.number().min(-180).max(-66),
				target_mw: z.number().positive().max(5000).optional(),
				radius_km: z.number().min(1).max(50).optional(),
				payment_signature: PAYMENT,
			},
			outputSchema: outputShape,
			annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
		},
		async (a) => {
			const query = canonical({
				lat: String(a.lat),
				lon: String(a.lon),
				target_mw: num(a.target_mw),
				radius_km: num(a.radius_km),
			});
			const product = a.radius_km === undefined ? "OG-S1" : "OG-S2";
			return relayPaid(`/api/omnigrid/v1/site-feasibility?${query}`, `og:${product}:${query}`, a.payment_signature);
		},
	);
};

const emptyBad = (field: string) => ({
	status: "bad_input",
	data: null,
	receipt: null,
	requirements: null,
	buyer_terms: null,
	terms_url: null,
	refusal_code: "bad_input",
	field,
	reason: null,
	transaction: null,
	payment_settled: null,
	receipt_id: null,
	payment_note: null,
	fix: null,
});
