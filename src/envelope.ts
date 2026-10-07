/**
 * The response envelope, as a shared module.
 *
 * ── Why this file exists, stated rather than implied ──────────────────────
 * `tools.ts` has carried private copies of `toResult` / `ok` / `fail` /
 * `disabled` since v0. They are correct; they are simply not importable, and a
 * second tool module cannot reuse them without either exporting them (a diff to
 * `tools.ts`) or copying them (a second definition of the one invariant the
 * envelope exists to make impossible to forget).
 *
 * The extraction is one-directional for now: new tool modules import from
 * here, `tools.ts` keeps its private copies, and a follow-up should delete
 * those copies and import this module. Until then the drift risk is
 * real and is guarded BEHAVIOURALLY, not by a comment: `test/screener-e2e.mjs`
 * asserts that a new tool's envelope key set is byte-identical to `get_news`'s.
 *
 * ── The invariant ─────────────────────────────────────────────────────────
 * Every response — success, failure, or gated — carries `as_of`, `source_url`,
 * `cache`, `disclaimer` and `error`. Failure envelopes keep every payload key
 * present (empty / null) so the declared output schema holds for errors too and
 * a client never has to special-case the shape.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { config } from "./config.js";
import { DISCLAIMER } from "./disclaimer.js";
import { ApiError, type ApiResult } from "./http.js";

/** Cache metadata for a response that did not come from the HTTP layer. */
const NO_FETCH_CACHE = { hit: false, age_seconds: 0, stale: false } as const;

export const toResult = (
	structured: Record<string, unknown>,
	isError = false
): CallToolResult => ({
	content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
	structuredContent: structured,
	...(isError ? { isError: true } : {}),
});

/** Success envelope built from the upstream fetch metadata. */
export const ok = <T extends Record<string, unknown>>(
	meta: Pick<ApiResult<unknown>, "fetchedAt" | "cache" | "sourceUrl">,
	payload: T
): CallToolResult =>
	toResult({
		...payload,
		as_of: meta.fetchedAt.toISOString(),
		source_url: meta.sourceUrl,
		cache: meta.cache,
		disclaimer: DISCLAIMER,
		error: null,
	});

/**
 * Failure envelope. `isError` is set, so a client that only reads the MCP
 * result flag still learns the call failed; the payload keys survive so the
 * output schema still validates.
 */
export const fail = (
	err: unknown,
	sourceUrl: string,
	emptyPayload: Record<string, unknown>
): CallToolResult => {
	const api = err instanceof ApiError ? err : null;
	return toResult(
		{
			...emptyPayload,
			as_of: new Date().toISOString(),
			source_url: api?.sourceUrl ?? sourceUrl,
			cache: NO_FETCH_CACHE,
			disclaimer: DISCLAIMER,
			error: {
				code: api?.code ?? "INTERNAL_ERROR",
				message: api
					? api.message
					: `Unexpected failure: ${err instanceof Error ? err.message : String(err)}`,
				retryable: api?.retryable ?? false,
			},
		},
		true
	);
};

/**
 * A handler-level refusal that is not an upstream fault: a bad argument, an
 * id that does not resolve, a tool held closed by its gate. Carries a
 * caller-supplied code so the vocabulary stays legible (`TOOL_DISABLED`,
 * `NOT_FOUND`, `INVALID_ARGUMENT`) instead of collapsing into INTERNAL_ERROR.
 */
export const refuse = (
	code: string,
	message: string,
	sourceUrl: string,
	emptyPayload: Record<string, unknown>
): CallToolResult =>
	toResult(
		{
			...emptyPayload,
			as_of: new Date().toISOString(),
			source_url: sourceUrl,
			cache: NO_FETCH_CACHE,
			disclaimer: DISCLAIMER,
			error: { code, message, retryable: false },
		},
		true
	);

/**
 * The offerings gate refusal.
 *
 * The wording deliberately does NOT restate which environment variable opens
 * the gate. `config.offeringsDisabled` is the single place that decides, and
 * a message that named the mechanism would go stale if that policy changed.
 * What an agent needs to know is stable: no listing data is coming, and the
 * reason is a policy decision, not a fault it should retry.
 */
export const OFFERING_GATE_MESSAGE =
	"Offering data is disabled on this server instance, so no offering, sponsor or " +
	"screening data will be " +
	"returned. This is a policy state, not an outage — retrying will not change it.";

export const offeringGateClosed = (
	emptyPayload: Record<string, unknown>
): CallToolResult =>
	refuse(
		"TOOL_DISABLED",
		OFFERING_GATE_MESSAGE,
		`${config.apiBaseUrl}/api/listings`,
		emptyPayload
	);
