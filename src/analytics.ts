/**
 * Product analytics for the hosted HTTP endpoints (`/mcp/public` and the
 * keyed `/mcp`), to PostHog. OFF unless BOTH `COMMERTIZE_MCP_ANALYTICS=1` and
 * a PostHog project key (`phc_…`) are set.
 *
 * Scope, stated so nobody over-reads it:
 *   - Hosted HTTP surfaces only. The stdio server runs on a user's own
 *     machine and never phones home; index.ts does not import this module.
 *   - Five event types (`EVENTS` below): mcp_initialize, mcp_tools_list,
 *     mcp_tool_call, mcp_auth_failure (keyed only) and x402_payment (DARK, no
 *     caller). Each is built from its own EXPLICIT allowlist of closed-set
 *     properties. Nothing else from the log event can reach PostHog,
 *     whatever a future log adds.
 *   - Anonymous: one constant distinct_id, no person profile, GeoIP off.
 *     Never a key, key id, IP, raw User-Agent, argument or result.
 *   - Best effort: a send that fails or exceeds its timeout is dropped and
 *     never fails, slows or changes the request it describes (it runs after
 *     the response is written).
 */

import { HTTP_TOOL_ALLOWLIST } from "./httpAllowlist.js";
import type { HttpLogEvent } from "./httpServer.js";
import { PUBLIC_TOOL_SET } from "./publicSurface.js";

/**
 * T5-S1 r2, the user-facing disclosure, legal review-certified apx-de218a8e27
 * (CERT_mcp_directory_listings_2026-10-19 A-9; apx-00aee28eb6 is WITHDRAWN).
 * It describes what `toCaptures` sends across the four live events. It goes
 * into the README in the SAME change that sets COMMERTIZE_MCP_ANALYTICS=1 in
 * production, never before (T5-C2). `x402_payment` is deliberately not
 * described: it has no caller, and going live needs a re-cert (T5-C3).
 * analytics-e2e pins this text by id and pins that every field it names maps
 * to an emitted key and every emitted key is named (T5-C1).
 */
export const ANALYTICS_DISCLOSURE =
	"The hosted endpoints send anonymous usage metrics to our analytics provider when a client " +
	"connects, lists the tools, calls a tool or is refused at the key check: the event type, which " +
	"endpoint was used, the directory link the client came from, the tool name, the client " +
	"application's family and version, the MCP protocol version, the outcome, any error code, the " +
	"HTTP status, the response time and the server version. These metrics do not include your key, " +
	"your IP address, the arguments you send or the data returned.";
