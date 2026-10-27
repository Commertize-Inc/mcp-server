/**
 * Pre-flag hardening for `/mcp/public` (reviewer asks before
 * COMMERTIZE_MCP_ENABLE_PUBLIC=1 opens in production), offline.
 *
 *   H1. Anonymous error text carries no environment detail: a planted
 *       content path (ENOENT /var/task/...) and an unreachable upstream base
 *       URL never reach the response; the detail is logged server-side only.
 *   H2. Kill switch (security review L4-2): COMMERTIZE_MCP_DISABLE_PUBLIC disables on
 *       any non-empty value except "0"; ENABLE stays exact "1".
 *   H3. /openapi.json: info.version = package.json version, servers.url, and
 *       the summaries are legal review's certified L7a-e bytes (pinned here as
 *       literals, directory listings review 2026-10-19).
 *   H4. security review F3-1: the default stdio build registers only the public three;
 *       the gated set needs COMMERTIZE_MCP_ENABLE_GATED_TOOLS exactly "1".
 *   H5. security review L4-3 slug cap (200) before any upstream call; L4-1 Origin check;
 *       L5-1 ISO-only capture timestamp; L5-2 public tool set in toCaptures.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer as createNodeServer } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { check, LOOPBACK, resetCounters, section, summary } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "..", "dist");
const apx = (s) => "apx-" + createHash("sha1").update(s, "utf8").digest("hex").slice(0, 10);

/* Planted environment detail: none of these strings may reach a client. */
const PLANTED_CONTENT_DIR = "/var/task/planted-secret-dir-7f3a";
const PLANTED_HOST = "planted-internal-host-7f3a.invalid";

/* A stub upstream that counts hits, for the slug-cap "no upstream call" proof. */
const upstreamHits = [];
const upstream = createNodeServer((req, res) => {
	upstreamHits.push(req.url);
	res.writeHead(404, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: "Article not found" }));
});
await new Promise((r) => upstream.listen(0, LOOPBACK, r));
const STUB = `http://${LOOPBACK}:${upstream.address().port}`;

/** Run a public handler in a child process with its own env (config is import-time). */
const childScript = (body) => `
const path = await import("node:path");
const DIST = ${JSON.stringify(DIST)};
const { createPublicHttpHandler } = await import(path.join(DIST, "httpPublic.js"));
const { FixedWindowLimiter } = await import(path.join(DIST, "httpRateLimit.js"));
const { createServer } = await import(path.join(DIST, "index.js"));
const http = await import("node:http");
const logs = [];
const h = createPublicHttpHandler({
	enabled: () => true,
	ipLimiter: new FixedWindowLimiter(100, 60000),
	createServer: (cb) => createServer("public", cb),
	log: (e) => logs.push(e),
	maxBodyBytes: 65536,
});
const srv = http.createServer((q, s) => void h(q, s));
await new Promise((r) => srv.listen(0, [127, 0, 0, 1].join("."), r));
const URL_ = "http://" + [127, 0, 0, 1].join(".") + ":" + srv.address().port + "/mcp/public";
const call = async (name, args) => {
	const r = await fetch(URL_, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
	return await r.text();
};
${body}
srv.close();
process.stdout.write(JSON.stringify(out));
`;
// Async on purpose: the stub upstream lives in THIS process, and a spawnSync
// would block its event loop (the 200-char positive control caught that).
const runChild = (env, body) =>
	new Promise((resolve) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", childScript(body)], {
			env: { PATH: process.env.PATH, ...env },
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
		child.stdout.on("data", (c) => (stdout += c));
		child.stderr.on("data", (c) => (stderr += c));
		child.on("exit", () => {
			clearTimeout(timer);
			try {
				resolve(JSON.parse(stdout));
			} catch {
				resolve({ _stderr: stderr, _stdout: stdout });
			}
		});
	});

resetCounters();

