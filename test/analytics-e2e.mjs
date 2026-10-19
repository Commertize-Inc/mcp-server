/**
 * PostHog analytics for `/mcp/public` (src/analytics.ts), offline.
 *
 *   1. OFF BY DEFAULT. Only COMMERTIZE_MCP_ANALYTICS="1" + a well-formed phc_
 *      key + an https host turn it on; anything else returns no sink.
 *   2. ALLOWLISTED PROPERTIES ONLY. A log event carrying a key id, an IP, an
 *      Authorization value or a message produces a capture with none of them.
 *   3. ANONYMOUS. Constant distinct_id, no person profile, GeoIP off.
 *   4. BEST EFFORT. A throwing or hanging PostHog never throws into, fails or
 *      delays the request; the response is written before the send starts.
 *   5. END TO END through the real public handler: a successful call, a tool
 *      error (machine code only), and a refused tool each produce one capture.
 *   6. STDIO NEVER IMPORTS IT.
 *   7-10. DELTA 2026-10-19 F-1: five events, per-event allowlists, closed-set
 *      src / client / protocol / keyed tool name, auth failures carry the code
 *      only, x402_payment dark, end to end on both surfaces.
 */

import { readFile } from "node:fs/promises";
import { createServer as createNodeServer } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { check, resetCounters, section, summary } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "..", "dist");

