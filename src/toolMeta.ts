/**
 * One table of MCP tool annotations and pricing for EVERY tool this server
 * can register, on every surface (stdio, keyed /mcp, public /mcp/public).
 *
 * Why a table: directories (the Anthropic connector review, Smithery) read
 * `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint` on
 * each tool, and an agent deciding whether a call costs money needs to know
 * before it calls. INTEL competitive map 2026-10-20 section 8 found 0 tools
 * carried the full set.
 *
 * FAIL CLOSED. `applyToolMeta` wraps `server.registerTool`: a name with no
 * row here THROWS at registration, so a new tool cannot ship without a
 * reviewed row. An in-code `annotations` hint that disagrees with the row
 * also throws, so the two can never say different things.
 *
 * PRICING (`_meta["com.commertize/pricing"]`). `free` = no payment is ever
 * asked. `x402` = the call may answer with an x402 v2 payment challenge; the
 * authoritative price is the challenge itself (`accepts[].amount`, atomic
 * USDC), which the backend builds from its compile-time product table. No
 * price number is restated here, so this file cannot drift from what is
 * charged.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const PRICING_META_KEY = "com.commertize/pricing";

export type ToolPricing =
	| { model: "free" }
	| {
			model: "x402";
			/** x402 protocol version of the challenge. */
			x402_version: 2;
			scheme: "exact";
			asset: "USDC";
			/** Where the authoritative price is read. */
			price_source: "x402_challenge";
			/** True when some calls are free (per-wallet daily quota). */
			free_tier: boolean;
	  };

export interface ToolHints {
	readOnlyHint: boolean;
	destructiveHint: boolean;
	idempotentHint: boolean;
	openWorldHint: boolean;
}

export interface ToolMetaRow {
	hints: ToolHints;
	pricing: ToolPricing;
}

const READ_UPSTREAM: ToolHints = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
};
const READ_LOCAL: ToolHints = { ...READ_UPSTREAM, openWorldHint: false };
/** A write that creates a record on each call (inquiry, memo request, order). */
const WRITE_APPEND: ToolHints = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: true,
};
const FREE: ToolPricing = { model: "free" };
const X402 = (free_tier: boolean): ToolPricing => ({
	model: "x402",
	x402_version: 2,
	scheme: "exact",
	asset: "USDC",
	price_source: "x402_challenge",
	free_tier,
});

export const TOOL_META: Readonly<Record<string, ToolMetaRow>> = Object.freeze({
	// public three
	get_news: { hints: READ_UPSTREAM, pricing: FREE },
	get_article: { hints: READ_UPSTREAM, pricing: FREE },
	platform_info: { hints: READ_LOCAL, pricing: FREE },
	// keyed reads
	list_offerings: { hints: READ_UPSTREAM, pricing: FREE },
	get_offering: { hints: READ_UPSTREAM, pricing: FREE },
	get_disclosure_package: { hints: READ_UPSTREAM, pricing: FREE },
	search_offerings: { hints: READ_UPSTREAM, pricing: FREE },
	compare_offerings: { hints: READ_UPSTREAM, pricing: FREE },
	list_sponsors: { hints: READ_UPSTREAM, pricing: FREE },
	get_sponsor: { hints: READ_UPSTREAM, pricing: FREE },
	// writes
	file_sponsor_inquiry: { hints: WRITE_APPEND, pricing: FREE },
	request_memo: { hints: WRITE_APPEND, pricing: FREE },
	sandbox_enroll: { hints: { ...WRITE_APPEND, idempotentHint: true }, pricing: FREE },
	sandbox_universe: { hints: READ_UPSTREAM, pricing: FREE },
	sandbox_place_order: { hints: { ...WRITE_APPEND, idempotentHint: true }, pricing: FREE },
	sandbox_account: { hints: READ_UPSTREAM, pricing: FREE },
	// x402 rail (keyed / stdio only)
	x402_catalog: { hints: READ_UPSTREAM, pricing: FREE },
	x402_terms: { hints: READ_UPSTREAM, pricing: FREE },
	x402_quote: { hints: READ_UPSTREAM, pricing: FREE },
	// Not idempotent: a NEW signed authorization is a new payment.
	x402_fetch: { hints: WRITE_APPEND, pricing: X402(false) },
	x402_receipt: { hints: READ_UPSTREAM, pricing: FREE },
	// per-call data products (public while their gate is open)
	data_products_catalog: { hints: READ_UPSTREAM, pricing: FREE },
	// Idempotent: resending the SAME payment_signature replays one delivery.
	get_supplier_profile: { hints: { ...WRITE_APPEND, idempotentHint: true }, pricing: X402(true) },
	// OmniGrid (no free tier; same idempotency as get_supplier_profile)
	omnigrid_interconnection_queue: { hints: { ...WRITE_APPEND, idempotentHint: true }, pricing: X402(false) },
	omnigrid_site_feasibility: { hints: { ...WRITE_APPEND, idempotentHint: true }, pricing: X402(false) },
});

export class ToolMetaError extends Error {}

type RegisterCfg = { title?: string; annotations?: Record<string, unknown>; _meta?: Record<string, unknown> };

/**
 * Wrap `server.registerTool` so every registration carries the table's
 * annotations and pricing. Call BEFORE any tool is registered.
 */
export const applyToolMeta = (
	server: McpServer,
	table: Readonly<Record<string, ToolMetaRow>> = TOOL_META
): void => {
	const original = server.registerTool.bind(server) as (...a: unknown[]) => unknown;
	(server as unknown as { registerTool: (...a: unknown[]) => unknown }).registerTool = (
		name: unknown,
		cfg: unknown,
		cb: unknown
	) => {
		if (typeof name !== "string" || !Object.hasOwn(table, name)) {
			throw new ToolMetaError(`tool_meta_missing:${String(name)}`);
		}
		const row = table[name] as ToolMetaRow;
		const c = (cfg ?? {}) as RegisterCfg;
		const inCode = c.annotations ?? {};
		for (const k of Object.keys(row.hints) as (keyof ToolHints)[]) {
			if (k in inCode && inCode[k] !== row.hints[k]) {
				throw new ToolMetaError(`tool_meta_conflict:${name}:${k}`);
			}
		}
		const title = typeof inCode.title === "string" ? inCode.title : c.title;
		const merged = {
			...c,
			annotations: { ...inCode, ...(title ? { title } : {}), ...row.hints },
			_meta: { ...(c._meta ?? {}), [PRICING_META_KEY]: row.pricing },
		};
		return original(name, merged, cb);
	};
};
