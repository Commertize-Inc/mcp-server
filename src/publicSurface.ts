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
 * Every response on this surface carries D-1 (AXIOM ruling 2026-10-15 §3),
 * enforced by `withPublicDisclaimer` on every result, error included. The
 * directory text apx-92c1f4514d ("This listing is reference information…")
 * is for directory listing fields and README line 5 only: on a tool response
 * "listing" reads as an offering listing, so it never appears here.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { config } from "./config.js";
import { DISCLAIMER, DISCLAIMER_ID } from "./disclaimer.js";
import { withDisclaimerBlock } from "./disclaimerBlock.js";

export const PUBLIC_TOOL_NAMES = ["get_news", "get_article", "platform_info"] as const;

export const PUBLIC_TOOL_SET: ReadonlySet<string> = new Set<string>(PUBLIC_TOOL_NAMES);

export const isPublicTool = (name: unknown): name is string =>
	typeof name === "string" && PUBLIC_TOOL_SET.has(name);

/** D-1, the same constant as the server-wide DISCLAIMER (AXIOM §3). */
export const PUBLIC_DISCLAIMER = DISCLAIMER;
export const PUBLIC_DISCLAIMER_ID = DISCLAIMER_ID;

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
 * SDK-built tool errors on the public surface (AEGIS PR #4 F4-2).
 *
 * The SDK validates arguments BEFORE the registered callback runs, and on
 * failure returns its own `{content:[text], isError:true}` with no envelope,
 * so `withPublicDisclaimer` never sees it (PoC: get_article with no slug,
 * get_news with limit 1000). Here `McpServer.createToolError` is replaced on
 * the PUBLIC instance only, so those results carry the same envelope, D-1 and
 * the disclaimer_block. Every tool a public request can reach is one of
 * PUBLIC_TOOL_NAMES (anything else is 403 before dispatch), and all three are
 * certified for the block. The keyed and stdio surfaces keep the SDK's
 * protocol-error shape, which gates-e2e pins on purpose.
 *
 * `createToolError` is private in the SDK's types. public-e2e asserts the
 * envelope on a real validation error, so an SDK change that renamed it would
 * fail the suite rather than silently drop the disclaimer.
 */
export const publicToolError = (message: string): CallToolResult => {
	const structured = {
		as_of: new Date().toISOString(),
		source_url: config.apiBaseUrl,
		cache: { hit: false, age_seconds: 0, stale: false },
		disclaimer: PUBLIC_DISCLAIMER,
		error: {
			code: /Input validation error/.test(message) ? "INVALID_ARGUMENT" : "INTERNAL_ERROR",
			message,
			retryable: false,
		},
	};
	return withDisclaimerBlock({
		content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
		structuredContent: structured,
		isError: true,
	});
};

export const envelopeSdkToolErrors = (server: McpServer): void => {
	(server as unknown as { createToolError: (m: string) => CallToolResult }).createToolError =
		publicToolError;
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
