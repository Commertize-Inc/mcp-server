/**
 * Product analytics for the hosted public endpoint (`/mcp/public`), to
 * PostHog. OFF unless BOTH `COMMERTIZE_MCP_ANALYTICS=1` and a PostHog project
 * key (`phc_…`) are set.
 *
 * Scope, stated so nobody over-reads it:
 *   - HTTP public surface only. The stdio server runs on a user's own machine
 *     and never phones home; this module is not imported by index.ts.
 *   - One event, `mcp_tool_call`, built from an EXPLICIT allowlist of
 *     properties: tool, transport, outcome, error_code, http_status,
 *     latency_ms, client_name, client_version, server_version. Nothing else
 *     from the log event can reach PostHog, whatever a future log adds.
 *   - Anonymous: one constant distinct_id, no person profile, GeoIP off.
 *     Never a key, key id, IP, raw User-Agent, argument or result.
 *   - Best effort: a send that fails or exceeds its timeout is dropped and
 *     never fails, slows or changes the request it describes (it runs after
 *     the response is written).
 */

import type { HttpLogEvent } from "./httpServer.js";

export const ANALYTICS_EVENT = "mcp_tool_call";
export const ANALYTICS_DISTINCT_ID = "commertize-mcp-server";

const KEY_RE = /^phc_[A-Za-z0-9]{20,64}$/;

export interface AnalyticsConfig {
	enabled: boolean;
	apiKey: string;
	host: string;
	timeoutMs: number;
	serverVersion: string;
}

/** Fail-closed parse: anything short of an exact opt-in and a well-formed key is off. */
export const analyticsConfigFrom = (
	env: Record<string, string | undefined>,
	serverVersion: string
): AnalyticsConfig => {
	const apiKey = (env.COMMERTIZE_MCP_POSTHOG_KEY ?? "").trim();
	const rawHost = (env.COMMERTIZE_MCP_POSTHOG_HOST ?? "https://us.i.posthog.com").trim();
	let host = "";
	try {
		const u = new URL(rawHost);
		if (u.protocol === "https:" && !u.username && !u.password) host = u.origin;
	} catch {
		host = "";
	}
	return {
		enabled: env.COMMERTIZE_MCP_ANALYTICS === "1" && KEY_RE.test(apiKey) && host !== "",
		apiKey,
		host,
		timeoutMs: 1_500,
		serverVersion,
	};
};

const TOKEN = /^[A-Za-z0-9._-]{1,40}$/;
const VERSION = /^[A-Za-z0-9._+-]{1,20}$/;

/** First User-Agent product token only ("claude-code/1.2.3 (...)" -> name, version). */
export const uaProductOf = (ua: unknown): { name: string; version: string | null } => {
	if (typeof ua !== "string") return { name: "unknown", version: null };
	const first = ua.trim().split(/\s+/)[0] ?? "";
	const [name = "", version] = first.split("/");
	if (!TOKEN.test(name)) return { name: "unknown", version: null };
	return { name, version: version && VERSION.test(version) ? version : null };
};

/** Map one public log event to a capture body, or null if it is not a tool call. */
export const toCapture = (
	e: HttpLogEvent,
	cfg: Pick<AnalyticsConfig, "apiKey" | "serverVersion">
): Record<string, unknown> | null => {
	if (e.event !== "public_request") return null;
	if (typeof e.tool !== "string" || e.tool === "") return null;
	const str = (v: unknown) => (typeof v === "string" ? v : null);
	const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
	return {
		api_key: cfg.apiKey,
		event: ANALYTICS_EVENT,
		distinct_id: ANALYTICS_DISTINCT_ID,
		timestamp: str(e.ts),
		properties: {
			tool: e.tool,
			transport: "http_public",
			outcome: str(e.outcome),
			error_code: str(e.error_code),
			http_status: num(e.status),
			latency_ms: num(e.ms),
			client_name: str(e.client_name) ?? "unknown",
			client_version: str(e.client_version),
			server_version: cfg.serverVersion,
			$process_person_profile: false,
			$geoip_disable: true,
		},
	};
};

export type FetchLike = (url: string, init: RequestInit) => Promise<{ ok: boolean }>;

/**
 * Returns an async sink, or null when analytics is off. The handler awaits it
 * AFTER the response is written, so a slow PostHog never delays a client.
 */
export const createAnalyticsSink = (
	cfg: AnalyticsConfig,
	fetchImpl: FetchLike = fetch as unknown as FetchLike
): ((e: HttpLogEvent) => Promise<void>) | null => {
	if (!cfg.enabled) return null;
	const url = `${cfg.host}/i/v0/e/`;
	return async (e) => {
		const body = toCapture(e, cfg);
		if (!body) return;
		try {
			await fetchImpl(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(cfg.timeoutMs),
			});
		} catch {
			/* best effort: dropped, never thrown */
		}
	};
};
