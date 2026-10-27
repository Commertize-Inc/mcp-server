/**
 * Platform read tools: the reference index, the latest Intelligence issue
 * and the Work board.
 *
 * Three thin, read-only relays over public-API GET routes. No credential is
 * sent and none is read, so the shared URL-keyed cache in `http.ts` is safe
 * to use here (it is NOT safe for anything that carries a key; see
 * `getJsonAs`).
 *
 * Two things every response carries, on success and on refusal:
 *
 *  - `api_captions`: the caption strings the API put in its own response
 *    (`disclosure`, `caption`, `notice`, `strings_ref`, ...), copied
 *    verbatim. This server never writes or rewrites that wording; it only
 *    makes sure it travels with the data.
 *  - `deployment`: whether the route is actually served by the API this
 *    server points at. Built is not deployed: a route that exists in the
 *    backend source but is not released answers 404, and this tool says
 *    `not_deployed` instead of passing that off as an outage.
 *
 * Registration is gated (`config.platformReadsDisabled`, default closed),
 * because on 2026-10-27 production answered 404 for all three routes.
 * A registry-installed client must not list tools that can only fail.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { config } from "./config.js";
import { fail, ok, refuse } from "./envelope.js";
import { ApiError, getJson } from "./http.js";
import { envelopeShape } from "./schemas.js";

export const PLATFORM_READ_TOOL_NAMES = [
	"get_reference_index",
	"get_intelligence_issue",
	"list_work_tasks",
] as const;

/** Top-level response keys whose string values are the API's own captions. */
export const CAPTION_KEYS = [
	"disclosure",
	"disclaimer",
	"caption",
	"captions",
	"notice",
	"strings_ref",
] as const;

export type DeploymentStatus = "deployed" | "not_deployed" | "restricted";

/**
 * Copy the API's caption strings verbatim. Only strings, and arrays of
 * strings joined with a newline, are copied: anything else is not a caption
 * and is dropped rather than coerced into one.
 */
export const extractCaptions = (body: unknown): Record<string, string> => {
	const out: Record<string, string> = {};
	if (!body || typeof body !== "object" || Array.isArray(body)) return out;
	const rec = body as Record<string, unknown>;
	for (const key of CAPTION_KEYS) {
		const v = rec[key];
		if (typeof v === "string" && v.length > 0) out[key] = v;
		else if (
			Array.isArray(v) &&
			v.length > 0 &&
			v.every((s) => typeof s === "string")
		)
			out[key] = (v as string[]).join("\n");
	}
	return out;
};

const deploymentShape = z
	.object({
		status: z
			.enum(["deployed", "not_deployed", "restricted"])
			.describe(
				"deployed: the API served this route. not_deployed: the API does not serve it yet (built is not deployed). restricted: the API requires a signed-in session this server does not hold.",
			),
		route: z.string().describe("The API path this tool reads."),
	})
	.describe("Whether the route is live on the API this server points at.");

const outputSchema = {
	...envelopeShape,
	data: z
		.unknown()
		.describe(
			"The API's response content for this route, unmodified. Null when the route was not served.",
		),
	api_captions: z
		.record(z.string(), z.string())
		.describe(
			"Caption strings from the API's own response, copied verbatim. Carry them with any use of the data.",
		),
	deployment: deploymentShape,
};

const empty = (route: string, status: DeploymentStatus) => ({
	data: null,
	api_captions: {},
	deployment: { status, route },
});

const NOT_DEPLOYED_MESSAGE =
	"This API does not serve the route yet: built is not deployed. Nothing was returned; retrying will not change this until the route is released.";
const RESTRICTED_MESSAGE =
	"This route requires a signed-in Commertize session, which this server does not hold. Nothing was returned.";

/**
 * One handler for all three tools. `pick` selects the response content; the
 * captions are read from the whole body, so a caption next to the content is
 * never lost.
 */
export const readRoute = async (
	route: string,
	pick: (body: Record<string, unknown>) => unknown,
): Promise<CallToolResult> => {
	const url = `${config.apiBaseUrl}${route}`;
	try {
		const res = await getJson<unknown>(route);
		const body = res.body;
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			return fail(
				new ApiError({
					code: "UPSTREAM_BAD_BODY",
					message: `Commertize API returned an unexpected body shape for ${url}`,
					retryable: true,
					status: null,
					sourceUrl: url,
				}),
				url,
				empty(route, "deployed"),
			);
		}
		const rec = body as Record<string, unknown>;
		return ok(res, {
			data: pick(rec) ?? null,
			api_captions: extractCaptions(rec),
			deployment: { status: "deployed", route },
		});
	} catch (err) {
		if (err instanceof ApiError && err.status === 404)
			return refuse(
				"NOT_DEPLOYED",
				NOT_DEPLOYED_MESSAGE,
				url,
				empty(route, "not_deployed"),
			);
		if (err instanceof ApiError && (err.status === 401 || err.status === 403))
			return refuse(
				"RESTRICTED",
				RESTRICTED_MESSAGE,
				url,
				empty(route, "restricted"),
			);
		// Any other failure says nothing about deployment; report what is known.
		return fail(err, url, empty(route, "deployed"));
	}
};

const ROUTES = {
	get_reference_index: "/api/intelligence/number",
	get_intelligence_issue: "/api/intelligence/state-weekly",
	list_work_tasks: "/api/work/v1/tasks",
} as const satisfies Record<(typeof PLATFORM_READ_TOOL_NAMES)[number], string>;

const annotations = { readOnlyHint: true, openWorldHint: true } as const;

/** Registers the three tools, or nothing when the gate is closed. */
export const registerPlatformTools = (server: McpServer): void => {
	if (config.platformReadsDisabled) return;

	server.registerTool(
		"get_reference_index",
		{
			title: "Commertize reference index",
			description:
				"The latest published Commertize reference index value and its as-of date, as the API serves it. Reference data only: it is not a price for any offering. Response carries the API's own captions and whether the route is deployed.",
			inputSchema: {},
			outputSchema,
			annotations,
		},
		async () => readRoute(ROUTES.get_reference_index, (b) => b.number),
	);

	server.registerTool(
		"get_intelligence_issue",
		{
			title: "Latest Commertize Intelligence issue",
			description:
				"Metadata for the newest published Commertize Intelligence issue: issue number, date, title and staleness, as the API serves it. Response carries the API's own captions and whether the route is deployed.",
			inputSchema: {},
			outputSchema,
			annotations,
		},
		async () => readRoute(ROUTES.get_intelligence_issue, (b) => b.issue),
	);

	server.registerTool(
		"list_work_tasks",
		{
			title: "Commertize Work task board",
			description:
				"The public Commertize Work board: open and closed tasks as the API serves them. Read only; claiming a task is not available through this server. Response carries the API's own captions and whether the route is deployed.",
			inputSchema: {},
			outputSchema,
			annotations,
		},
		// A body without a tasks array is passed on as null, never as an empty
		// board: "no tasks" and "the API sent no list" are different facts.
		async () =>
			readRoute(ROUTES.list_work_tasks, (b) =>
				Array.isArray(b.tasks) ? b.tasks : null,
			),
	);
};
