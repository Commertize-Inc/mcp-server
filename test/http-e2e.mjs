/**
 * Streamable HTTP transport — end-to-end, offline.
 *
 * A real Node HTTP server running the real handler (`dist/httpServer.js`),
 * a real MCP client over the SDK's Streamable HTTP client transport, and a
 * LOCAL stub upstream that plays the Commertize API: the key-introspection
 * route, `GET /api/news`, `GET /api/news/{slug}` and `POST /contact`.
 *
 * What this suite exists to hold, in order:
 *
 *  1. NO CREDENTIAL, NO ENTRY. Missing, malformed, and well-formed-but-unknown
 *     keys are all 401; the malformed one never reaches the verifier.
 *  2. A VERIFIER THAT CANNOT ANSWER IS A NO. 5xx, non-JSON, a 200 naming a
 *     different key, and an unreachable verifier are all 503 — never through.
 *  3. THE ALLOWLIST IS ENFORCED BY NAME, BEFORE DISPATCH. With the memo gate
 *     OPEN, `request_memo` is absent from `tools/list`, absent from
 *     `platform_info.tools`, and a direct `tools/call` for it is HTTP 403 with
 *     a `tool_refused` log event. Same for a name that does not exist.
 *  4. THE PER-KEY CEILINGS BITE. The request limiter returns 429 with
 *     Retry-After; the inquiry limiter refuses the (N+1)th inquiry and files
 *     nothing (the stub counts).
 *  5. CORS IS OFF. No Access-Control-* header on any response; OPTIONS is 405.
 *  6. THE FULL RUN WORKS: initialize -> platform_info -> get_news ->
 *     get_article -> file_sponsor_inquiry, and the stub received the agent
 *     attribution verbatim.
 *  7. THE LOG CARRIES NO SECRET. Every captured event is searched for the
 *     key, its secret half, and the Authorization header value.
 *
 * Run directly: node test/http-e2e.mjs
 */

import { createServer as createNodeServer } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { check, resetCounters, section, summary, DISCLAIMER } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "..", "dist");

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const KEY_ID = "0123456789abcdef";
const SECRET = "A".repeat(43); // 43 base64url chars, like a 32-byte secret
const GOOD_KEY = `cfa_${KEY_ID}_${SECRET}`;
const OTHER_KEY = `cfa_fedcba9876543210_${"B".repeat(43)}`;
const MALFORMED = [
	"",
	"cfa_short",
	`ctz_${KEY_ID}_${SECRET}`, // the venue prefix must never authenticate here
	`cfa_${KEY_ID}_${"A".repeat(42)}`, // one char short
	`cfa_${KEY_ID}_${"A".repeat(44)}`, // one char long
	`cfa_${KEY_ID.toUpperCase()}_${SECRET}`, // hex is lower-case
	`CFA_${KEY_ID}_${SECRET}`,
];

const ARTICLES = [
	{
		slug: "tokenization-week",
		title: "Tokenization this week",
		summary: "A summary.",
		category: "Tokenization",
		publishedAt: "2026-10-01T00:00:00.000Z",
		readTime: 3,
		imageUrl: null,
		content: "<p>Body text.</p>",
	},
];

/** What the stub upstream does with introspection; set per section. */
let introspectMode = "normal";
let introspectHits = 0;
let introspectSecrets = [];
const SERVICE_SECRET = "service-secret-for-the-stub-" + "x".repeat(20);
const EXPIRES_IN_MS = 4_000;
let contactBodies = [];
let contactMode = "accept";