/* ------------------------------------------------------------------ */
section("H1. anonymous error text carries no environment detail");
{
	const out = await runChild(
		{ COMMERTIZE_MCP_CONTENT_DIR: PLANTED_CONTENT_DIR, COMMERTIZE_API_BASE_URL: `http://${PLANTED_HOST}:9` },
		`const out = { info: await call("platform_info", {}), news: await call("get_news", {}), article: await call("get_article", { slug: "x" }), logs };`
	);
	for (const [label, text] of [["platform_info (planted ENOENT path)", out.info], ["get_news (unreachable upstream)", out.news], ["get_article (unreachable upstream)", out.article]]) {
		check(`${label}: response received`, typeof text === "string" && text.length > 0, JSON.stringify(out).slice(0, 300));
		const t = String(text ?? "");
		for (const leak of ["/var/task", "planted-secret-dir", "ENOENT", PLANTED_HOST, "planted-internal-host", ".invalid", "ENOTFOUND", "getaddrinfo"]) {
			check(`${label}: response never contains ${JSON.stringify(leak)}`, !t.includes(leak));
		}
		let body = null;
		try {
			body = JSON.parse(t);
		} catch {}
		const sc = body?.result?.structuredContent;
		check(`${label}: still an error envelope (isError + code)`, body?.result?.isError === true && typeof sc?.error?.code === "string", t.slice(0, 200));
		check(`${label}: source_url is the fixed empty string on an error`, sc?.source_url === "");
	}
	const info = JSON.parse(out.info ?? "{}")?.result?.structuredContent;
	check("platform_info error: fixed message", info?.error?.message === "Internal error", info?.error?.message);
	const news = JSON.parse(out.news ?? "{}")?.result?.structuredContent;
	check("get_news unreachable: code kept (UPSTREAM_UNREACHABLE)", news?.error?.code === "UPSTREAM_UNREACHABLE", news?.error?.code);
	check("get_news unreachable: fixed message", news?.error?.message === "The upstream service is unavailable. Retry later.", news?.error?.message);
	const detailLogs = (out.logs ?? []).filter((e) => e.event === "public_tool_error");
	check("server-side log keeps the detail (planted path present in the log only)", detailLogs.some((e) => String(e.detail).includes("planted-secret-dir")), JSON.stringify(detailLogs).slice(0, 300));
	check("server-side log keeps the upstream detail", detailLogs.some((e) => String(e.detail).includes(PLANTED_HOST)));
	check("server-side detail is bounded (<= 500 chars)", detailLogs.every((e) => String(e.detail).length <= 500));

	// The bound at a value where it can bite (mutant H1d: short details hid it).
	const { withPublicDisclaimer } = await import(path.join(DIST, "publicSurface.js"));
	const long = "/var/task/" + "x".repeat(2000);
	let seen = null;
	const r = withPublicDisclaimer(
		{ content: [], structuredContent: { disclaimer: "d", source_url: "http://10.0.0.5", error: { code: "INTERNAL_ERROR", message: long, retryable: false } }, isError: true },
		(d) => (seen = d)
	);
	check("unit: a 2010-char cause is logged as exactly 500 chars", seen?.detail?.length === 500 && seen.detail === long.slice(0, 500), String(seen?.detail?.length));
	check("unit: response message fixed, source_url empty", r.structuredContent.error.message === "Internal error" && r.structuredContent.source_url === "");
	const odd = withPublicDisclaimer({ content: [], structuredContent: { disclaimer: "d", error: { code: "weird code!", message: "m" } }, isError: true });
	check("unit: an unknown/malformed code becomes INTERNAL_ERROR, retryable false", odd.structuredContent.error.code === "INTERNAL_ERROR" && odd.structuredContent.error.retryable === false);
	const okr = withPublicDisclaimer({ content: [], structuredContent: { disclaimer: "d", source_url: "https://api.commertize.com/api/news", error: null } });
	check("unit: a success keeps its source_url (only errors are scrubbed)", okr.structuredContent.source_url === "https://api.commertize.com/api/news");
}

/* ------------------------------------------------------------------ */
section("H2. kill switch: any non-empty DISABLE value except \"0\" closes");
{
	const { publicDisabledFrom } = await import(path.join(DIST, "config.js"));
	check("publicDisabledFrom is exported", typeof publicDisabledFrom === "function");
	const open = { COMMERTIZE_MCP_ENABLE_PUBLIC: "1" };
	for (const v of ["true", "1 ", "yes", "1", " ", "off", "false", "00", " 0"]) {
		check(`ENABLE=1 + DISABLE=${JSON.stringify(v)} -> closed`, publicDisabledFrom({ ...open, COMMERTIZE_MCP_DISABLE_PUBLIC: v }) === true);
	}
	check('ENABLE=1 + DISABLE="0" -> open', publicDisabledFrom({ ...open, COMMERTIZE_MCP_DISABLE_PUBLIC: "0" }) === false);
	check('ENABLE=1 + DISABLE="" -> open', publicDisabledFrom({ ...open, COMMERTIZE_MCP_DISABLE_PUBLIC: "" }) === false);
	check("ENABLE=1 + DISABLE unset -> open", publicDisabledFrom(open) === false);
	for (const v of ["", "true", "1 ", " 1", "yes"]) {
		check(`ENABLE=${JSON.stringify(v)} -> closed (exact "1" only)`, publicDisabledFrom({ COMMERTIZE_MCP_ENABLE_PUBLIC: v }) === true);
	}
	// The live config object reads the same function (spawned: config is import-time).
	const live = spawnSync(
		process.execPath,
		["--input-type=module", "-e", `import(${JSON.stringify(path.join(DIST, "config.js"))}).then(m=>process.stdout.write(String(m.config.publicDisabled)))`],
		{ env: { PATH: process.env.PATH, COMMERTIZE_MCP_ENABLE_PUBLIC: "1", COMMERTIZE_MCP_DISABLE_PUBLIC: "true" }, encoding: "utf8" }
	).stdout.trim();
	check('config.publicDisabled with DISABLE="true" -> true', live === "true", live);
}

