/**
 * The machine-readable disclaimer, `disclaimer_block` (legal review ruling
 * 2026-10-15 §7).
 *
 * Certified ONLY for the tools named in `DISCLAIMER_BLOCK_TOOLS`: each value
 * must be literally true of that tool's output. HARD LIMIT: never attach it to
 * a tool that returns offering data. Offering terms disseminated publicly
 * under 506(c) ARE an offer, so `is_offer: false` there would be a false
 * statement. The offering, sponsor, screener, inquiry, memo, disclosure,
 * sandbox and x402 tools never carry it; adding a name below is a reviewed
 * change that needs a new ruling.
 *
 * `text_id` names the prose disclaimer the same response carries. It is looked
 * up from the response's own `disclaimer` field, never assumed, so the two
 * cannot disagree. A disclaimer with no certified id fails closed (the result
 * is replaced by an error that carries D-1 and its block).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { DISCLAIMER, DISCLAIMER_ID } from "./disclaimer.js";

export const DISCLAIMER_BLOCK_TOOLS: ReadonlySet<string> = new Set<string>([
	"get_news",
	"get_article",
	"platform_info",
]);

/** Certified prose disclaimers and their ids. */
const TEXT_IDS: ReadonlyMap<string, string> = new Map([[DISCLAIMER, DISCLAIMER_ID]]);

export const disclaimerBlockFor = (textId: string) => ({
	schema: "commertize.disclaimer/1" as const,
	text_id: textId,
	informational_only: true as const,
	is_offer: false as const,
	is_solicitation: false as const,
	is_recommendation: false as const,
	is_advice: false as const,
	confers_authority_to_transact: false as const,
});

/** Output-schema entry. No `.describe()`: a description is copy, and none is certified. */
export const disclaimerBlockSchema = z.object({
	schema: z.literal("commertize.disclaimer/1"),
	text_id: z.string(),
	informational_only: z.literal(true),
	is_offer: z.literal(false),
	is_solicitation: z.literal(false),
	is_recommendation: z.literal(false),
	is_advice: z.literal(false),
	confers_authority_to_transact: z.literal(false),
});

const render = (structured: Record<string, unknown>, base: CallToolResult): CallToolResult => ({
	...base,
	content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
	structuredContent: structured,
});

export const withDisclaimerBlock = (r: CallToolResult): CallToolResult => {
	const s = r.structuredContent as Record<string, unknown> | undefined;
	const textId =
		s && typeof s === "object" && typeof s.disclaimer === "string"
			? TEXT_IDS.get(s.disclaimer)
			: undefined;
	if (!s || !textId) {
		return render(
			{
				as_of: new Date().toISOString(),
				disclaimer: DISCLAIMER,
				disclaimer_block: disclaimerBlockFor(DISCLAIMER_ID),
				error: { code: "INTERNAL_ERROR", message: "Internal error", retryable: false },
			},
			{ content: [], isError: true }
		);
	}
	return render({ ...s, disclaimer_block: disclaimerBlockFor(textId) }, r);
};