const upstream = createNodeServer((req, res) => {
	const url = new URL(req.url, "http://stub");
	const json = (status, body) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};

	if (url.pathname === "/agent-platform/keys/introspect") {
		introspectSecrets.push(req.headers["x-commertize-introspect-secret"] ?? null);
		if (introspectMode !== "no-secret-check" && req.headers["x-commertize-introspect-secret"] !== SERVICE_SECRET) {
			return json(403, { error: "This route answers only the hosted agent surface.", code: "caller_unauthorized" });
		}
		introspectHits += 1;
		const auth = req.headers.authorization ?? "";
		const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
		switch (introspectMode) {
			case "down":
				return json(500, { error: "boom" });
			case "down-echo":
				// A 5xx whose body happens to name the key (an error page from a
				// proxy that echoes the request). Status must be checked on its
				// own, not inferred from the body.
				return json(503, { key_id: KEY_ID, error: "upstream unavailable" });
			case "html": {
				res.writeHead(200, { "content-type": "text/html" });
				return res.end("<html>ok</html>");
			}
			case "wrong-key":
				return json(200, { key_id: "ffffffffffffffff" });
			case "revoked":
				return json(403, { error: "The agent key was revoked.", code: "key_revoked" });
			case "expiring":
				return json(200, { key_id: KEY_ID, scope: "all_agents", status: "active", expires_at: new Date(Date.now() + EXPIRES_IN_MS).toISOString() });
			case "yes-to-everyone":
				return json(200, { ok: true }); // no key_id at all
			default:
				if (presented === GOOD_KEY) return json(200, { key_id: KEY_ID, scope: "single_agent", status: "active", expires_at: new Date(Date.now() + 86_400_000).toISOString() });
				return json(401, { error: "invalid_api_key" });
		}
	}

	// The live API wraps both news routes in `{ data }`.
	if (url.pathname === "/api/news") return json(200, { data: ARTICLES });
	if (url.pathname.startsWith("/api/news/")) {
		const slug = url.pathname.slice("/api/news/".length);
		const a = ARTICLES.find((x) => x.slug === slug);
		return a ? json(200, { data: a }) : json(404, { error: "Article not found" });
	}

	if (url.pathname === "/contact" && req.method === "POST") {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			const body = JSON.parse(raw);
			contactBodies.push({ body, auth: req.headers.authorization ?? null, key: req.headers["x-agent-key"] ?? null });
			if (contactMode === "reject") {
				return json(400, { error: "Invalid desk data", details: { fieldErrors: { phone: ["Phone number is required for sponsor inquiries"] } } });
			}
			if (contactMode === "throttle") {
				res.writeHead(429, { "content-type": "application/json", "retry-after": "1800" });
				return res.end(JSON.stringify({ error: "Too many requests" }));
			}
			return json(201, { success: true, id: `inq_${contactBodies.length}` });
		});
		return;
	}

	res.writeHead(404, { "content-type": "text/plain" });
	res.end("404 Not Found");
});

await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;

/*
 * The environment is read by `config.ts` at import time, so set it BEFORE the
 * dynamic imports below. Memo gate OPEN on purpose: section 3 proves the
 * allowlist refuses it over HTTP even though its gate would register it on
 * stdio. Inquiry gate open, since the full run files one.
 */
process.env.COMMERTIZE_API_BASE_URL = UPSTREAM;
process.env.COMMERTIZE_MCP_ENABLE_MEMO = "1";
process.env.COMMERTIZE_MCP_DISABLE_MEMO = "";
process.env.COMMERTIZE_MCP_ENABLE_INQUIRY = "1";
process.env.COMMERTIZE_MCP_DISABLE_INQUIRY = "";
process.env.COMMERTIZE_AGENT_KEY = "memo-key-that-must-never-be-needed-here";

const { createHttpHandler } = await import(path.join(DIST, "httpServer.js"));
const { KeyVerifier } = await import(path.join(DIST, "httpAuth.js"));
const { FixedWindowLimiter } = await import(path.join(DIST, "httpRateLimit.js"));
const { createServer } = await import(path.join(DIST, "index.js"));
const { HTTP_TOOL_ALLOWLIST } = await import(path.join(DIST, "httpAllowlist.js"));

const RPM = 40; // the SDK handshake alone is several POSTs; section 4 counts to this exactly
const INQ = 2;
const NEG_MS = 1_500;
const events = [];
const verifier = new KeyVerifier({
	introspectUrl: `${UPSTREAM}/agent-platform/keys/introspect`,
	serviceSecret: SERVICE_SECRET,
	cacheMs: 60_000, // asks for 60 s; the verifier clamps to 15 s (section 2b proves it)
	negativeCacheMs: NEG_MS,
	timeoutMs: 2_000,
	userAgent: "test",
});
const requestLimiter = new FixedWindowLimiter(RPM, 60_000);
const inquiryLimiter = new FixedWindowLimiter(INQ, 60 * 60_000);
const VERIFY_PER_IP = 6;
const verifyLimiter = new FixedWindowLimiter(VERIFY_PER_IP, 60_000);
const handler = createHttpHandler({
	verifier,
	requestLimiter,
	inquiryLimiter,
	verifyLimiter,
	createServer: () => createServer("http"),
	log: (e) => events.push(e),
	maxBodyBytes: 4096,
	version: "test",
});