/* ------------------------------------------------------------------ */
section("H3. /openapi.json version, server and certified summaries");
{
	const pkg = JSON.parse(await readFile(path.join(HERE, "..", "package.json"), "utf8"));
	const { OPENAPI_DOCUMENT } = await import(path.join(DIST, "httpPublic.js"));
	check("package version is 0.2.0", pkg.version === "0.2.0", pkg.version);
	check("info.version === package.json version", OPENAPI_DOCUMENT.info.version === pkg.version, OPENAPI_DOCUMENT.info.version);
	check("servers = [https://agents.commertize.com] exactly", JSON.stringify(OPENAPI_DOCUMENT.servers) === JSON.stringify([{ url: "https://agents.commertize.com" }]));
	// legal review CERT 2026-10-19 L7a-e, literals + ids (never read back from src).
	const L7 = [
		["L7a", OPENAPI_DOCUMENT.paths["/health"].get.summary, "Service status", "apx-7efad8d910"],
		["L7b", OPENAPI_DOCUMENT.paths["/health"].get.responses["200"].description, "JSON status", "apx-58f47863db"],
		["L7c", OPENAPI_DOCUMENT.paths["/mcp/public"].post.summary, "MCP Streamable HTTP endpoint, no key (get_news, get_article, platform_info)", "apx-d69cf60c3f"],
		["L7d", OPENAPI_DOCUMENT.paths["/mcp/public"].post.responses["200"].description, "JSON-RPC result", "apx-749532c25b"],
		["L7e", OPENAPI_DOCUMENT.paths["/mcp/public"].post.responses["403"].description, "Tool not on the public surface", "apx-5b2311304b"],
	];
	for (const [id, got, want, hash] of L7) {
		check(`${id}: literal hashes to the certified id ${hash}`, apx(want) === hash, apx(want));
		check(`${id}: served bytes equal the certified bytes`, got === want, JSON.stringify(got));
	}
	check("info.description is the certified one-liner apx-2965904744", apx(OPENAPI_DOCUMENT.info.description) === "apx-2965904744");
	const responses = Object.keys(OPENAPI_DOCUMENT.paths["/mcp/public"].post.responses).sort();
	check("documented /mcp/public responses are exactly 200 and 403 (each certified)", JSON.stringify(responses) === JSON.stringify(["200", "403"]), responses.join(","));
}

/* ------------------------------------------------------------------ */
section("H4. F3-1: default stdio build = the public three only");
{
	const listStdio = (env) => {
		const r = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`const p=await import("node:path");const {createServer}=await import(p.join(${JSON.stringify(DIST)},"index.js"));const {Client}=await import("@modelcontextprotocol/sdk/client/index.js");const {InMemoryTransport}=await import("@modelcontextprotocol/sdk/inMemory.js");const s=createServer();const [a,b]=InMemoryTransport.createLinkedPair();await s.connect(a);const c=new Client({name:"t",version:"0"});await c.connect(b);const {tools}=await c.listTools();process.stdout.write(JSON.stringify(tools.map(t=>t.name).sort()));`,
			],
			{ cwd: path.resolve(HERE, ".."), env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 30_000 }
		);
		try {
			return JSON.parse(r.stdout);
		} catch {
			return [r.stderr.slice(0, 200)];
		}
	};
	const THREE = JSON.stringify(["get_article", "get_news", "platform_info"]);
	const ALL_OPEN = { COMMERTIZE_MCP_ENABLE_OFFERINGS: "1", COMMERTIZE_MCP_ENABLE_INQUIRY: "1", COMMERTIZE_MCP_ENABLE_MEMO: "1", COMMERTIZE_MCP_ENABLE_DISCLOSURE: "1" };
	check("no env: stdio registers exactly the public three", JSON.stringify(listStdio({})) === THREE, JSON.stringify(listStdio({})));
	for (const v of ["", "true", "1 ", "yes", "0"]) {
		const got = listStdio({ ...ALL_OPEN, COMMERTIZE_MCP_ENABLE_GATED_TOOLS: v });
		check(`every other gate open, GATED_TOOLS=${JSON.stringify(v)}: still the three`, JSON.stringify(got) === THREE, JSON.stringify(got));
	}
	const opened = listStdio({ ...ALL_OPEN, COMMERTIZE_MCP_ENABLE_GATED_TOOLS: "1" });
	check('GATED_TOOLS="1" + gates open: the gated set registers (positive control)', opened.includes("list_offerings") && opened.length > 3, opened.join(","));
	const readme = await readFile(path.join(HERE, "..", "README.md"), "utf8");
	const tableTools = [...readme.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]).sort();
	check("README tool table = the default stdio set", JSON.stringify(tableTools) === THREE, tableTools.join(","));
}

