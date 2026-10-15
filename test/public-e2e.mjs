/**
 * `POST /mcp/public` — the NO-LOGIN read-only endpoint, end to end, offline.
 *
 * A real Node HTTP server running the real public handler
 * (`dist/httpPublic.js`), real MCP requests, and a LOCAL stub upstream for
 * `GET /api/news` and `GET /api/news/{slug}`.
 *
 * What this suite holds:
 *   1. THE GATE IS CLOSED BY DEFAULT. Only ENABLE="1" opens it; DISABLE="1"
 *      closes it whatever ENABLE says; a closed gate is 404 for everything.
 *   2. EXACTLY THREE TOOLS. tools/list and platform_info.capabilities.tools
 *      are get_news, get_article, platform_info, and nothing else.
 *   3. NOTHING ELSE CAN BE CALLED. Every offering/sponsor/inquiry/memo/
 *      disclosure/screener name, an unknown name, and a batch hiding one, is
 *      HTTP 403 before dispatch.
 *   4. EVERY RESPONSE CARRIES THE CERTIFIED DISCLAIMER (apx-92c1f4514d),
 *      success and error, in structuredContent and in the text content.
 *   5. THE PER-IP CEILING BITES, per IP, with Retry-After.
 *   6. NO CREDENTIAL IS NEEDED, ONE SENT IS IGNORED, AND THE LOG CARRIES NO
 *      IP, HEADER OR BODY.
 *   7. THE OTHER SURFACES ARE UNCHANGED (stdio and keyed-HTTP tool lists).
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as createNodeServer } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { check, DISCLAIMER, resetCounters, section, summary } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "..", "dist");
const apx = (s) => "apx-" + createHash("sha1").update(s, "utf8").digest("hex").slice(0, 10);

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

const upstream = createNodeServer((req, res) => {
	const url = new URL(req.url, "http://stub");
	const json = (status, body) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};
	if (url.pathname === "/api/news") return json(200, { data: ARTICLES });
	if (url.pathname.startsWith("/api/news/")) {
		const a = ARTICLES.find((x) => x.slug === url.pathname.slice("/api/news/".length));
		return a ? json(200, { data: a }) : json(404, { error: "Article not found" });
	}
	res.writeHead(404, { "content-type": "text/plain" });
	res.end("404 Not Found");
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;

process.env.COMMERTIZE_API_BASE_URL = UPSTREAM;
// Gates that would register more tools on other surfaces are OPEN on purpose:
// the public surface must still serve only its three.
process.env.COMMERTIZE_MCP_ENABLE_OFFERINGS = "1";
process.env.COMMERTIZE_MCP_ENABLE_INQUIRY = "1";
process.env.COMMERTIZE_MCP_ENABLE_MEMO = "1";
process.env.COMMERTIZE_MCP_ENABLE_DISCLOSURE = "1";

const { createPublicHttpHandler, PUBLIC_PATH } = await import(path.join(DIST, "httpPublic.js"));
const { FixedWindowLimiter } = await import(path.join(DIST, "httpRateLimit.js"));
const { createServer } = await import(path.join(DIST, "index.js"));
const { PUBLIC_DISCLAIMER, PUBLIC_DISCLAIMER_ID, PUBLIC_TOOL_NAMES, clientNameOf } = await import(
	path.join(DIST, "publicSurface.js")
);

const MAX = 12;
const events = [];
let enabled = true;
const ipLimiter = new FixedWindowLimiter(MAX, 60_000);
const handler = createPublicHttpHandler({
	enabled: () => enabled,
	ipLimiter,
	createServer: () => createServer("public"),
	log: (e) => events.push(e),
	maxBodyBytes: 4096,
});
const server = createNodeServer((req, res) => {
	handler(req, res).catch(() => {
		if (!res.headersSent) res.writeHead(500).end();
	});
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const URL_PUBLIC = `${BASE}${PUBLIC_PATH}`;

const INIT = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "0" } },
};
const CALL = (name, args = {}, id = 2) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const LIST = { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} };

let ipSeq = 0;
const freshIp = () => `198.51.100.${++ipSeq}`;
const post = (body, headers = {}, url = URL_PUBLIC) =>
	fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"x-vercel-forwarded-for": headers.ip ?? freshIp(),
			...Object.fromEntries(Object.entries(headers).filter(([k]) => k !== "ip")),
		},
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
const rpc = async (body, headers) => {
	const r = await post(body, headers);
	return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) };
};

/*
 * Pinned HERE as a literal, never read back from PUBLIC_TOOL_NAMES: a test
 * that compares the surface with the constant that defines it would pass if
 * someone added an offering tool to the constant. Adding a public tool means
 * editing this line too, in a reviewed diff (second opinion on PR #4).
 */