const server = createNodeServer((req, res) => {
	handler(req, res).catch((err) => {
		console.error("handler threw", err);
		if (!res.headersSent) res.writeHead(500).end();
	});
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const MCP = `${BASE}/mcp`;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const INIT = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "test", version: "0" },
	},
};
const CALL = (name, args = {}, id = 2) => ({
	jsonrpc: "2.0",
	id,
	method: "tools/call",
	params: { name, arguments: args },
});

const post = (body, headers = {}) =>
	fetch(MCP, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...headers,
		},
		body: typeof body === "string" ? body : JSON.stringify(body),
	});

const bearer = (key) => ({ authorization: `Bearer ${key}` });

const connectHttp = async (key) => {
	const transport = new StreamableHTTPClientTransport(new URL(MCP), {
		requestInit: { headers: { authorization: `Bearer ${key}` } },
	});
	const client = new Client({ name: "commertize-http-test", version: "0.1.0" });
	await client.connect(transport);
	return client;
};

const reset = () => {
	requestLimiter.reset();
	inquiryLimiter.reset();
	verifyLimiter.reset();
	introspectSecrets = [];
	verifier.clear();
	introspectMode = "normal";
	introspectHits = 0;
	contactBodies = [];
	contactMode = "accept";
};

const noCors = (label, res) => {
	const offenders = [...res.headers.keys()].filter((k) => k.startsWith("access-control-"));
	check(`${label}: no Access-Control-* header`, offenders.length === 0, offenders.join(","));
};

resetCounters();

/* ------------------------------------------------------------------ */
section("0. health and routing");
/* ------------------------------------------------------------------ */
{
	const h = await fetch(`${BASE}/health`);
	const body = await h.json();
	check("GET /health is 200", h.status === 200);
	check("health names the transport", body.transport === "streamable-http" && body.endpoint === "/mcp");
	check("health needs no credential and reveals none", !("verifier_url" in body) && !JSON.stringify(body).includes(UPSTREAM));
	noCors("health", h);

	const nf = await fetch(`${BASE}/nope`);
	check("unknown path is 404", nf.status === 404);
	for (const method of ["GET", "DELETE", "OPTIONS", "PUT"]) {
		const r = await fetch(MCP, { method, headers: bearer(GOOD_KEY) });
		check(`${method} /mcp is 405`, r.status === 405, String(r.status));
		noCors(`${method} /mcp`, r);
	}
	check("introspection was not consulted for non-POST methods", introspectHits === 0, String(introspectHits));
}

/* ------------------------------------------------------------------ */
section("1. no credential, no entry");
/* ------------------------------------------------------------------ */
{
	reset();
	const none = await post(INIT);
	check("no Authorization -> 401", none.status === 401);
	check("401 carries WWW-Authenticate: Bearer", /^Bearer/.test(none.headers.get("www-authenticate") ?? ""));
	noCors("401", none);
	check("no upstream call for a missing credential", introspectHits === 0);

	for (const bad of MALFORMED) {
		const r = await post(INIT, bearer(bad));
		check(`malformed ${JSON.stringify(bad).slice(0, 30)} -> 401`, r.status === 401, String(r.status));
	}
	check("malformed keys never reach the verifier", introspectHits === 0, String(introspectHits));

	const basic = await post(INIT, { authorization: `Basic ${Buffer.from(GOOD_KEY).toString("base64")}` });
	check("a non-Bearer scheme is 401", basic.status === 401);

	const unknown = await post(INIT, bearer(OTHER_KEY));
	const unknownBody = await unknown.json();
	check("well-formed but unknown key -> 401 after one introspection", unknown.status === 401 && introspectHits === 1, `${unknown.status}/${introspectHits}`);
	check("refusal names the code, not the key", unknownBody.error === "invalid_credential" && !JSON.stringify(unknownBody).includes(OTHER_KEY));

	// Negative verdicts ARE cached: the same bad key again costs no
	// upstream call inside the window, and is re-asked after it.
	await post(INIT, bearer(OTHER_KEY));
	check("a refused key is answered from the negative cache (2 requests, 1 introspection)", introspectHits === 1, String(introspectHits));
	await new Promise((r) => setTimeout(r, NEG_MS + 100));
	await post(INIT, bearer(OTHER_KEY));
	check("after the negative window the key is re-checked", introspectHits === 2, String(introspectHits));
}