/* ------------------------------------------------------------------ */
section("H5. slug cap, Origin, ISO timestamp, public tool set in toCaptures");
{
	const out = await runChild(
		{ COMMERTIZE_API_BASE_URL: STUB },
		`const r400 = await call("get_article", { slug: "a".repeat(400) });
const r201 = await call("get_article", { slug: "b".repeat(201) });
const r200 = await call("get_article", { slug: "c".repeat(200) });
const o = async (origin) => (await fetch(URL_, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(origin === undefined ? {} : { origin }) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) })).status;
const origins = { absent: await o(undefined), evil: await o("https://evil.example"), nul: await o("null"), lookalike: await o("https://agents.commertize.com.evil.example"), http: await o("http://agents.commertize.com"), same: await o("https://agents.commertize.com") };
const out = { r400, r201, r200, origins, logs };`
	);
	const sc = (t) => {
		try {
			return JSON.parse(t).result.structuredContent;
		} catch {
			return null;
		}
	};
	check("slug 400 chars: INVALID_ARGUMENT", sc(out.r400)?.error?.code === "INVALID_ARGUMENT", String(out.r400).slice(0, 200));
	check("slug 201 chars: INVALID_ARGUMENT", sc(out.r201)?.error?.code === "INVALID_ARGUMENT");
	check("slug 200 chars: accepted (reaches upstream, NOT_FOUND)", sc(out.r200)?.error?.code === "NOT_FOUND", String(out.r200).slice(0, 200));
	check("no upstream call for an over-cap slug", !upstreamHits.some((u) => u.includes("aaaa") || u.includes("bbbb")), upstreamHits.join(","));
	check("the 200-char slug did reach upstream (positive control)", upstreamHits.some((u) => u.includes("c".repeat(200))));
	const st = out.origins ?? {};
	check("Origin absent (server-to-server): 200", st.absent === 200, JSON.stringify(st));
	check("Origin cross-site: 403", st.evil === 403);
	check('Origin "null": 403', st.nul === 403);
	check("Origin lookalike suffix: 403", st.lookalike === 403);
	check("Origin http (not https): 403", st.http === 403);
	check("Origin https://agents.commertize.com: 200", st.same === 200);
	check("refused Origin is logged as origin_refused", (out.logs ?? []).some((e) => e.outcome === "origin_refused"));
	check("the Origin value itself is never logged", !JSON.stringify(out.logs ?? []).includes("evil.example"));

	const { toCaptures } = await import(path.join(DIST, "analytics.js"));
	const CFG = { apiKey: "phc_" + "a".repeat(30), serverVersion: "0.2.0" };
	const base = { event: "public_request", rpc: ["tools/call"], tool: "get_news", status: 200, outcome: "ok", ms: 1, client_name: "node", client_version: "1" };
	const tsOf = (ts) => toCaptures({ ...base, ts }, CFG)[0]?.timestamp;
	check("L5-1: ISO timestamp kept", tsOf("2026-10-19T21:00:00.000Z") === "2026-10-19T21:00:00.000Z");
	for (const bad of ["jane.doe@example.com", "t", "2026-10-19", "2026-13-45T99:99:99.000Z", "2026-10-19T21:00:00.000Z extra"]) {
		check(`L5-1: non-ISO timestamp ${JSON.stringify(bad)} -> null`, tsOf(bad) === null, String(tsOf(bad)));
	}
	const toolOf = (tool, event = "public_request") => toCaptures({ ...base, event, ts: "2026-10-19T21:00:00.000Z", tool }, CFG).find((c) => c.event === "mcp_tool_call")?.properties?.tool;
	check("L5-2: public get_news kept", toolOf("get_news") === "get_news");
	check("L5-2: public list_offerings -> (refused)", toolOf("list_offerings") === "(refused)", toolOf("list_offerings"));
	check("L5-2: public free text -> (refused)", toolOf("jane.doe@example.com") === "(refused)");
}

upstream.close();
process.exit(summary("public hardening") === 0 ? 0 : 1);