const ARTICLES = [{ slug: "a1", title: "T", summary: "S", category: "C", publishedAt: "2026-10-01T00:00:00.000Z", readTime: 1, imageUrl: null, content: "<p>x</p>" }];
const upstream = createNodeServer((req, res) => {
	const url = new URL(req.url, "http://stub");
	const json = (s, b) => {
		res.writeHead(s, { "content-type": "application/json" });
		res.end(JSON.stringify(b));
	};
	if (url.pathname === "/api/news") return json(200, { data: ARTICLES });
	if (url.pathname.startsWith("/api/news/")) return json(404, { error: "Article not found" });
	res.writeHead(404).end();
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
process.env.COMMERTIZE_API_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;

const { analyticsConfigFrom, createAnalyticsSink, toCapture, uaProductOf, ANALYTICS_DISTINCT_ID, ANALYTICS_EVENT } = await import(path.join(DIST, "analytics.js"));
const { createPublicHttpHandler } = await import(path.join(DIST, "httpPublic.js"));
const { FixedWindowLimiter } = await import(path.join(DIST, "httpRateLimit.js"));
const { createServer } = await import(path.join(DIST, "index.js"));

const KEY = "phc_" + "a1B2c3D4e5".repeat(4);
const ON = { COMMERTIZE_MCP_ANALYTICS: "1", COMMERTIZE_MCP_POSTHOG_KEY: KEY };

resetCounters();

section("1. off by default, fail-closed parse");
{
	const on = (env) => analyticsConfigFrom(env, "t").enabled;
	check("empty env -> off", on({}) === false);
	check("key but no opt-in -> off", on({ COMMERTIZE_MCP_POSTHOG_KEY: KEY }) === false);
	for (const v of ["true", "yes", " 1", "01", ""]) check(`opt-in ${JSON.stringify(v)} -> off`, on({ ...ON, COMMERTIZE_MCP_ANALYTICS: v }) === false);
	check("opt-in but no key -> off", on({ COMMERTIZE_MCP_ANALYTICS: "1" }) === false);
	for (const k of ["phx_" + "a".repeat(40), "phc_short", "phc_" + "a".repeat(30) + " x", "sk_live_" + "a".repeat(40)]) check(`malformed key ${k.slice(0, 8)}… -> off`, on({ ...ON, COMMERTIZE_MCP_POSTHOG_KEY: k }) === false);
	check("http host -> off", on({ ...ON, COMMERTIZE_MCP_POSTHOG_HOST: "http://us.i.posthog.com" }) === false);
	check("host with credentials -> off", on({ ...ON, COMMERTIZE_MCP_POSTHOG_HOST: "https://u:p@us.i.posthog.com" }) === false);
	check("garbage host -> off", on({ ...ON, COMMERTIZE_MCP_POSTHOG_HOST: "not a url" }) === false);
	check("opt-in + phc key + default host -> on", on(ON) === true);
	check("default host is us.i.posthog.com", analyticsConfigFrom(ON, "t").host === "https://us.i.posthog.com");
	check("off -> no sink at all", createAnalyticsSink(analyticsConfigFrom({}, "t")) === null);
}

section("2-3. allowlisted, anonymous capture");
{
	const evt = {
		ts: "2026-10-15T20:00:00.000Z",
		event: "public_request",
		method: "POST",
		path: "/mcp/public",
		rpc: ["tools/call"],
		tool: "get_news",
		client_name: "claude-code",
		client_version: "1.2.3",
		status: 200,
		outcome: "ok",
		error_code: null,
		ms: 42,
		// none of these may leave:
		key_id: "0123456789abcdef",
		ip: "203.0.113.9",
		authorization: "Bearer cfa_x",
		message: "free text",
		args: { slug: "secret" },
	};
	const c = toCapture(evt, { apiKey: KEY, serverVersion: "0.1.0" });
	check("event name", c.event === ANALYTICS_EVENT && ANALYTICS_EVENT === "mcp_tool_call");
	check("constant distinct_id", c.distinct_id === ANALYTICS_DISTINCT_ID && ANALYTICS_DISTINCT_ID === "commertize-mcp-server");
	const keys = Object.keys(c.properties).sort();
	const ALLOWED = ["$geoip_disable", "$process_person_profile", "client_name", "client_version", "error_code", "http_status", "latency_ms", "outcome", "server_version", "src", "surface", "tool", "transport"].sort();
	check("property keys are exactly the allowlist", JSON.stringify(keys) === JSON.stringify(ALLOWED), keys.join(","));
	check("top-level keys are exactly api_key/event/distinct_id/timestamp/properties", JSON.stringify(Object.keys(c).sort()) === JSON.stringify(["api_key", "distinct_id", "event", "properties", "timestamp"]));
	check("no person profile, GeoIP off", c.properties.$process_person_profile === false && c.properties.$geoip_disable === true);
	const blob = JSON.stringify(c);
	check("no key id, IP, credential, message or argument leaks", !/0123456789abcdef|203\.0\.113|Bearer|cfa_|free text|secret/.test(blob));
	check("values carried", c.properties.tool === "get_news" && c.properties.latency_ms === 42 && c.properties.http_status === 200 && c.properties.client_name === "claude-code");
	check("non-tool events produce nothing", toCapture({ ...evt, tool: null }, { apiKey: KEY, serverVersion: "x" }) === null);
	const keyed = toCapture({ ...evt, event: "request" }, { apiKey: KEY, serverVersion: "x" });
	check("keyed-surface tool call: transport http_keyed, surface keyed, no key id", keyed?.properties.transport === "http_keyed" && keyed.properties.surface === "keyed" && !JSON.stringify(keyed).includes("0123456789abcdef"));
	check("other log events (tool_refused, error) produce nothing", toCapture({ ...evt, event: "tool_refused" }, { apiKey: KEY, serverVersion: "x" }) === null && toCapture({ ...evt, event: "error" }, { apiKey: KEY, serverVersion: "x" }) === null);

	check("uaProductOf: first product token", JSON.stringify(uaProductOf("claude-code/1.2.3 (darwin; arm64)")) === JSON.stringify({ name: "claude-code", version: "1.2.3" }));
	check("uaProductOf: no version", JSON.stringify(uaProductOf("node")) === JSON.stringify({ name: "node", version: null }));
	check("uaProductOf: junk -> unknown", ["<x>/1", "", null, "a b/1".replace(" ", "\u0000")].every((u) => uaProductOf(u).name === "unknown"));
}

section("2a. T5-S1 disclosure (AXIOM apx-00aee28eb6) matches what is sent");
{
	const { ANALYTICS_DISCLOSURE, ANALYTICS_DISCLOSURE_ID } = await import(path.join(DIST, "analytics.js"));
	const { createHash } = await import("node:crypto");
	const id = "apx-" + createHash("sha1").update(ANALYTICS_DISCLOSURE, "utf8").digest("hex").slice(0, 10);
	check("disclosure hashes to apx-00aee28eb6", id === "apx-00aee28eb6" && ANALYTICS_DISCLOSURE_ID === id, id);
	// Each named field, mapped to the capture key that carries it. A field the
	// text names but the capture lacks, or a capture key the text omits, fails.
	const NAMED = {
		"the tool name": "tool",
		"the client application's name and version": ["client_name", "client_version"],
		"the transport": "transport",
		"the outcome": "outcome",
		"any error code": "error_code",
		"the HTTP status": "http_status",
		"the response time": "latency_ms",
		"the server version": "server_version",
	};
	const c = toCapture({ ts: "t", event: "public_request", tool: "get_news", status: 200, outcome: "ok", error_code: null, ms: 1, client_name: "node", client_version: "1" }, { apiKey: KEY, serverVersion: "0.1.0" });
	const covered = new Set(Object.values(NAMED).flat());
	check("every field the disclosure names is in the text", Object.keys(NAMED).every((p) => ANALYTICS_DISCLOSURE.includes(p)));
	check("every named field is a capture key", [...covered].every((k) => k in c.properties));
	// surface and src (DELTA F-1, 2026-10-19) are NOT in T5-S1 yet: AXIOM must re-certify
	// the disclosure before COMMERTIZE_MCP_ANALYTICS=1. Named here so the gap is explicit;
	// any OTHER uncovered key still fails.
	const PENDING_RECERT = new Set(["surface", "src"]);
	const nonPrivate = Object.keys(c.properties).filter((k) => !k.startsWith("$") && !PENDING_RECERT.has(k));
	check("every non-$ capture key is named by the disclosure", nonPrivate.every((k) => covered.has(k)), nonPrivate.filter((k) => !covered.has(k)).join(","));
	const readme = await readFile(path.join(HERE, "..", "README.md"), "utf8");
	check("not in the README while the flag is off by default (ships with the flag)", !readme.includes(ANALYTICS_DISCLOSURE));
}

section("2b. AEGIS F5-1: client name and version leave only as a closed set");
{
	const base = { ts: "t", event: "public_request", tool: "get_news", status: 200, outcome: "ok", error_code: null, ms: 1 };
	const cap = (name, version) => toCapture({ ...base, client_name: name, client_version: version }, { apiKey: KEY, serverVersion: "0.1.0" }).properties;
	// Pinned here as literals, never read back from the module.
	const FAMILIES = ["claude-ai", "claude-code", "cursor", "vscode", "windsurf", "openai-mcp", "chatgpt", "mcp-inspector", "python-httpx", "node", "curl"];
	const ident = cap("jane.doe.acme-corp.com", "1.0");
	check("AEGIS PoC: a hostname-shaped token becomes 'other'", ident.client_name === "other", ident.client_name);
	check("…and its version is dropped", ident.client_version === null, String(ident.client_version));
	for (const t of ["acme-corp", "jane.doe", "my-org-agent", "Bearer", "x".repeat(40)]) {
		check(`'${t.slice(0, 20)}' -> other`, cap(t, "1.0").client_name === "other");
	}
	check("every known family passes through as itself", FAMILIES.every((f) => cap(f, "1.2.3").client_name === f));
	check("case-blind: 'Claude-Code' -> claude-code", cap("Claude-Code", "1.2.3").client_name === "claude-code");
	check("a family prefix keeps only the family: 'cursor-vscode' -> cursor", cap("cursor-vscode", "1.0").client_name === "cursor");
	check("a family name embedded later is not a match: 'acme-cursor' -> other", cap("acme-cursor", "1.0").client_name === "other");
	check("unknown stays unknown", cap("unknown", null).client_name === "unknown" && cap(null, null).client_name === "unknown");
	check("known family keeps a numeric version", cap("claude-code", "2.0.14").client_version === "2.0.14");
	for (const v of ["1.2.3-beta", "1.2.3+jane", "v1", "1.2.3.4.5", "abc"]) {
		check(`version '${v}' is dropped`, cap("claude-code", v).client_version === null);
	}
}

section("4. best effort: never throws, bounded by a timeout");
{
	const cfg = { ...analyticsConfigFrom(ON, "t"), timeoutMs: 80 };
	const posted = [];
	const ok = createAnalyticsSink(cfg, async (url, init) => {
		posted.push({ url, body: JSON.parse(init.body), method: init.method });
		return { ok: true };
	});
	await ok({ event: "public_request", tool: "get_news", ts: "t", status: 200, ms: 1, outcome: "ok" });
	check("posts once to {host}/i/v0/e/", posted.length === 1 && posted[0].url === "https://us.i.posthog.com/i/v0/e/" && posted[0].method === "POST");
	await ok({ event: "public_request", tool: null });
	check("a non-tool event is not posted", posted.length === 1);

	const throwing = createAnalyticsSink(cfg, async () => {
		throw new Error("network down");
	});
	let threw = false;
	try {
		await throwing({ event: "public_request", tool: "get_news" });
	} catch {
		threw = true;
	}
	check("a throwing PostHog does not throw", !threw);

	const hanging = createAnalyticsSink(cfg, (_u, init) => new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")))));
	const t0 = Date.now();
	await hanging({ event: "public_request", tool: "get_news" });
	const took = Date.now() - t0;
	check("a hanging PostHog is cut off by the timeout", took >= 60 && took < 1000, `${took} ms`);
}

section("5. end to end through the public handler");
{
	const captured = [];
	let releaseSend;
	const gate = new Promise((r) => (releaseSend = r));
	let responseSeenBeforeSendFinished = null;
	const sink = createAnalyticsSink({ ...analyticsConfigFrom(ON, "0.1.0"), timeoutMs: 2000 }, async (_u, init) => {
		captured.push(JSON.parse(init.body));
		await gate; // hold the "network" until the test releases it
		return { ok: true };
	});
	const handler = createPublicHttpHandler({
		enabled: () => true,
		ipLimiter: new FixedWindowLimiter(100, 60_000),
		createServer: (onToolResult) => createServer("public", onToolResult),
		log: () => {},
		maxBodyBytes: 4096,
		afterResponse: sink,
	});
	const srv = createNodeServer((req, res) => void handler(req, res));
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	const URLP = `http://127.0.0.1:${srv.address().port}/mcp/public`;
	const call = (name, args = {}) =>
		fetch(URLP, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": "claude-code/9.9.9 (test)", "x-vercel-forwarded-for": "198.51.100.77" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
		});

	const r1 = await call("get_news");
	responseSeenBeforeSendFinished = r1.status === 200 && captured.length === 1;
	check("the response arrives while the PostHog send is still pending", responseSeenBeforeSendFinished, `${r1.status} ${captured.length}`);
	releaseSend();
	await r1.text();
	await call("get_article", { slug: "missing" }).then((r) => r.text());
	await call("list_offerings").then((r) => r.text());
	await new Promise((r) => setTimeout(r, 50));

	check("three calls -> three captures", captured.length === 3, String(captured.length));
	const [a, b, c] = captured.map((x) => x.properties);
	check("success: tool, outcome ok, no error code, UA client", a.tool === "get_news" && a.outcome === "ok" && a.error_code === null && a.client_name === "claude-code" && a.client_version === "9.9.9" && a.transport === "http_public");
	check("tool error: the envelope's machine code only", b.tool === "get_article" && b.error_code === "NOT_FOUND", JSON.stringify(b));
	check("refused tool: fixed token, outcome tool_refused, 403", c.tool === "(refused)" && c.outcome === "tool_refused" && c.http_status === 403, JSON.stringify(c));
	check("latency is a number", [a, b, c].every((p) => typeof p.latency_ms === "number"));
	const blob = JSON.stringify(captured);
	check("no IP or slug in any capture", !blob.includes("198.51.100.77") && !blob.includes("missing"));

	// AEGIS F5-1 PoC, end to end: the identifying User-Agent never leaves.
	const before = captured.length;
	await fetch(URLP, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": "jane.doe.acme-corp.com/1.0 (Macintosh; jane@acme.com)", "x-vercel-forwarded-for": "198.51.100.78" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_news", arguments: {} } }),
	}).then((r) => r.text());
	await new Promise((r) => setTimeout(r, 50));
	const leak = captured.slice(before);
	check("identifying UA: one capture, client_name 'other', version null", leak.length === 1 && leak[0].properties.client_name === "other" && leak[0].properties.client_version === null, JSON.stringify(leak.map((x) => x.properties)));
	check("identifying UA: no 'jane' or 'acme' anywhere in the body", !/jane|acme/i.test(JSON.stringify(leak)));

	const broken = createPublicHttpHandler({
		enabled: () => true,
		ipLimiter: new FixedWindowLimiter(100, 60_000),
		createServer: (o) => createServer("public", o),
		log: () => {},
		maxBodyBytes: 4096,
		afterResponse: async () => {
			throw new Error("sink exploded");
		},
	});
	const srv2 = createNodeServer((req, res) => void broken(req, res));
	await new Promise((r) => srv2.listen(0, "127.0.0.1", r));
	const r2 = await fetch(`http://127.0.0.1:${srv2.address().port}/mcp/public`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_news", arguments: {} } }),
	});
	check("a sink that throws does not change the response", r2.status === 200 && Array.isArray((await r2.json()).result?.structuredContent?.articles));
	srv.close();
	srv2.close();
}