/* ------------------------------------------------------------------ */
section("2. a verifier that cannot answer is a no");
/* ------------------------------------------------------------------ */
{
	for (const mode of ["down", "down-echo", "html", "wrong-key", "yes-to-everyone"]) {
		reset();
		introspectMode = mode;
		const r = await post(INIT, bearer(GOOD_KEY));
		const body = await r.json();
		check(`verifier ${mode} -> 503, not through`, r.status === 503 && body.error === "verifier_unavailable", `${r.status} ${body.error}`);
	}

	// Unreachable verifier: point at a closed port.
	reset();
	const dead = new KeyVerifier({
		introspectUrl: "http://127.0.0.1:1/agent-platform/keys/introspect",
		serviceSecret: SERVICE_SECRET,
		cacheMs: 60_000,
		negativeCacheMs: 0,
		timeoutMs: 1_000,
		userAgent: "test",
	});
	const v = await dead.verify(GOOD_KEY);
	check("unreachable verifier -> 503 verdict", v.ok === false && v.status === 503 && v.code === "verifier_unavailable");

	// And the positive path caches: two requests, one introspection.
	reset();
	await post(INIT, bearer(GOOD_KEY));
	await post(INIT, bearer(GOOD_KEY));
	check("a verified key is cached (2 requests, 1 introspection)", introspectHits === 1, String(introspectHits));
}


/* ------------------------------------------------------------------ */
section("1b. the service secret: this server must identify itself to the route");
/* ------------------------------------------------------------------ */
{
	reset();
	const ok = await post(INIT, bearer(GOOD_KEY));
	check("the stub saw the service secret on the introspection", ok.status === 200 && introspectSecrets[0] === SERVICE_SECRET, `${ok.status}/${String(introspectSecrets[0]).slice(0, 8)}`);

	// No secret configured: 503, and NOT ONE upstream call.
	reset();
	const unconfigured = new KeyVerifier({ introspectUrl: `${UPSTREAM}/agent-platform/keys/introspect`, serviceSecret: null, cacheMs: 60_000, negativeCacheMs: NEG_MS, timeoutMs: 2_000, userAgent: "test" });
	const v = await unconfigured.verify(GOOD_KEY);
	check("no service secret -> 503 verifier_not_configured", v.ok === false && v.status === 503 && v.code === "verifier_not_configured", JSON.stringify(v));
	check("no service secret -> zero upstream calls", introspectHits === 0, String(introspectHits));
	check("/health reports verifier_configured=false for it", unconfigured.configured === false);
	const empty = new KeyVerifier({ introspectUrl: `${UPSTREAM}/x`, serviceSecret: "", cacheMs: 1, negativeCacheMs: 0, timeoutMs: 1, userAgent: "t" });
	check("an empty secret is 'not configured'", empty.configured === false);

	// The route refusing OUR secret is 503 "cannot verify", never "bad key",
	// and is not negatively cached (fixing the secret must take effect at once).
	reset();
	const wrongSecret = new KeyVerifier({ introspectUrl: `${UPSTREAM}/agent-platform/keys/introspect`, serviceSecret: "not-the-secret", cacheMs: 60_000, negativeCacheMs: NEG_MS, timeoutMs: 2_000, userAgent: "test" });
	const w1 = await wrongSecret.verify(GOOD_KEY);
	check("route says caller_unauthorized -> 503 verifier_unavailable, not 401", w1.ok === false && w1.status === 503 && w1.code === "verifier_unavailable", JSON.stringify(w1));
	const w2 = await wrongSecret.verify(GOOD_KEY);
	check("a caller_unauthorized answer is not negatively cached (asked again)", introspectSecrets.length === 2 && w2.cached === false, String(introspectSecrets.length));

	const h = await (await fetch(`${BASE}/health`)).json();
	check("/health carries verifier_configured=true for the live handler and no secret", h.verifier_configured === true && !JSON.stringify(h).includes(SERVICE_SECRET));
}