export const ANALYTICS_DISCLOSURE_ID = "apx-de218a8e27";

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
 * The ONLY client names that can leave for PostHog (security review PR #5 F5-1).
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

/*
 * listing review listing handoff 2026-10-19 F-1: five events, each from its OWN
 * explicit allowlist. Every value that a caller can influence (src, client
 * name/version, protocol version, tool name on the keyed surface, error
 * codes) leaves only as a member of a closed set, else "other"/null.
 */
export const EVENTS = {
	initialize: "mcp_initialize",
	toolsList: "mcp_tools_list",
	toolCall: ANALYTICS_EVENT,
	authFailure: "mcp_auth_failure",
	x402: "x402_payment",
} as const;

/**
 * Directory attribution: `?src=` on the endpoint URL. Closed set; a missing
 * or empty value is "none", anything else is "other". Adding a directory is
 * a reviewed change to this list.
 */
export const SRC_VALUES = [
	"mcp-registry",
	"anthropic",
	"smithery",
	"glama",
	"pulsemcp",
	"mcpso",
	"site",
	"none",
] as const;

export const srcOf = (rawUrl: unknown): string => {
	if (typeof rawUrl !== "string") return "none";
	let v: string | null;
	try {
		v = new URL(rawUrl, "http://localhost").searchParams.get("src");
	} catch {
		return "none";
	}
	if (v === null || v === "") return "none";
	return (SRC_VALUES as readonly string[]).includes(v) ? v : "other";
};

/** MCP protocol revisions are dates; anything else is "other". */
export const protocolVersionOf = (raw: unknown): string | null => {
	if (raw === undefined || raw === null) return null;
	return typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "other";
};

/** The keyed-surface refusals that become `mcp_auth_failure`, and nothing else. */
export const AUTH_FAILURE_CODES = [
	"missing_credential",
	"malformed_credential",
	"invalid_credential",
	"verifier_unavailable",
	"verifier_not_configured",
	"rate_limited",
	"verify_rate_limited",
] as const;

const SURFACE_OF: Record<string, "public" | "keyed"> = {
	public_request: "public",
	request: "keyed",
};

const PRIVACY = { $process_person_profile: false, $geoip_disable: true } as const;

type Cfg = Pick<AnalyticsConfig, "apiKey" | "serverVersion">;

/**
 * security review L5-1: the capture `timestamp` leaves only as a canonical UTC ISO-8601
 * instant (what `Date#toISOString` writes), and only if it round-trips.
 * Anything else, free text included, is null.
 */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isoOrNull = (ts: unknown): string | null => {
	if (typeof ts !== "string" || !ISO_UTC.test(ts)) return null;
	const d = new Date(ts);
	return Number.isFinite(d.getTime()) && d.toISOString() === ts ? ts : null;
};

const envelope = (cfg: Cfg, event: string, ts: unknown, properties: Record<string, unknown>) => ({
	api_key: cfg.apiKey,
	event,
	distinct_id: ANALYTICS_DISTINCT_ID,
	timestamp: isoOrNull(ts),
	properties: { ...properties, ...PRIVACY },
});

const str = (v: unknown) => (typeof v === "string" ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const closed = (v: unknown, set: readonly string[]): string | null =>
	typeof v === "string" ? (set.includes(v) ? v : "other") : null;


const OUTCOME = /^[a-z_]{1,40}$/;
const ERROR_CODE = /^[A-Z_]{1,40}$/;

/**
 * Map one request log event (public `public_request` or keyed `request`) to
 * zero or more capture bodies. Nothing from the log event leaves except the
 * named, closed-set properties below: no key id, IP, header, body, slug,
 * argument, result or message, whatever a future log adds.
 */
export const toCaptures = (e: HttpLogEvent, cfg: Cfg): Record<string, unknown>[] => {
	const surface = SURFACE_OF[e.event];
	if (!surface) return [];
	const out: Record<string, unknown>[] = [];
	const src = closed(e.src, SRC_VALUES) ?? "none";
	const family = clientFamilyOf(e.client_name);
	const outcome = typeof e.outcome === "string" && OUTCOME.test(e.outcome) ? e.outcome : null;
	const rpc = Array.isArray(e.rpc) ? e.rpc : [];

	if (surface === "keyed" && (AUTH_FAILURE_CODES as readonly string[]).includes(String(e.outcome))) {
		out.push(
			envelope(cfg, EVENTS.authFailure, e.ts, {
				surface,
				error_code: e.outcome,
				http_status: num(e.status),
			})
		);
		return out;
	}
	if (rpc.includes("initialize") && num(e.status) === 200) {
		out.push(
			envelope(cfg, EVENTS.initialize, e.ts, {
				surface,
				client_family: family,
				client_version: clientVersionFor(family, e.client_version),
				protocol_version: protocolVersionOf(e.protocol_version),
				src,
				server_version: cfg.serverVersion,
			})
		);
	}
	if (rpc.includes("tools/list")) {
		out.push(
			envelope(cfg, EVENTS.toolsList, e.ts, {
				surface,
				client_family: family,
				src,
				outcome,
				server_version: cfg.serverVersion,
			})
		);
	}
	if (typeof e.tool === "string" && e.tool !== "") {
		// security review L5-2: each surface's own closed set, the public one included.
		const allowed = surface === "public" ? PUBLIC_TOOL_SET : HTTP_TOOL_ALLOWLIST;
		const tool = allowed.has(e.tool) ? e.tool : "(refused)";
		out.push(
			envelope(cfg, EVENTS.toolCall, e.ts, {
				tool,
				transport: surface === "public" ? "http_public" : "http_keyed",
				surface,
				src,
				outcome,
				error_code: typeof e.error_code === "string" && ERROR_CODE.test(e.error_code) ? e.error_code : null,
				http_status: num(e.status),
				latency_ms: num(e.ms),
				client_name: family,
				client_version: clientVersionFor(family, e.client_version),
				server_version: cfg.serverVersion,
			})
		);
	}
	return out;
};

/** The `mcp_tool_call` capture for one log event, or null (#5's original API). */
export const toCapture = (e: HttpLogEvent, cfg: Cfg): Record<string, unknown> | null =>
	toCaptures(e, cfg).find((c) => c.event === EVENTS.toolCall) ?? null;

/** USDC amount (decimal string or number, in whole USDC) to a coarse band. */
export const usdcBandOf = (amountUsdc: unknown): string | null => {
	const n = typeof amountUsdc === "number" ? amountUsdc : typeof amountUsdc === "string" && /^\d{1,12}(\.\d{1,6})?$/.test(amountUsdc) ? Number(amountUsdc) : NaN;
	if (!Number.isFinite(n) || n < 0) return null;
	return n < 1 ? "<1" : n <= 10 ? "1-10" : ">10";
};

/**
 * `x402_payment`, DARK: the x402 tools are not on any HTTP surface
 * (httpAllowlist.ts), and stdio never imports this module, so nothing calls
 * this today. It exists so the event is reviewed before x402 reaches HTTP.
 * Never a payer address, signature, tx hash or nonce: the input type has no
 * field for one, and the output is built from the five named values only.
 */
export const toX402Capture = (
	x: {
		ts: string;
		stage: unknown;
		resourceId: unknown;
		knownResourceIds: readonly string[];
		amountUsdc: unknown;
		outcome: unknown;
		errorCode: unknown;
	},
	cfg: Cfg
): Record<string, unknown> =>
	envelope(cfg, EVENTS.x402, x.ts, {
		stage: closed(x.stage, ["quote", "settle"]),
		resource_id: closed(x.resourceId, x.knownResourceIds),
		amount_usdc_band: usdcBandOf(x.amountUsdc),
		outcome: typeof x.outcome === "string" && OUTCOME.test(x.outcome) ? x.outcome : null,
		error_code: typeof x.errorCode === "string" && ERROR_CODE.test(x.errorCode) ? x.errorCode : null,
		server_version: cfg.serverVersion,
	});

export type FetchLike = (url: string, init: RequestInit) => Promise<{ ok: boolean }>;

/**
 * Returns an async sink, or null when analytics is off. The handler awaits it
 * AFTER the response is written, so a slow PostHog never delays a client.
 * Each capture is its own POST, sent in parallel, each under the timeout.
 */
export const createAnalyticsSink = (
	cfg: AnalyticsConfig,
	fetchImpl: FetchLike = fetch as unknown as FetchLike
): ((e: HttpLogEvent) => Promise<void>) | null => {
	if (!cfg.enabled) return null;
	const url = `${cfg.host}/i/v0/e/`;
	return async (e) => {
		let bodies: Record<string, unknown>[];
		try {
			bodies = toCaptures(e, cfg);
		} catch {
			return;
		}
		await Promise.all(
			bodies.map(async (body) => {
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
			})
		);
	};
};