section("6. stdio never imports analytics");
{
	const idx = await readFile(path.join(HERE, "..", "src", "index.ts"), "utf8");
	const tools = await readFile(path.join(HERE, "..", "src", "tools.ts"), "utf8");
	check("index.ts does not import analytics", !/from "\.\/analytics\.js"/.test(idx));
	check("tools.ts does not import analytics", !/from "\.\/analytics\.js"/.test(tools));
}


/*
 * DELTA listing handoff 2026-10-19 F-1: mcp_initialize, mcp_tools_list,
 * mcp_tool_call on both surfaces, mcp_auth_failure, x402_payment (dark), and
 * the closed-set `src`. Allowlists are pinned here as literals.
 */
const mod = await import(path.join(DIST, "analytics.js"));
const PRIV = ["$geoip_disable", "$process_person_profile"];
const KEYSETS = {
	mcp_initialize: ["client_family", "client_version", "protocol_version", "server_version", "src", "surface", ...PRIV].sort(),
	mcp_tools_list: ["client_family", "outcome", "server_version", "src", "surface", ...PRIV].sort(),
	mcp_tool_call: ["client_name", "client_version", "error_code", "http_status", "latency_ms", "outcome", "server_version", "src", "surface", "tool", "transport", ...PRIV].sort(),
	mcp_auth_failure: ["error_code", "http_status", "surface", ...PRIV].sort(),
	x402_payment: ["amount_usdc_band", "error_code", "outcome", "resource_id", "server_version", "stage", ...PRIV].sort(),
};
const SECRETS = ["kid-SECRET-0001", "cfa_SECRETKEY", "203.0.113.50", "Mozilla/5.0 SECRETUA", "slug-secret", "prompt-secret", "0xPAYERSECRET", "0xTXHASHSECRET", "nonce-secret"];
const noSecrets = (caps) => {
	const blob = JSON.stringify(caps);
	return SECRETS.every((s) => !blob.includes(s));
};
const CFG = { apiKey: KEY, serverVersion: "0.1.0" };

