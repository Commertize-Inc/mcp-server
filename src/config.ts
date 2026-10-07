/**
 * Runtime configuration.
 *
 * Every value has a safe default so the server runs with no environment at
 * all. The one switch that changes what is exposed (`ENABLE_OFFERINGS`)
 * defaults to CLOSED: the offering tools require an
 * explicit opt-in.
 */

const int = (raw: string | undefined, fallback: number): number => {
	if (raw === undefined || raw.trim() === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export const config = {
	/** Base URL of the Commertize public API. */
	apiBaseUrl: (
		process.env.COMMERTIZE_API_BASE_URL ?? "https://api.commertize.com"
	).replace(/\/+$/, ""),

	/** Public marketing site (news articles are readable here). */
	siteUrl: (process.env.COMMERTIZE_SITE_URL ?? "https://commertize.com").replace(
		/\/+$/,
		""
	),

	/** Investor app. Listing detail pages there require sign-in. */
	appUrl: (
		process.env.COMMERTIZE_APP_URL ?? "https://app.commertize.com"
	).replace(/\/+$/, ""),

	/** Fresh-response window. Repeat calls inside it never touch the API. */
	cacheTtlMs: int(process.env.COMMERTIZE_CACHE_TTL_MS, 60_000),

	/**
	 * How long a cached body may still be served after the API starts
	 * failing. Serving stale beats serving nothing, but it is always
	 * labelled: `cache.stale = true` and `as_of` is the original fetch time.
	 */
	staleMaxMs: int(process.env.COMMERTIZE_STALE_MAX_MS, 15 * 60_000),

	/** Per-request timeout against the upstream API. */
	requestTimeoutMs: int(process.env.COMMERTIZE_REQUEST_TIMEOUT_MS, 10_000),

	/**
	 * Gate for the offerings tools. `list_offerings` /
	 * `get_offering` return listing data only when
	 * `COMMERTIZE_MCP_ENABLE_OFFERINGS=1` (exact string) AND the emergency
	 * kill switch `COMMERTIZE_MCP_DISABLE_OFFERINGS` is not "1".
	 *
	 * The default is DISABLED. Offering data can include Rule 506(b)
	 * offerings, and 506(b) permits no general solicitation.
	 * A missing, empty, or malformed environment therefore
	 * must not open the gate — only the exact value "1" does.
	 */
	offeringsDisabled:
		process.env.COMMERTIZE_MCP_DISABLE_OFFERINGS === "1" ||
		process.env.COMMERTIZE_MCP_ENABLE_OFFERINGS !== "1",

	/**
	 * Gate for the simulation-venue tools.
	 *
	 * The venue itself is mounted on the backend only when
	 * `AGENTS_SANDBOX_ENABLED=1` there, and with it unset every path under
	 * `/api/agents/sandbox` is a 404. Registering tools that can only 404 would
	 * teach a machine reader that the venue is broken rather than absent (the
	 * #308 `/partner` defect, for a tool list), so these tools are NOT
	 * REGISTERED unless this is the exact string "1".
	 *
	 * Default DISABLED, and the reason is not technical: whether the venue may
	 * run at all rests on an open question for Commertize's founder about what
	 * instruments it may name. Same fail-closed parse as the offerings gate —
	 * unset, empty, "true", "yes", "on" are all off.
	 */
	sandboxDisabled:
		process.env.COMMERTIZE_MCP_DISABLE_SANDBOX === "1" ||
		process.env.COMMERTIZE_MCP_ENABLE_SANDBOX !== "1",

	/**
	 * Gate for the x402 paid-data tools.
	 *
	 * Same reasoning and same parse. The backend rail is off by default and its
	 * payment terms are unratified draft text; tools that quote a price against
	 * terms nobody has approved should not appear in a tool list.
	 */
	x402Disabled:
		process.env.COMMERTIZE_MCP_DISABLE_X402 === "1" ||
		process.env.COMMERTIZE_MCP_ENABLE_X402 !== "1",

	/**
	 * Gate for `request_memo`, the server's only write.
	 *
	 * NOT a policy gate like the offerings one — a DEPLOYMENT gate. The route
	 * it posts to, `POST /api/agents/memo-request`, is not mounted on
	 * api.commertize.com: probed 2026-09-10 it returns Hono's unmounted-route
	 * 404 (plain-text `404 Not Found`), where a mounted route with a missing
	 * resource returns JSON (`GET /api/news/{unknown-slug}` ->
	 * `{"error":"Article not found"}`) and a mounted route with a bad body
	 * returns 400 (`POST /api/contact {}`). The whole `/api/agents` router
	 * is not deployed.
	 *
	 * Same fail-closed parse as every other gate here, and default DISABLED,
	 * because a client installed from a registry runs this server with no
	 * environment at all. Set `COMMERTIZE_MCP_ENABLE_MEMO=1` when the router is
	 * deployed to whatever `COMMERTIZE_API_BASE_URL` points at.
	 *
	 * DEPLOYING THE ROUTE IS NOT ON ITS OWN A REASON TO OPEN THIS GATE. The
	 * backend carries its own flag, `AGENTS_MEMO_DISCOVERABLE`, also default
	 * OFF, and it exists because the endpoint accepts a request and creates a
	 * request that a person must answer. With that flag off the backend deliberately hides the
	 * memo from its OpenAPI document, its discovery document and its
	 * `ai-plugin.json` — so a tool list advertising it would be the one surface
	 * contradicting all three. Open this gate only when BOTH are true: the
	 * route answers, and `AGENTS_MEMO_DISCOVERABLE=1` on the same API.
	 */
	memoDisabled:
		process.env.COMMERTIZE_MCP_DISABLE_MEMO === "1" ||
		process.env.COMMERTIZE_MCP_ENABLE_MEMO !== "1",

	/**
	 * Gate for `get_disclosure_package`, for the same reason and with the same
	 * parse: `GET /api/offerings/v1/{id}/disclosure` 404s in production
	 * (2026-09-10), and its router is likewise undeployed.
	 *
	 * Kept SEPARATE from the memo gate on purpose: the two routes are on two
	 * different branches, of two very different sizes, and they will not land
	 * on the same day. One flag per deployable unit.
	 */
	disclosureDisabled:
		process.env.COMMERTIZE_MCP_DISABLE_DISCLOSURE === "1" ||
		process.env.COMMERTIZE_MCP_ENABLE_DISCLOSURE !== "1",

	/**
	 * Agent credential for the one write tool, `request_memo`.
	 *
	 * Obtained from POST /api/agents/register and shown once. There is no
	 * default and no fallback: without it `request_memo` refuses and says so.
	 * A write tool that silently does nothing is worse than one that is off.
	 */
	agentKey: process.env.COMMERTIZE_AGENT_KEY ?? "",

	/**
	 * Gate for `file_sponsor_inquiry`, the sponsor-inquiry write.
	 *
	 * `POST /contact` IS mounted on api.commertize.com (a `{}` body answers
	 * 400, the mounted-route signature, probed 2026-09-10). What is NOT
	 * deployed is the `agent` attribution contract the tool relies on: until
	 * the API records `agent.name` / `agent.url` / `agent.operator`, an
	 * inquiry filed through this tool would be stored WITHOUT the attribution
	 * the tool's description promises. A tool must not describe an effect
	 * that does not happen, so it is gated like the memo tool: default OFF,
	 * the exact string "1" opens it, DISABLE beats ENABLE. Open it only on an
	 * API that records the attribution.
	 */
	inquiryDisabled:
		process.env.COMMERTIZE_MCP_DISABLE_INQUIRY === "1" ||
		process.env.COMMERTIZE_MCP_ENABLE_INQUIRY !== "1",

	/* ---------------------------------------------------------------- */
	/* Streamable HTTP transport (remote MCP)                            */
	/* ---------------------------------------------------------------- */

	/** Loopback by default: exposing the port is an explicit deployment act. */
	httpHost: process.env.COMMERTIZE_MCP_HTTP_HOST ?? "127.0.0.1",
	httpPort: int(process.env.COMMERTIZE_MCP_HTTP_PORT, 3920),

	/**
	 * Where a presented `cfa_…` key is checked: a path on `apiBaseUrl`, so one
	 * base-URL switch moves every upstream call together. The route must
	 * answer 200 for a live key and 401 for anything else; any other answer,
	 * or no answer, is "cannot verify" and the request is refused with 503.
	 * There is no "skip verification" switch: an HTTP server that cannot
	 * reach its verifier refuses every call.
	 */
	keyIntrospectPath:
		process.env.COMMERTIZE_MCP_KEY_INTROSPECT_PATH ??
		"/agent-platform/keys/introspect",

	/**
	 * Service secret the introspection route requires
	 * (`x-commertize-introspect-secret`). No default. Unset = this server
	 * cannot ask and refuses every call with 503 — and makes no upstream
	 * request. The value is never logged or served.
	 */
	introspectSecret: (process.env.COMMERTIZE_MCP_INTROSPECT_SECRET ?? "").trim() || null,

	/**
	 * A verified key is trusted for this long before it is re-checked.
	 * Hard ceiling 15 s: a revoked key works for at most that
	 * long. An environment can lower it, not raise it.
	 */
	keyVerifyCacheMs: Math.min(
		int(process.env.COMMERTIZE_MCP_KEY_VERIFY_CACHE_MS, 15_000),
		15_000
	),

	/**
	 * A refused key (401/403 from the route) is remembered for this long so
	 * a flood of the same bad key costs one upstream call per window.
	 * Ceiling 5 min; a freshly minted key tried a second early
	 * waits at most this long.
	 */
	keyNegativeCacheMs: Math.min(
		int(process.env.COMMERTIZE_MCP_KEY_NEGATIVE_CACHE_MS, 30_000),
		300_000
	),

	/**
	 * Per-client-IP ceiling on verification attempts per minute (requests
	 * whose key is not answered from cache). With a 15 s positive TTL one
	 * key needs 4 a minute; 20 leaves room for a few keys behind one
	 * address and stops an amplifier.
	 */
	httpVerifyPerIpPerMinute: int(
		process.env.COMMERTIZE_MCP_HTTP_VERIFY_PER_IP_PER_MIN,
		20
	),

	/** Per-key ceiling on JSON-RPC requests over HTTP (fixed one-minute window). */
	httpRequestsPerMinute: int(process.env.COMMERTIZE_MCP_HTTP_RPM, 60),

	/** Per-key ceiling on sponsor inquiries over HTTP (fixed one-hour window). */
	httpInquiriesPerHour: int(
		process.env.COMMERTIZE_MCP_HTTP_INQUIRIES_PER_HOUR,
		2
	),

	/** Largest JSON-RPC body accepted over HTTP, in bytes. */
	httpMaxBodyBytes: int(process.env.COMMERTIZE_MCP_HTTP_MAX_BODY_BYTES, 65_536),

	/**
	 * Where `content/` lives. Default: next to `dist/`. A packager that moves
	 * the built file (a serverless bundle) sets this to the absolute path of
	 * the shipped `content/` directory.
	 */
	contentDir: process.env.COMMERTIZE_MCP_CONTENT_DIR ?? "",

	userAgent: "commertize-mcp-server/0.1.0 (+https://commertize.com)",
} as const;