const EXPECTED_PUBLIC = ["get_article", "get_news", "platform_info"];
/** Name families that must never be public, whatever the constant says. */
const NEVER_PUBLIC = /offering|sponsor|listing|reserve|inquiry|memo|disclosure|sandbox|x402|invest|subscribe|wallet/i;

resetCounters();

section("0. the public set is pinned and holds no money-path family");
{
	check("PUBLIC_TOOL_NAMES equals the pinned literal", JSON.stringify([...PUBLIC_TOOL_NAMES].sort()) === JSON.stringify(EXPECTED_PUBLIC), PUBLIC_TOOL_NAMES.join(","));
	check("no public name matches a never-public family", PUBLIC_TOOL_NAMES.every((n) => !NEVER_PUBLIC.test(n)));
	check("deny pattern positive control", ["list_offerings", "get_sponsor", "file_sponsor_inquiry", "request_memo", "x402_fetch"].every((n) => NEVER_PUBLIC.test(n)));
}

/* ------------------------------------------------------------------ */
section("1. gate parse (config.ts), default closed");
{
	const parse = (env) => {
		const out = spawnSync(
			process.execPath,
			["--input-type=module", "-e", `import(${JSON.stringify(path.join(DIST, "config.js"))}).then(m=>process.stdout.write(String(m.config.publicDisabled)))`],
			{ env: { PATH: process.env.PATH, ...env }, encoding: "utf8" }
		);
		return out.stdout.trim();
	};
	check("unset -> closed", parse({}) === "true");
	for (const v of ["", "true", "yes", "on", " 1", "1 ", "01"]) {
		check(`ENABLE=${JSON.stringify(v)} -> closed`, parse({ COMMERTIZE_MCP_ENABLE_PUBLIC: v }) === "true");
	}
	check("ENABLE=1 -> open", parse({ COMMERTIZE_MCP_ENABLE_PUBLIC: "1" }) === "false");
	check(
		"ENABLE=1 + DISABLE=1 -> closed (kill switch wins)",
		parse({ COMMERTIZE_MCP_ENABLE_PUBLIC: "1", COMMERTIZE_MCP_DISABLE_PUBLIC: "1" }) === "true"
	);

	enabled = false;
	const r = await rpc(INIT);
	check("closed gate: POST is 404", r.status === 404, String(r.status));
	const l = await rpc(CALL("get_news"));
	check("closed gate: a tool call is 404 too", l.status === 404);
	enabled = true;
}

/* ------------------------------------------------------------------ */
section("2. exactly three tools");
{
	const init = await rpc(INIT);
	check("initialize 200", init.status === 200, String(init.status));
	check("no instructions string on this surface", init.body?.result && init.body.result.instructions === undefined);
	const list = await rpc(LIST);
	const names = (list.body?.result?.tools ?? []).map((t) => t.name).sort();
	check("tools/list = the public three", JSON.stringify(names) === JSON.stringify(EXPECTED_PUBLIC), names.join(","));

	const info = await rpc(CALL("platform_info"));
	const caps = info.body?.result?.structuredContent?.capabilities;
	check("platform_info.capabilities.tools = the public three", JSON.stringify([...(caps?.tools ?? [])].sort()) === JSON.stringify(EXPECTED_PUBLIC), JSON.stringify(caps?.tools));
	check("platform_info: no write tools, read_only", caps?.write_tools?.length === 0 && caps?.read_only === true);
}

