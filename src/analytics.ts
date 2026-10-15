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

/**
 * T5-S1, the user-facing disclosure, AXIOM-certified apx-00aee28eb6 (ruling
 * 2026-10-15 §8). It describes what `toCapture` sends, field for field. It
 * goes into the README in the SAME change that sets COMMERTIZE_MCP_ANALYTICS=1
 * in production, never before: a README stating that the hosted endpoint
 * sends metrics while the flag is off would describe a feature we do not run.
 * analytics-e2e pins this text by id and pins that every field it names is a
 * key of the capture.
 */
export const ANALYTICS_DISCLOSURE =
	"The hosted endpoint sends anonymous usage metrics for each tool call to our analytics " +
	"provider: the tool name, the client application's name and version, the transport, the " +
	"outcome, any error code, the HTTP status, the response time and the server version. These " +
	"metrics do not include your key, your IP address, the arguments you send or the data returned.";
export const ANALYTICS_DISCLOSURE_ID = "apx-00aee28eb6";

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

/**
 * The ONLY client names that can leave for PostHog (AEGIS PR #5 F5-1).
 *
 * A User-Agent token or `clientInfo.name` is caller-chosen text: dots and
 * hyphens let a hostname, an org name or an email-equivalent through any
 * character-class sanitiser (PoC: "jane.doe.acme-corp.com"). The destination
 * is outside our trust boundary, so the client is reported as one of these
 * families, matched case-blind on the whole token or a "<family>-" prefix,
 * else "other". Adding a family is a reviewed change to this list.
 */
export const CLIENT_FAMILIES = [
	"claude-ai",
	"claude-code",
	"cursor",
	"vscode",
	"windsurf",
	"openai-mcp",
	"chatgpt",
	"mcp-inspector",
	"python-httpx",
	"node",
	"curl",
] as const;

export const clientFamilyOf = (raw: unknown): string => {
	if (typeof raw !== "string" || raw === "" || raw === "unknown") return "unknown";
	const t = raw.toLowerCase();
	return CLIENT_FAMILIES.find((f) => t === f || t.startsWith(`${f}-`)) ?? "other";
};

/** Numeric dotted version (at most four parts) for a known family; else null. */
const NUMERIC_VERSION = /^\d{1,6}(?:\.\d{1,6}){0,3}$/;
export const clientVersionFor = (family: string, raw: unknown): string | null =>
	family !== "other" && family !== "unknown" && typeof raw === "string" && NUMERIC_VERSION.test(raw)
		? raw
		: null;

/** Map one public log event to a capture body, or null if it is not a tool call. */
export const toCapture = (
	e: HttpLogEvent,
	cfg: Pick<AnalyticsConfig, "apiKey" | "serverVersion">
): Record<string, unknown> | null => {
	if (e.event !== "public_request") return null;
	if (typeof e.tool !== "string" || e.tool === "") return null;
	const str = (v: unknown) => (typeof v === "string" ? v : null);
	const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
	const family = clientFamilyOf(e.client_name);
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
			client_name: family,
			client_version: clientVersionFor(family, e.client_version),
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
