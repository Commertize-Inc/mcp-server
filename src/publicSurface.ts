/**
 * The NO-LOGIN public surface: `POST /mcp/public`.
 *
 * A separate endpoint from the keyed `/mcp` (which stays exactly as audited
 * 2026-10-06). It serves ONLY the tools that return real data today with no
 * credential and no gate: published news, one article, and the bundled
 * platform reference text. Never an offering, sponsor, listing, reserve,
 * inquiry, memo, disclosure, sandbox or paid-data tool.
 *
 * The scorecard tool joins this list only after its strings are certified and
 * its backend route is deployed (FORGE handoff
 * forge-axiom-agent-adoption-mcp-contracts-2026-10-15 §1). Adding a name here
 * is a reviewed change, like `httpAllowlist.ts`.
 *
 * Every response on this surface carries the certified directory disclaimer
 * below in place of the server-wide one (RUNE 2026-10-15, AXIOM set D).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const PUBLIC_TOOL_NAMES = ["get_news", "get_article", "platform_info"] as const;

export const PUBLIC_TOOL_SET: ReadonlySet<string> = new Set<string>(PUBLIC_TOOL_NAMES);

export const isPublicTool = (name: unknown): name is string =>
	typeof name === "string" && PUBLIC_TOOL_SET.has(name);

/** AXIOM-certified, byte-exact. Id = apx- + sha1(UTF-8 bytes)[:10]. */
export const PUBLIC_DISCLAIMER =
	"This listing is reference information. It is not an offer to sell or a solicitation of an offer to buy any security.";
export const PUBLIC_DISCLAIMER_ID = "apx-92c1f4514d";

/**
 * Replace the envelope's `disclaimer` with the public one, and re-render the
 * text content from the same object so the two never disagree.
 *
 * Fail closed: a result with no structured envelope cannot carry the
 * disclaimer, so it is replaced by an error result that does.
 */
export const withPublicDisclaimer = (r: CallToolResult): CallToolResult => {
	const s = r.structuredContent;
	if (!s || typeof s !== "object" || !("disclaimer" in s)) {
		const structured = {
			as_of: new Date().toISOString(),
			disclaimer: PUBLIC_DISCLAIMER,
			error: { code: "INTERNAL_ERROR", message: "Internal error", retryable: false },
		};
		return {
			content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
			structuredContent: structured,
			isError: true,
		};
	}
	const structured = { ...s, disclaimer: PUBLIC_DISCLAIMER };
	return {
		...r,
		content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
		structuredContent: structured,
	};
};

/**
 * `clientInfo.name` from an `initialize` request, reduced to a short token so
 * the log carries a client family and nothing a caller could use to smuggle
 * data in: [A-Za-z0-9._-], at most 40 characters, else "unknown".
 */
export const clientNameOf = (raw: unknown): string => {
	if (typeof raw !== "string") return "unknown";
	const t = raw.trim();
	return /^[A-Za-z0-9._-]{1,40}$/.test(t) ? t : "unknown";
};

/** `clientInfo.version`, same idea: [A-Za-z0-9._+-], at most 20, else null. */
export const clientVersionOf = (raw: unknown): string | null => {
	if (typeof raw !== "string") return null;
	const t = raw.trim();
	return /^[A-Za-z0-9._+-]{1,20}$/.test(t) ? t : null;
};