/* ------------------------------------------------------------------ */
section("2b. a verified key is trusted for at most 15 s, never past expires_at, and a 403 ends it");
/* ------------------------------------------------------------------ */
{
	const { MAX_POSITIVE_CACHE_MS } = await import(path.join(DIST, "httpAuth.js"));
	check("the hard ceiling is 15 s", MAX_POSITIVE_CACHE_MS === 15_000);

	// The stub stamps expires_at with the real clock, so the fake clock starts there.
	let clock = Date.now();
	const stubFetch = async (url, init) => fetch(url, init);
	const mk = (cacheMs, negMs = 0) => new KeyVerifier({ introspectUrl: `${UPSTREAM}/agent-platform/keys/introspect`, serviceSecret: SERVICE_SECRET, cacheMs, negativeCacheMs: negMs, timeoutMs: 2_000, userAgent: "test", fetchImpl: stubFetch, now: () => clock });

	// Asked for 60 s, clamped to 15 s.
	reset();
	introspectMode = "normal";
	const long = mk(60_000);
	await long.verify(GOOD_KEY);
	clock += 14_999;
	const still = await long.verify(GOOD_KEY);
	check("at 14.999 s the verdict is still cached", still.ok && still.cached === true && introspectHits === 1, `${introspectHits}`);
	clock += 1;
	const again = await long.verify(GOOD_KEY);
	check("at 15.000 s the key is re-checked (60 s requested, 15 s honoured)", again.ok && again.cached === false && introspectHits === 2, `${introspectHits}`);

	// Bounded by expires_at: the route says 4 s left (stamped with the real
	// clock), so trust ends there. Re-align the fake clock with the real one.
	clock = Date.now();
	reset();
	introspectMode = "expiring";
	const exp = mk(15_000);
	await exp.verify(GOOD_KEY);
	clock += EXPIRES_IN_MS - 500;
	const before = await exp.verify(GOOD_KEY);
	clock += 1_000;
	const after = await exp.verify(GOOD_KEY);
	check("inside expires_at the verdict is cached; past it the key is re-checked", before.cached === true && after.cached === false && introspectHits === 2, `${introspectHits} ${before.cached}/${after.cached}`);

	clock = Date.now();
	// Revocation honoured: a cached yes, then the route says 403 -> refused and
	// the positive entry is gone (a later 200 would be a fresh ask).
	reset();
	introspectMode = "normal";
	const rev = mk(15_000, NEG_MS);
	const y = await rev.verify(GOOD_KEY);
	introspectMode = "revoked";
	clock += 15_000;
	const n = await rev.verify(GOOD_KEY);
	check("after the TTL a revoked key is refused with 401 invalid_credential", y.ok && n.ok === false && n.status === 401 && n.code === "invalid_credential", JSON.stringify(n));
	check("the refusal is negatively cached (no extra upstream call)", (await rev.verify(GOOD_KEY)).cached === true && introspectHits === 2, String(introspectHits));
	introspectMode = "normal";
	clock += NEG_MS;
	const back = await rev.verify(GOOD_KEY);
	check("after the negative window the route is asked again", back.ok && back.cached === false && introspectHits === 3, String(introspectHits));

	// Default from config is 15 s and an environment cannot raise it.
	process.env.COMMERTIZE_MCP_KEY_VERIFY_CACHE_MS = "600000";
	const { config: cfg } = await import(path.join(DIST, "config.js") + `?t=${Date.now()}`);
	check("config clamps COMMERTIZE_MCP_KEY_VERIFY_CACHE_MS to 15000", cfg.keyVerifyCacheMs === 15_000, String(cfg.keyVerifyCacheMs));
	check("config: negative cache defaults to 30 s, brake to 20/min, no secret -> null", cfg.keyNegativeCacheMs === 30_000 && cfg.httpVerifyPerIpPerMinute === 20 && cfg.introspectSecret === null);
	delete process.env.COMMERTIZE_MCP_KEY_VERIFY_CACHE_MS;
}

/* ------------------------------------------------------------------ */
section("4b. the per-IP verification brake bites before any upstream call");
/* ------------------------------------------------------------------ */
{
	reset();
	// Distinct well-formed unknown keys from ONE address: each is a cache miss.
	const fresh = (i) => `cfa_${i.toString(16).padStart(16, "0")}_${"C".repeat(43)}`;
	let last;
	for (let i = 1; i <= VERIFY_PER_IP; i += 1) last = await post(INIT, bearer(fresh(i)));
	check(`the first ${VERIFY_PER_IP} misses from one address are verified (401 each)`, last.status === 401 && introspectHits === VERIFY_PER_IP, `${last.status}/${introspectHits}`);
	const braked = await post(INIT, bearer(fresh(VERIFY_PER_IP + 1)));
	check(`miss ${VERIFY_PER_IP + 1} is 429 before any upstream call`, braked.status === 429 && introspectHits === VERIFY_PER_IP, `${braked.status}/${introspectHits}`);
	check("the 429 carries Retry-After", /^\d+$/.test(braked.headers.get("retry-after") ?? ""));
	check("a verify_rate_limited event was logged without a key id", events.some((e) => e.event === "verify_rate_limited" && !("key_id" in e)));
	noCors("brake 429", braked);

	// A cached key is free: it passes under the brake.
	reset();
	await post(INIT, bearer(GOOD_KEY)); // one miss, now cached
	for (let i = 1; i <= VERIFY_PER_IP + 2; i += 1) await post(INIT, bearer(fresh(100 + i)));
	const cachedOk = await post(INIT, bearer(GOOD_KEY));
	check("a key answered from cache is not braked", cachedOk.status === 200, String(cachedOk.status));
	check("malformed keys never count against the brake (refused locally)", (await post(INIT, bearer("cfa_short"))).status === 401);

	// Another address is unaffected (Vercel's header is the identity).
	const other = await post(INIT, { ...bearer(fresh(999)), "x-vercel-forwarded-for": "198.51.100.7" });
	check("another client address keeps its own brake", other.status === 401, String(other.status));
	const spoof = await post(INIT, { ...bearer(fresh(998)), "x-forwarded-for": "203.0.113.1" });
	check("a caller-set x-forwarded-for does not escape the brake", spoof.status === 429, String(spoof.status));
}