section("7. F-1: each event's key set equals its allowlist; constant anonymous id");
{
	const base = {
		ts: "2026-10-19T20:00:00.000Z",
		status: 200,
		outcome: "ok",
		ms: 5,
		client_name: "claude-code",
		client_version: "2.0.1",
		protocol_version: "2025-06-18",
		src: "glama",
		// none of these may leave:
		key_id: "kid-SECRET-0001",
		authorization: "Bearer cfa_SECRETKEY",
		ip: "203.0.113.50",
		user_agent: "Mozilla/5.0 SECRETUA",
		args: { slug: "slug-secret", prompt: "prompt-secret" },
	};
	const pub = mod.toCaptures({ ...base, event: "public_request", rpc: ["initialize", "tools/list", "tools/call"], tool: "get_news" }, CFG);
	check("public: initialize + tools/list + tool call -> three captures", pub.length === 3, pub.map((c) => c.event).join(","));
	const keyed = mod.toCaptures({ ...base, event: "request", rpc: ["initialize", "tools/list", "tools/call"], tool: "get_news" }, CFG);
	check("keyed: the same three", keyed.length === 3, keyed.map((c) => c.event).join(","));
	const auth = mod.toCaptures({ ...base, event: "request", status: 401, outcome: "missing_credential", rpc: [], tool: null }, CFG);
	check("keyed 401 missing_credential -> exactly one mcp_auth_failure", auth.length === 1 && auth[0].event === "mcp_auth_failure");
	const x = mod.toX402Capture({ ts: "t", stage: "quote", resourceId: "res-1", knownResourceIds: ["res-1"], amountUsdc: "0.5", outcome: "ok", errorCode: null, payer: "0xPAYERSECRET", txHash: "0xTXHASHSECRET", nonce: "nonce-secret" }, CFG);
	for (const c of [...pub, ...keyed, ...auth, x]) {
		const keys = Object.keys(c.properties).sort();
		check(`${c.event} (${c.properties.surface ?? "-"}): key set = allowlist`, JSON.stringify(keys) === JSON.stringify(KEYSETS[c.event]), keys.join(","));
		check(`${c.event}: top-level keys fixed, constant distinct_id`, JSON.stringify(Object.keys(c).sort()) === JSON.stringify(["api_key", "distinct_id", "event", "properties", "timestamp"]) && c.distinct_id === "commertize-mcp-server");
		check(`${c.event}: no person profile, GeoIP off`, c.properties.$process_person_profile === false && c.properties.$geoip_disable === true);
	}
	check("no key id, key, IP, raw UA, slug, prompt, payer, tx hash or nonce in any capture", noSecrets([...pub, ...keyed, ...auth, x]));
	check("auth failure carries no key_id property and no key prefix", !("key_id" in auth[0].properties) && !JSON.stringify(auth[0]).includes("cfa_"));
	check("auth failure: error code + status only", auth[0].properties.error_code === "missing_credential" && auth[0].properties.http_status === 401 && auth[0].properties.surface === "keyed");
	check("initialize values carried", pub[0].properties.client_family === "claude-code" && pub[0].properties.protocol_version === "2025-06-18" && pub[0].properties.src === "glama");
	check("a refused or 4xx initialize is not counted as a connect", mod.toCaptures({ ...base, event: "public_request", status: 400, outcome: "batch_refused", rpc: ["initialize"], tool: null }, CFG).length === 0);
	check("unknown log events produce nothing", mod.toCaptures({ ...base, event: "tool_refused", rpc: ["initialize"] }, CFG).length === 0);
}