/* ------------------------------------------------------------------ */
section("3. nothing else can be called (403 before dispatch)");
{
	for (const name of [
		"list_offerings",
		"get_offering",
		"search_offerings",
		"compare_offerings",
		"list_sponsors",
		"get_sponsor",
		"file_sponsor_inquiry",
		"request_memo",
		"get_disclosure_package",
		"no_such_tool",
	]) {
		const r = await rpc(CALL(name));
		check(`${name}: 403, -32601`, r.status === 403 && r.body?.error?.code === -32601, `${r.status} ${JSON.stringify(r.body)}`);
	}
	const batch = await rpc([CALL("get_news", {}, 10), CALL("list_offerings", {}, 11)]);
	check("a batch hiding one refused call is refused whole", batch.status === 403);
	const evt = events.filter((e) => e.outcome === "tool_refused");
	check("refused calls log a fixed token, never the caller's text", evt.length >= 11 && evt.every((e) => e.tool === "(refused)"), JSON.stringify(evt.map((e) => e.tool)));
}

/* ------------------------------------------------------------------ */
section("4. every response carries the certified disclaimer");
{
	check("PUBLIC_DISCLAIMER hashes to its id", apx(PUBLIC_DISCLAIMER) === PUBLIC_DISCLAIMER_ID && PUBLIC_DISCLAIMER_ID === "apx-92c1f4514d");
	const cases = [
		["get_news", {}, false],
		["get_article", { slug: "tokenization-week" }, false],
		["platform_info", {}, false],
		["get_article", { slug: "no-such-article" }, true],
	];
	for (const [name, args, expectError] of cases) {
		const r = await rpc(CALL(name, args));
		const res = r.body?.result;
		const s = res?.structuredContent;
		const text = res?.content?.[0]?.text ?? "";
		let parsedText = null;
		try {
			parsedText = JSON.parse(text);
		} catch {}
		check(`${name}${expectError ? " (error path)" : ""}: isError as expected`, Boolean(res?.isError) === expectError, JSON.stringify(res?.isError));
		check(`${name}${expectError ? " (error path)" : ""}: structured disclaimer is the certified text`, s?.disclaimer === PUBLIC_DISCLAIMER);
		check(`${name}${expectError ? " (error path)" : ""}: text content agrees with structuredContent`, parsedText && JSON.stringify(parsedText) === JSON.stringify(s));
		check(`${name}${expectError ? " (error path)" : ""}: as_of and source_url present`, typeof s?.as_of === "string" && typeof s?.source_url === "string");
		check(`${name}${expectError ? " (error path)" : ""}: the server-wide disclaimer is absent`, !text.includes(DISCLAIMER));
	}
}

/* ------------------------------------------------------------------ */
section("5. per-IP ceiling");
{
	ipLimiter.reset();
	const ip = "203.0.113.50";
	let lastOk = 0;
	for (let i = 0; i < MAX; i++) {
		const r = await post(LIST, { ip });
		if (r.status === 200) lastOk += 1;
	}
	check(`${MAX} requests from one IP pass`, lastOk === MAX, String(lastOk));
	const over = await post(LIST, { ip });
	check(`request ${MAX + 1} is 429 with Retry-After`, over.status === 429 && Number(over.headers.get("retry-after")) >= 1, `${over.status} ${over.headers.get("retry-after")}`);
	check("429 body is a machine code", JSON.stringify(await over.json()) === JSON.stringify({ error: "rate_limited" }));
	const other = await post(LIST, { ip: "203.0.113.51" });
	check("another IP has its own bucket", other.status === 200);
	const v6a = await post(LIST, { ip: "2001:db8:1:2:aaaa::1" });
	check("an IPv6 client passes", v6a.status === 200);
	for (let i = 0; i < MAX - 1; i++) await post(LIST, { ip: `2001:db8:1:2:${i.toString(16)}::9` });
	const v6over = await post(LIST, { ip: "2001:db8:1:2:ffff::1" });
	check("IPv6 rotation inside one /64 shares the bucket", v6over.status === 429, String(v6over.status));
}