/* ------------------------------------------------------------------ */
section("3. the allowlist is enforced by name, before dispatch");
/* ------------------------------------------------------------------ */
{
	reset();
	const client = await connectHttp(GOOD_KEY);
	const listed = (await client.listTools()).tools.map((t) => t.name).sort();
	check("every listed tool is allowlisted", listed.every((n) => HTTP_TOOL_ALLOWLIST.has(n)), listed.join(","));
	check("request_memo is NOT listed over HTTP although its gate is open", !listed.includes("request_memo"));
	check("file_sponsor_inquiry IS listed (gate open)", listed.includes("file_sponsor_inquiry"));
	check("the reads are listed", ["platform_info", "get_news", "get_article", "search_offerings"].every((n) => listed.includes(n)));

	const info = await client.callTool({ name: "platform_info", arguments: {} });
	const caps = info.structuredContent?.capabilities;
	check("platform_info.tools equals tools/list over HTTP", JSON.stringify([...(caps?.tools ?? [])].sort()) === JSON.stringify(listed), JSON.stringify(caps?.tools));
	check("platform_info.write_tools over HTTP is exactly the inquiry", JSON.stringify(caps?.write_tools) === JSON.stringify(["file_sponsor_inquiry"]), JSON.stringify(caps?.write_tools));
	check("platform_info.read_only is false (a write is registered)", caps?.read_only === false);
	await client.close();

	// Direct refusals, raw JSON-RPC, so the test does not depend on the SDK's
	// handling of an HTTP 403. The SDK handshake above spent part of this
	// key's window; start a fresh one so a 429 cannot masquerade as a 403.
	requestLimiter.reset();
	const before = events.length;
	const memo = await post(CALL("request_memo", { asset_class: "other", size_band: "under_10m", doc_link: "https://x.example" }), bearer(GOOD_KEY));
	const memoBody = await memo.json();
	check("tools/call request_memo over HTTP is 403", memo.status === 403, String(memo.status));
	check("the 403 is a JSON-RPC error with the request id", memoBody.jsonrpc === "2.0" && memoBody.id === 2 && memoBody.error?.code === -32601);
	const refusedEvents = events.slice(before).filter((e) => e.event === "tool_refused");
	check("a tool_refused event was logged with the tool name", refusedEvents.length === 1 && refusedEvents[0].tool === "request_memo" && refusedEvents[0].key_id === KEY_ID, JSON.stringify(refusedEvents));

	for (const name of ["sandbox_enroll", "x402_fetch", "no_such_tool"]) {
		const r = await post(CALL(name), bearer(GOOD_KEY));
		check(`tools/call ${name} over HTTP is 403`, r.status === 403, String(r.status));
	}

	// A batch with one refused call is refused whole.
	const batch = await post([CALL("platform_info", {}, 10), CALL("request_memo", {}, 11)], bearer(GOOD_KEY));
	check("a batch containing a refused call is 403", batch.status === 403, String(batch.status));

	// A non-string name is not an allowlisted name.
	const weird = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: ["platform_info"] } }, bearer(GOOD_KEY));
	check("a non-string tool name is 403", weird.status === 403, String(weird.status));

	// Positive control: an allowlisted call through the same raw path is 200.
	const okCall = await post(CALL("platform_info"), bearer(GOOD_KEY));
	check("control: tools/call platform_info over HTTP is 200", okCall.status === 200, String(okCall.status));
}