section("8. closed sets: hostile clientInfo.name, src, protocol version, keyed tool name, auth code");
{
	const ev = (o) => mod.toCaptures({ ts: "t", event: "public_request", status: 200, outcome: "ok", rpc: ["initialize"], tool: null, ...o }, CFG)[0].properties;
	check("PoC hostile clientInfo.name -> other", ev({ client_name: "jane.doe.acme-corp.com" }).client_family === "other");
	for (const s of ["glama", "smithery", "mcp-registry", "anthropic", "pulsemcp", "mcpso", "site", "none"]) check(`src '${s}' passes`, ev({ src: s }).src === s);
	for (const s of ["jane@acme.com", "GLAMA", "glama ", "x".repeat(200), "../etc"]) check(`hostile src '${s.slice(0, 16)}' -> other`, ev({ src: s }).src === "other");
	check("missing src -> none", ev({}).src === "none");
	check("srcOf: from URL query", mod.srcOf("/mcp/public?src=smithery") === "smithery" && mod.srcOf("/mcp/public?src=evil.example") === "other" && mod.srcOf("/mcp/public") === "none" && mod.srcOf("/mcp/public?src=") === "none");
	check("srcOf: repeated param takes the first, still closed-set", mod.srcOf("/mcp/public?src=glama&src=jane") === "glama");
	check("protocol version: date passes, junk -> other, absent -> null", mod.protocolVersionOf("2025-06-18") === "2025-06-18" && mod.protocolVersionOf("jane@acme") === "other" && mod.protocolVersionOf(undefined) === null);
	const kt = mod.toCaptures({ ts: "t", event: "request", status: 403, outcome: "tool_refused", rpc: ["tools/call"], tool: "jane.doe.secret-tool" }, CFG);
	check("keyed: a caller-chosen unknown tool name leaves as '(refused)'", kt.length === 1 && kt[0].properties.tool === "(refused)", JSON.stringify(kt[0]?.properties));
	check("keyed: an allowlisted tool name passes", mod.toCaptures({ ts: "t", event: "request", status: 200, outcome: "ok", rpc: ["tools/call"], tool: "get_news" }, CFG)[0].properties.tool === "get_news");
	check("keyed: an outcome outside the auth set is not an auth failure", mod.toCaptures({ ts: "t", event: "request", status: 415, outcome: "unsupported_media_type", rpc: [], tool: null }, CFG).length === 0);
	for (const code of ["missing_credential", "malformed_credential", "invalid_credential", "verifier_unavailable", "verifier_not_configured", "rate_limited", "verify_rate_limited"]) {
		const c = mod.toCaptures({ ts: "t", event: "request", status: 401, outcome: code, rpc: [], tool: null }, CFG);
		check(`auth code ${code} -> mcp_auth_failure`, c.length === 1 && c[0].event === "mcp_auth_failure" && c[0].properties.error_code === code);
	}
	check("public 429 is NOT an auth failure (public has no auth)", mod.toCaptures({ ts: "t", event: "public_request", status: 429, outcome: "rate_limited", rpc: [], tool: null }, CFG).length === 0);
}

