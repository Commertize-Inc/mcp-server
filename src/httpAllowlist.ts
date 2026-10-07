/**
 * The HTTP surface, by name.
 *
 * Over the Streamable HTTP transport this server is reachable from anywhere
 * with a key, so the surface is the narrowest one the product offers:
 * the public reads, plus the one write that reaches a person (a sponsor
 * inquiry filed on a principal's behalf). Everything else — the memo request,
 * the simulation venue, the paid-data rail — stays stdio-only until each has
 * its own review.
 *
 * Two readers enforce this set, on purpose:
 *   1. `index.ts` registers only these names when building an HTTP server, so
 *      `tools/list` cannot advertise anything else;
 *   2. `httpServer.ts` refuses any `tools/call` whose name is not here with
 *      HTTP 403 BEFORE the request reaches the MCP server — so a future
 *      registration mistake is still a refusal, not a call.
 * A name is added here only together with its own review.
 */

import { INQUIRY_TOOL_NAME } from "./inquiryTool.js";

export const HTTP_READ_TOOL_NAMES = [
	"list_offerings",
	"get_offering",
	"get_disclosure_package",
	"get_news",
	"get_article",
	"platform_info",
	"search_offerings",
	"compare_offerings",
	"list_sponsors",
	"get_sponsor",
] as const;

/** Writes allowed over HTTP. Each one is rate-limited per key on its own. */
export const HTTP_INQUIRY_TOOL_NAMES = [INQUIRY_TOOL_NAME] as const;

export const HTTP_TOOL_ALLOWLIST: ReadonlySet<string> = new Set<string>([
	...HTTP_READ_TOOL_NAMES,
	...HTTP_INQUIRY_TOOL_NAMES,
]);

export const isAllowedOverHttp = (name: unknown): name is string =>
	typeof name === "string" && HTTP_TOOL_ALLOWLIST.has(name);

export const isInquiryTool = (name: string): boolean =>
	(HTTP_INQUIRY_TOOL_NAMES as readonly string[]).includes(name);