/* ------------------------------------------------------------------ */
section("4. the per-key ceilings bite");
/* ------------------------------------------------------------------ */
{
	reset();
	let last;
	for (let i = 0; i < RPM; i += 1) last = await post(INIT, bearer(GOOD_KEY));
	check(`the first ${RPM} requests pass`, last.status === 200, String(last.status));
	const over = await post(INIT, bearer(GOOD_KEY));
	check(`request ${RPM + 1} is 429`, over.status === 429, String(over.status));
	check("429 carries Retry-After in seconds", /^\d+$/.test(over.headers.get("retry-after") ?? ""), over.headers.get("retry-after"));
	check("a rate_limited event was logged", events.some((e) => e.event === "rate_limited" && e.key_id === KEY_ID));
	// Another key is not affected.
	introspectMode = "normal";
	const other = await post(INIT, bearer(OTHER_KEY));
	check("the ceiling is per key (another key gets its own verdict, not 429)", other.status === 401, String(other.status));

	reset();
	const client = await connectHttp(GOOD_KEY);
	const inquiry = {
		principal_name: "Pat Example",
		principal_email: "pat@example.com",
		principal_phone: "+1 555 0100",
		organization: "Example Holdings LLC",
		asset_type: "data center",
		message: "We control a 12 MW facility and want to discuss tokenizing it.",
		agent_name: "test-agent",
		agent_url: "https://agent.example/about",
		operator: "Example Operator",
	};
	const results = [];
	for (let i = 0; i < INQ; i += 1) {
		results.push(await client.callTool({ name: "file_sponsor_inquiry", arguments: inquiry }));
	}
	check(`the first ${INQ} inquiries are filed`, results.every((r) => r.isError !== true && r.structuredContent?.inquiry?.id), JSON.stringify(results.map((r) => r.structuredContent?.error)));
	check(`the stub received exactly ${INQ} inquiries`, contactBodies.length === INQ, String(contactBodies.length));
	let third;
	try {
		third = await client.callTool({ name: "file_sponsor_inquiry", arguments: inquiry });
	} catch (err) {
		third = { thrown: String(err?.message ?? err) };
	}
	check(`inquiry ${INQ + 1} is refused by this server`, third.thrown !== undefined || third.isError === true, JSON.stringify(third).slice(0, 200));
	check("the refused inquiry reached the stub ZERO times", contactBodies.length === INQ, String(contactBodies.length));
	check("an inquiry_rate_limited event was logged", events.some((e) => e.event === "inquiry_rate_limited"));
	await client.close();
}

/* ------------------------------------------------------------------ */
section("5. body limits");
/* ------------------------------------------------------------------ */
{
	reset();
	const big = await post(JSON.stringify({ ...INIT, params: { ...INIT.params, pad: "x".repeat(5000) } }), bearer(GOOD_KEY));
	check("a body over the limit is 413", big.status === 413, String(big.status));
	const bad = await post("{not json", bearer(GOOD_KEY));
	const badBody = await bad.json();
	check("a non-JSON body is 400 with -32700", bad.status === 400 && badBody.error?.code === -32700, String(bad.status));
	const text = await fetch(MCP, { method: "POST", headers: { ...bearer(GOOD_KEY), "content-type": "text/plain" }, body: "hi" });
	check("a non-JSON content type is 415", text.status === 415, String(text.status));
}