/* ------------------------------------------------------------------ */
section("6. no credential, protocol hygiene, clean log");
{
	ipLimiter.reset();
	const SECRET_HEADER = "Bearer cfa_0123456789abcdef_" + "Z".repeat(43);
	const withAuth = await rpc(CALL("get_news"), { authorization: SECRET_HEADER });
	check("an Authorization header is ignored (still 200)", withAuth.status === 200);

	const get = await fetch(URL_PUBLIC, { method: "GET" });
	check("GET is 405", get.status === 405);
	const opt = await fetch(URL_PUBLIC, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
	check("OPTIONS is 405 with no CORS header", opt.status === 405 && ![...opt.headers.keys()].some((k) => k.startsWith("access-control-")));
	const other = await post(INIT, {}, `${BASE}/mcp`);
	check("this handler answers only /mcp/public (other paths 404)", other.status === 404);
	const ct = await fetch(URL_PUBLIC, { method: "POST", headers: { "content-type": "text/plain", "x-vercel-forwarded-for": freshIp() }, body: "{}" });
	check("non-JSON content type is 415", ct.status === 415);
	const big = await post({ jsonrpc: "2.0", id: 9, method: "tools/list", params: { pad: "x".repeat(5000) } });
	check("oversized body is 413", big.status === 413);
	const bad = await post("{nope");
	check("parse error is 400 / -32700", bad.status === 400 && (await bad.json()).error?.code === -32700);

	const req = events.filter((e) => e.event === "public_request");
	check("every request is logged once with method, path, status, outcome, ms", req.length > 20 && req.every((e) => e.method && e.path && typeof e.status === "number" && e.outcome && typeof e.ms === "number"));
	check("initialize logs the sanitised client family", req.some((e) => e.client === "test-client"));
	const blob = JSON.stringify(events);
	check("no event carries the Authorization value", !blob.includes("cfa_0123456789abcdef") && !blob.includes("Bearer"));
	check("no event carries a client IP", !/198\.51\.100\.|203\.0\.113\.|2001:db8/.test(blob));
	check("no event carries a request body", !blob.includes("tokenization-week") && !blob.includes("xxxxxxxxxx"));

	check("clientNameOf keeps a plain token", clientNameOf("claude-code") === "claude-code");
	check("clientNameOf refuses spaces, long or odd input", ["a b", "x".repeat(41), "<script>", "", null, 7].every((v) => clientNameOf(v) === "unknown"));
}

/* ------------------------------------------------------------------ */
section("7. other surfaces unchanged");
{
	const names = async (surface) => {
		const s = createServer(surface);
		// eslint-disable-next-line no-underscore-dangle
		return Object.keys(s._registeredTools ?? {}).sort();
	};
	const stdio = await names("stdio");
	const http = await names("http");
	check("stdio still registers the offering tools", stdio.includes("list_offerings") && stdio.includes("get_offering"), stdio.join(","));
	check("keyed http still registers its allowlist (incl. list_offerings, file_sponsor_inquiry)", http.includes("list_offerings") && http.includes("file_sponsor_inquiry"), http.join(","));
	const pub = await names("public");
	check("public registers only the three", JSON.stringify(pub) === JSON.stringify(EXPECTED_PUBLIC), pub.join(","));
}

server.close();
upstream.close();
process.exit(summary("public e2e") === 0 ? 0 : 1);
