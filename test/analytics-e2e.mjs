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
	const ALLOWED = ["$geoip_disable", "$process_person_profile", "client_name", "client_version", "error_code", "http_status", "latency_ms", "outcome", "server_version", "tool", "transport"].sort();
	check("property keys are exactly the allowlist", JSON.stringify(keys) === JSON.stringify(ALLOWED), keys.join(","));
	check("top-level keys are exactly api_key/event/distinct_id/timestamp/properties", JSON.stringify(Object.keys(c).sort()) === JSON.stringify(["api_key", "distinct_id", "event", "properties", "timestamp"]));
	check("no person profile, GeoIP off", c.properties.$process_person_profile === false && c.properties.$geoip_disable === true);
	const blob = JSON.stringify(c);
	check("no key id, IP, credential, message or argument leaks", !/0123456789abcdef|203\.0\.113|Bearer|cfa_|free text|secret/.test(blob));
	check("values carried", c.properties.tool === "get_news" && c.properties.latency_ms === 42 && c.properties.http_status === 200 && c.properties.client_name === "claude-code");
	check("non-tool events produce nothing", toCapture({ ...evt, tool: null }, { apiKey: KEY, serverVersion: "x" }) === null);
	check("keyed-surface events produce nothing", toCapture({ ...evt, event: "request" }, { apiKey: KEY, serverVersion: "x" }) === null);

	check("uaProductOf: first product token", JSON.stringify(uaProductOf("claude-code/1.2.3 (darwin; arm64)")) === JSON.stringify({ name: "claude-code", version: "1.2.3" }));
	check("uaProductOf: no version", JSON.stringify(uaProductOf("node")) === JSON.stringify({ name: "node", version: null }));
	check("uaProductOf: junk -> unknown", ["<x>/1", "", null, "a b/1".replace(" ", "\u0000")].every((u) => uaProductOf(u).name === "unknown"));
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

upstream.close();
process.exit(summary("analytics e2e") === 0 ? 0 : 1);