/* ------------------------------------------------------------------ */
section("6. the full run: discover -> read -> inquiry, over HTTP");
/* ------------------------------------------------------------------ */
{
	reset();
	const client = await connectHttp(GOOD_KEY);

	const info = await client.callTool({ name: "platform_info", arguments: {} });
	check("platform_info answers with the disclaimer", info.structuredContent?.disclaimer === DISCLAIMER);

	const news = await client.callTool({ name: "get_news", arguments: { limit: 5 } });
	const items = news.structuredContent?.articles ?? [];
	check("get_news relays the stub's article", Array.isArray(items) && items.length === 1 && items[0].slug === "tokenization-week", JSON.stringify(news.structuredContent).slice(0, 200));

	const art = await client.callTool({ name: "get_article", arguments: { slug: "tokenization-week" } });
	check("get_article returns the body as text", art.isError !== true && JSON.stringify(art.structuredContent).includes("Body text"), JSON.stringify(art.structuredContent).slice(0, 200));

	const filed = await client.callTool({
		name: "file_sponsor_inquiry",
		arguments: {
			principal_name: "Pat Example",
			principal_email: "pat@example.com",
			principal_phone: "+1 555 0100",
			message: "We control a 12 MW facility and want to discuss tokenizing it.",
			agent_name: "test-agent",
			agent_url: "https://agent.example/about",
			operator: "Example Operator",
		},
	});
	const p = filed.structuredContent;
	check("the inquiry is filed with an id", filed.isError !== true && p?.inquiry?.id === "inq_1", JSON.stringify(p?.error));
	check("the inquiry envelope carries the disclaimer and a source_url", p?.disclaimer === DISCLAIMER && p?.source_url === `${UPSTREAM}/contact`);
	const sent = contactBodies[0];
	check("the stub got type=desk persona=Sponsor", sent?.body.type === "desk" && sent?.body.persona === "Sponsor");
	check("the stub got the agent attribution verbatim", JSON.stringify(sent?.body.agent) === JSON.stringify({ name: "test-agent", url: "https://agent.example/about", operator: "Example Operator" }), JSON.stringify(sent?.body.agent));
	check("the stub got the principal's details", sent?.body.fullName === "Pat Example" && sent?.body.email === "pat@example.com" && sent?.body.phone === "+1 555 0100");
	check("no credential was sent to /contact", sent?.auth === null && sent?.key === null, JSON.stringify({ auth: sent?.auth, key: sent?.key }));
	check("no surface claim was sent (the inquiry is neither chat nor form)", !("surface" in sent.body));

	// Validation stays on OUR side first: an http:// agent_url never reaches
	// the API. (Every tools/call for the inquiry spends an inquiry slot, valid
	// or not — attempts are what the ceiling counts — so the window is reset
	// between the sub-cases below; section 4 is where the ceiling is tested.)
	inquiryLimiter.reset();
	verifyLimiter.reset();
	introspectSecrets = [];
	const badUrl = await client.callTool({
		name: "file_sponsor_inquiry",
		arguments: { principal_name: "Pat Example", principal_email: "pat@example.com", principal_phone: "+1 555 0100", message: "Ten characters at least.", agent_name: "a", agent_url: "http://insecure.example" },
	});
	check("an http:// agent_url is refused before any upstream call", badUrl.isError === true && contactBodies.length === 1, String(contactBodies.length));

	// An upstream 400 is relayed as non-retryable with the field named.
	contactMode = "reject";
	inquiryLimiter.reset();
	verifyLimiter.reset();
	introspectSecrets = [];
	const rejected = await client.callTool({
		name: "file_sponsor_inquiry",
		arguments: { principal_name: "Pat Example", principal_email: "pat@example.com", principal_phone: "+1 555 0100", message: "Ten characters at least.", agent_name: "a" },
	});
	const re = rejected.structuredContent?.error;
	check("an upstream 400 is a non-retryable error naming the field", rejected.isError === true && re?.retryable === false && /phone/.test(re?.message ?? ""), JSON.stringify(re));
	check("the refused inquiry envelope has inquiry=null", rejected.structuredContent?.inquiry === null);

	// An upstream 429 is retryable and carries the interval.
	contactMode = "throttle";
	inquiryLimiter.reset();
	verifyLimiter.reset();
	introspectSecrets = [];
	const throttled = await client.callTool({
		name: "file_sponsor_inquiry",
		arguments: { principal_name: "Pat Example", principal_email: "pat@example.com", principal_phone: "+1 555 0100", message: "Ten characters at least.", agent_name: "a" },
	});
	const te = throttled.structuredContent?.error;
	check("an upstream 429 is retryable and names the interval", throttled.isError === true && te?.retryable === true && /1800/.test(te?.message ?? ""), JSON.stringify(te));

	await client.close();
}

/* ------------------------------------------------------------------ */
section("7. the log carries no secret");
/* ------------------------------------------------------------------ */
{
	const all = JSON.stringify(events);
	check("events were captured", events.length > 20, String(events.length));
	check("no event contains the key", !all.includes(GOOD_KEY) && !all.includes(OTHER_KEY));
	check("no event contains the secret half", !all.includes(SECRET));
	check("no event contains an Authorization value", !/Bearer /.test(all));
	check("events carry the public key id", events.some((e) => e.key_id === KEY_ID));
	const req = events.filter((e) => e.event === "request");
	check("every request event has method, path, status, outcome, ms", req.every((e) => typeof e.method === "string" && typeof e.path === "string" && typeof e.status === "number" && typeof e.outcome === "string" && typeof e.ms === "number"));
	check("no event carries a body or principal email", !all.includes("pat@example.com") && !all.includes("12 MW"));
}

server.close();
upstream.close();
process.exit(summary("http e2e") === 0 ? 0 : 1);