section("9. x402_payment ships dark and banded");
{
	const xc = (o) => mod.toX402Capture({ ts: "t", stage: "quote", resourceId: "res-1", knownResourceIds: ["res-1"], amountUsdc: "0.5", outcome: "ok", errorCode: null, ...o }, CFG).properties;
	check("bands: 0.5 -> <1, 1 -> 1-10, 10 -> 1-10, 10.01 -> >10", xc({ amountUsdc: "0.5" }).amount_usdc_band === "<1" && xc({ amountUsdc: "1" }).amount_usdc_band === "1-10" && xc({ amountUsdc: "10" }).amount_usdc_band === "1-10" && xc({ amountUsdc: "10.01" }).amount_usdc_band === ">10");
	check("junk amount -> null band", xc({ amountUsdc: "1e9" }).amount_usdc_band === null && xc({ amountUsdc: "-1" }).amount_usdc_band === null);
	check("unknown resource id -> other; unknown stage -> other", xc({ resourceId: "0xPAYERSECRET" }).resource_id === "other" && xc({ stage: "refund" }).stage === "other");
	const http = await readFile(path.join(HERE, "..", "src", "httpAllowlist.ts"), "utf8");
	check("dark: no x402 tool is on the HTTP allowlist", !/"x402_/.test(http.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
	const x402src = await readFile(path.join(HERE, "..", "src", "x402Tools.ts"), "utf8");
	check("dark: x402Tools.ts does not import analytics (no emit path today)", !/from "\.\/analytics\.js"/.test(x402src));
}

section("10. end to end: initialize/tools-list with ?src= on /mcp/public, auth failure on keyed /mcp");
{
	const captured = [];
	const sink = createAnalyticsSink({ ...analyticsConfigFrom(ON, "0.1.0"), timeoutMs: 2000 }, async (_u, init) => {
		captured.push(JSON.parse(init.body));
		return { ok: true };
	});
	const handler = createPublicHttpHandler({
		enabled: () => true,
		ipLimiter: new FixedWindowLimiter(100, 60_000),
		createServer: (onToolResult) => createServer("public", onToolResult),
		log: () => {},
		maxBodyBytes: 4096,
		afterResponse: sink,
	});
	const srv = createNodeServer((req, res) => void handler(req, res));
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${srv.address().port}/mcp/public`;
	const H = { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": "Mozilla/5.0 SECRETUA", "x-vercel-forwarded-for": "203.0.113.50" };
	const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cursor", version: "1.7.0" } } };
	let r = await fetch(`${base}?src=glama`, { method: "POST", headers: H, body: JSON.stringify(init) });
	check("initialize with ?src=glama answers 200 (query does not break routing)", r.status === 200, String(r.status));
	await r.text();
	r = await fetch(`${base}?src=smithery`, { method: "POST", headers: H, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) });
	await r.text();
	r = await fetch(`${base}?src=jane%40acme.com`, { method: "POST", headers: H, body: JSON.stringify({ ...init, params: { ...init.params, clientInfo: { name: "jane.doe.acme-corp.com", version: "1.0" } } }) });
	await r.text();
	await new Promise((res) => setTimeout(res, 50));
	const [i1, l1, i2] = captured;
	check("three captures in order", captured.map((c) => c.event).join(",") === "mcp_initialize,mcp_tools_list,mcp_initialize", captured.map((c) => c.event).join(","));
	check("initialize: cursor/1.7.0, 2025-06-18, src glama, surface public", i1?.properties.client_family === "cursor" && i1.properties.client_version === "1.7.0" && i1.properties.protocol_version === "2025-06-18" && i1.properties.src === "glama" && i1.properties.surface === "public");
	check("tools/list: src smithery, outcome ok", l1?.properties.src === "smithery" && l1.properties.outcome === "ok");
	check("hostile clientInfo + src end to end -> other/other, version dropped", i2?.properties.client_family === "other" && i2.properties.src === "other" && i2.properties.client_version === null);
	check("no IP, raw UA or 'jane'/'acme' in any capture", noSecrets(captured) && !/jane|acme/i.test(JSON.stringify(captured)));
	srv.close();

	const { createHttpHandler } = await import(path.join(DIST, "httpServer.js"));
	const kcap = [];
	const ksink = createAnalyticsSink({ ...analyticsConfigFrom(ON, "0.1.0"), timeoutMs: 2000 }, async (_u, init2) => {
		kcap.push(JSON.parse(init2.body));
		return { ok: true };
	});
	const fakeVerifier = {
		configured: true,
		isCached: () => true,
		verify: async (p) =>
			p === "cfa_SECRETKEY"
				? { ok: true, keyId: "kid-SECRET-0001", cached: true }
				: p
					? { ok: false, status: 401, code: "invalid_credential", message: "x", cached: true }
					: { ok: false, status: 401, code: "missing_credential", message: "x", cached: true },
	};
	const keyedHandler = createHttpHandler({
		verifier: fakeVerifier,
		requestLimiter: new FixedWindowLimiter(100, 60_000),
		inquiryLimiter: new FixedWindowLimiter(2, 60_000),
		verifyLimiter: new FixedWindowLimiter(100, 60_000),
		createServer: () => createServer("http"),
		log: () => {},
		maxBodyBytes: 4096,
		version: "0.1.0",
		afterResponse: ksink,
	});
	const ksrv = createNodeServer((req, res) => void keyedHandler(req, res));
	await new Promise((res) => ksrv.listen(0, "127.0.0.1", res));
	const kurl = `http://127.0.0.1:${ksrv.address().port}/mcp?src=anthropic`;
	const call = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_news", arguments: {} } };
	await (await fetch(kurl, { method: "POST", headers: H, body: JSON.stringify(call) })).text();
	await (await fetch(kurl, { method: "POST", headers: { ...H, authorization: "Bearer cfa_WRONGSECRETKEY" }, body: JSON.stringify(call) })).text();
	await (await fetch(kurl, { method: "POST", headers: { ...H, authorization: "Bearer cfa_SECRETKEY" }, body: JSON.stringify(call) })).text();
	await (await fetch(`http://127.0.0.1:${ksrv.address().port}/health`)).text();
	await new Promise((res) => setTimeout(res, 50));
	check("keyed: missing, invalid, ok, /health -> auth_failure, auth_failure, tool_call (health sends nothing)", kcap.map((c) => c.event).join(",") === "mcp_auth_failure,mcp_auth_failure,mcp_tool_call", kcap.map((c) => c.event).join(","));
	check("keyed auth failures carry the code only", kcap[0]?.properties.error_code === "missing_credential" && kcap[1]?.properties.error_code === "invalid_credential" && kcap.slice(0, 2).every((c) => !("key_id" in c.properties)));
	check("keyed tool call: surface keyed, src anthropic, transport http_keyed", kcap[2]?.properties.surface === "keyed" && kcap[2].properties.src === "anthropic" && kcap[2].properties.transport === "http_keyed");
	check("keyed: no key id, key, wrong key, IP or raw UA in any capture", noSecrets(kcap) && !JSON.stringify(kcap).includes("WRONGSECRET"));
	ksrv.close();
}
upstream.close();
process.exit(summary("analytics e2e") === 0 ? 0 : 1);
