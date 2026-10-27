/**
 * The front door for outside agents (market research competitive map 2026-10-20 §6, §8).
 *
 *   A. Discovery: `/.well-known/agent-card.json` and `/.well-known/agent.json`
 *      serve an A2A v1.0 card for the no-key endpoint, behind the public gate.
 *   B. Every tool on every surface carries the full annotation set
 *      (readOnly/destructive/idempotent/openWorld hints + title) and a
 *      pricing block in `_meta["com.commertize/pricing"]`. A tool with no
 *      row, or with an in-code hint that disagrees with its row, cannot be
 *      registered.
 *   C. No key: `initialize` and `tools/list` work on `/mcp/public` with no
 *      Authorization header.
 *   D. Every refusal on the public surface, the keyed surface and the card
 *      is `{ error: <code>, fix: <one line> }` (JSON-RPC: `error.data`).
 *
 * DIST may be overridden (FD_DIST) so the same file runs against a base
 * build to show which checks are red without this change.
 */

import { createServer as createNodeServer } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { check, resetCounters, section, summary } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.FD_DIST ?? path.resolve(HERE, "..", "dist");

process.env.COMMERTIZE_API_BASE_URL = `http://${[127, 0, 0, 1].join(".")}:${9}`; // never reached by these checks
for (const g of ["OFFERINGS", "INQUIRY", "MEMO", "DISCLOSURE", "GATED_TOOLS", "SANDBOX", "X402"]) {
	process.env[`COMMERTIZE_MCP_ENABLE_${g}`] = "1";
}

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { createServer } = await import(path.join(DIST, "index.js"));
const { createPublicHttpHandler, PUBLIC_PATH, SERVER_VERSION, createOpenApiHandler } = await import(
	path.join(DIST, "httpPublic.js")
);
const { createHttpHandler } = await import(path.join(DIST, "httpServer.js"));
const { FixedWindowLimiter } = await import(path.join(DIST, "httpRateLimit.js"));
const tryImport = async (f) => {
	try {
		return await import(path.join(DIST, f));
	} catch {
		return {};
	}
};
const cardMod = await tryImport("agentCard.js");
const metaMod = await tryImport("toolMeta.js");

/* Pinned HERE, never read back from the module under test. */
const PRICING_KEY = "com.commertize/pricing";
const PUBLIC_URL = "https://agents.commertize.com/mcp/public";
const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
/** Tools that write or pay: readOnlyHint must be false. */
const WRITES = new Set(["file_sponsor_inquiry", "request_memo", "sandbox_enroll", "sandbox_place_order", "x402_fetch"]);
/** Tools whose call can be answered with an x402 challenge. */
const PAID = new Set(["x402_fetch"]);
/* legal review CERT_front_door_copy_2026-10-20 §1, pinned HERE byte for byte. */
const D6 = "Commertize is not registered with or regulated by the SEC as a broker-dealer or investment adviser. This is not a recommendation or investment advice. Consult your own advisers.";
const isFixLine = (f) => typeof f === "string" && f.length > 0 && f.length <= 200 && !/[\r\n]/.test(f);

const listTools = async (surface) => {
	const server = createServer(surface);
	const [a, b] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "front-door-test", version: "0" });
	await Promise.all([server.connect(a), client.connect(b)]);
	const { tools } = await client.listTools();
	await client.close();
	return tools;
};

resetCounters();

/* ------------------------------------------------------------------ */
section("B. annotations and pricing on every tool, every surface");
{
	for (const surface of ["public", "http", "stdio"]) {
		const tools = await listTools(surface);
		check(`${surface}: lists at least one tool`, tools.length > 0, String(tools.length));
		const bad = [];
		for (const t of tools) {
			const a = t.annotations ?? {};
			if (!HINTS.every((h) => typeof a[h] === "boolean")) bad.push(`${t.name}:hints`);
			if (typeof a.title !== "string" || a.title.length === 0) bad.push(`${t.name}:title`);
			if (a.readOnlyHint === true && a.destructiveHint === true) bad.push(`${t.name}:ro+destructive`);
			if (WRITES.has(t.name) !== (a.readOnlyHint === false)) bad.push(`${t.name}:readOnly`);
			const p = t._meta?.[PRICING_KEY];
			if (!p || (p.model !== "free" && p.model !== "x402")) bad.push(`${t.name}:pricing`);
			else if (PAID.has(t.name) !== (p.model === "x402")) bad.push(`${t.name}:pricing-model`);
			else if (p.model === "x402" && !(p.x402_version === 2 && p.asset === "USDC" && p.price_source === "x402_challenge"))
				bad.push(`${t.name}:x402-fields`);
		}
		check(`${surface}: every tool has 4 boolean hints, a title, and a pricing block`, bad.length === 0, bad.join(" "));
	}
	const stdio = await listTools("stdio");
	check("stdio gated build includes the paid tool x402_fetch (so the PAID check above ran)", stdio.some((t) => t.name === "x402_fetch"));

	const { applyToolMeta, ToolMetaError } = metaMod;
	check("applyToolMeta is exported", typeof applyToolMeta === "function");
	if (typeof applyToolMeta === "function") {
		const s = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
		applyToolMeta(s);
		let missing = null;
		try {
			s.registerTool("no_such_tool", { title: "x", inputSchema: {} }, async () => ({ content: [] }));
		} catch (e) {
			missing = e;
		}
		check("an unknown tool name THROWS at registration (fail closed)", missing instanceof ToolMetaError && /tool_meta_missing:no_such_tool/.test(missing.message), String(missing));
		let conflict = null;
		try {
			s.registerTool("get_news", { title: "x", inputSchema: {}, annotations: { readOnlyHint: false } }, async () => ({ content: [] }));
		} catch (e) {
			conflict = e;
		}
		check("an in-code hint that contradicts the table THROWS", conflict instanceof ToolMetaError && /tool_meta_conflict:get_news:readOnlyHint/.test(conflict.message), String(conflict));
		const s2 = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
		applyToolMeta(s2);
		let ok = true;
		try {
			s2.registerTool("get_news", { title: "T", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({ content: [] }));
		} catch {
			ok = false;
		}
		check("control: an agreeing hint registers", ok);
	}
}

/* ------------------------------------------------------------------ */
let publicEnabled = true;
const events = [];
const publicHandler = createPublicHttpHandler({
	enabled: () => publicEnabled,
	ipLimiter: new FixedWindowLimiter(1000, 60_000),
	createServer: () => createServer("public"),
	log: (e) => events.push(e),
	maxBodyBytes: 256,
});
const throwingHandler = createPublicHttpHandler({
	enabled: () => true,
	ipLimiter: new FixedWindowLimiter(1000, 60_000),
	createServer: () => {
		throw new Error("boom /var/task/secret-path");
	},
	log: () => {},
	maxBodyBytes: 4096,
});
const tightHandler = createPublicHttpHandler({
	enabled: () => true,
	ipLimiter: new FixedWindowLimiter(1, 60_000),
	createServer: () => createServer("public"),
	log: () => {},
	maxBodyBytes: 4096,
});
const cardHandler = cardMod.createAgentCardHandler?.({ enabled: () => publicEnabled });
const openApi = createOpenApiHandler({ enabled: () => publicEnabled });
const keyed = createHttpHandler({
	verifier: {
		configured: true,
		isCached: () => true,
		verify: async () => ({ ok: false, status: 401, code: "missing_credential", message: "Send an agent key as `Authorization: Bearer <key>`.", cached: true }),
	},
	requestLimiter: new FixedWindowLimiter(1000, 60_000),
	inquiryLimiter: new FixedWindowLimiter(1000, 60_000),
	verifyLimiter: new FixedWindowLimiter(1000, 60_000),
	createServer: () => createServer("http"),
	log: () => {},
	maxBodyBytes: 4096,
	version: "test",
});

const route = (req, res) => {
	const p = new URL(req.url, "http://x").pathname;
	const h =
		p.startsWith("/.well-known/") ? cardHandler :
		p === "/openapi.json" ? openApi :
		p.startsWith("/throw") ? throwingHandler :
		p.startsWith("/tight") ? tightHandler :
		p === "/mcp" || p === "/health" ? keyed : publicHandler;
	if (p.startsWith("/throw") || p.startsWith("/tight")) req.url = PUBLIC_PATH;
	if (!h) {
		res.writeHead(501).end();
		return;
	}
	h(req, res).catch(() => {
		if (!res.headersSent) res.writeHead(599).end();
	});
};
const http = createNodeServer(route);
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${http.address().port}`;

let ip = 0;
const req = async (p, { method = "POST", body, headers = {} } = {}) => {
	const r = await fetch(`${BASE}${p}`, {
		method,
		headers: { "x-vercel-forwarded-for": `203.0.113.${++ip % 250}`, accept: "application/json, text/event-stream", ...headers },
		body,
	});
	const text = await r.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {}
	return { status: r.status, json, headers: r.headers };
};
const J = { "content-type": "application/json" };
const INIT = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stranger-agent", version: "1" } } });
const LIST = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

/* ------------------------------------------------------------------ */
section("A. agent card (A2A v1.0 well-known path + legacy alias)");
{
	check("agentCard module exports a handler", typeof cardHandler === "function");
	for (const p of ["/.well-known/agent-card.json", "/.well-known/agent.json"]) {
		const r = await req(p, { method: "GET" });
		const c = r.json ?? {};
		check(`${p}: 200 JSON`, r.status === 200, String(r.status));
		const required = ["name", "description", "supportedInterfaces", "version", "capabilities", "defaultInputModes", "defaultOutputModes", "skills"];
		check(`${p}: every A2A v1.0 required field present`, required.every((k) => k in c), Object.keys(c).join(","));
		const iface = (c.supportedInterfaces ?? [])[0] ?? {};
		check(`${p}: the interface is the NO-KEY endpoint`, iface.url === PUBLIC_URL && typeof iface.protocolBinding === "string" && iface.protocolVersion === "2025-06-18", JSON.stringify(iface));
		check(`${p}: no A2A core binding is claimed (this server speaks MCP)`, !["JSONRPC", "GRPC", "HTTP+JSON"].includes(iface.protocolBinding));
		check(`${p}: the keyed /mcp is not advertised`, !JSON.stringify(c).includes('agents.commertize.com/mcp"'));
		check(`${p}: version = served version`, c.version === SERVER_VERSION, String(c.version));
		check(`${p}: carries the D6 disclaimer in its own field`, c.sec_disclaimer === D6 && c.disclaimer === undefined);
		check(`${p}: skills = the public tools, each with id/name/description/tags`, JSON.stringify((c.skills ?? []).map((s) => s.id).sort()) === JSON.stringify(["get_article", "get_news", "platform_info"]) && (c.skills ?? []).every((s) => s.name && s.description && Array.isArray(s.tags)));
	}
	const post = await req("/.well-known/agent-card.json", { method: "POST" });
	check("card: POST is 405 with a code and a fix", post.status === 405 && post.json?.error === "get_only" && isFixLine(post.json?.fix), JSON.stringify(post.json));
	publicEnabled = false;
	const closed = await req("/.well-known/agent.json", { method: "GET" });
	check("card: gate closed is 404 with a code and a fix", closed.status === 404 && closed.json?.error === "not_found" && isFixLine(closed.json?.fix), JSON.stringify(closed.json));
	publicEnabled = true;
}

/* ------------------------------------------------------------------ */
section("C. initialize and tools/list with NO key");
{
	const i = await req(PUBLIC_PATH, { body: INIT, headers: J });
	check("initialize, no Authorization header: 200 with serverInfo", i.status === 200 && i.json?.result?.serverInfo?.name === "commertize", JSON.stringify(i.json).slice(0, 200));
	const l = await req(PUBLIC_PATH, { body: LIST, headers: J });
	const tools = l.json?.result?.tools ?? [];
	check("tools/list, no key: 200, tools present", l.status === 200 && tools.length > 0);
	const call = await req(PUBLIC_PATH, { body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "platform_info", arguments: {} } }), headers: J });
	check("a public tool result carries D6 as sec_disclaimer (D-1 stays in disclaimer)", call.json?.result?.structuredContent?.sec_disclaimer === D6 && call.json?.result?.structuredContent?.disclaimer !== D6, JSON.stringify(call.json?.result?.structuredContent ?? {}).slice(0, 200));
	check("tools/list carries annotations and pricing over HTTP", tools.every((t) => t.annotations?.readOnlyHint === true && t._meta?.[PRICING_KEY]?.model === "free"));
}

/* ------------------------------------------------------------------ */
section("D. every refusal is a code plus a one-line fix");
{
	const cases = [
		["public 404 (closed gate)", async () => { publicEnabled = false; const r = await req(PUBLIC_PATH, { body: INIT, headers: J }); publicEnabled = true; return r; }, 404, "not_found"],
		["public 404 (other path)", () => req("/nope", { body: INIT, headers: J }), 404, "not_found"],
		["public 405", () => req(PUBLIC_PATH, { method: "GET" }), 405, "method_not_allowed"],
		["public 403 origin", () => req(PUBLIC_PATH, { body: INIT, headers: { ...J, origin: "https://evil.example" } }), 403, "origin_not_allowed"],
		["public 415", () => req(PUBLIC_PATH, { body: INIT, headers: { "content-type": "text/plain" } }), 415, "unsupported_media_type"],
		["public 413", () => req(PUBLIC_PATH, { body: JSON.stringify({ x: "a".repeat(400) }), headers: J }), 413, "payload_too_large"],
		["public 500", () => req("/throw", { body: INIT, headers: J }), 500, "internal_error"],
		["openapi 404 (closed)", async () => { publicEnabled = false; const r = await req("/openapi.json", { method: "GET" }); publicEnabled = true; return r; }, 404, "not_found"],
		["openapi 405", () => req("/openapi.json", { method: "POST" }), 405, "get_only"],
		["keyed 401 missing key", () => req("/mcp", { body: INIT, headers: J }), 401, "missing_credential"],
		["keyed 404", () => req("/health/x", { method: "GET" }), 404, "not_found"],
		["health 405", () => req("/health", { method: "POST" }), 405, "get_only"],
	];
	for (const [label, run, status, code] of cases) {
		const r = await run();
		check(`${label}: HTTP ${status}, error=${code}, one-line fix, D6 disclaimer`, r.status === status && r.json?.error === code && isFixLine(r.json?.fix) && r.json?.sec_disclaimer === D6 && r.json?.disclaimer === undefined && !r.json.fix.includes(D6), `${r.status} ${JSON.stringify(r.json)}`);
	}
	const k = await req("/mcp", { body: INIT, headers: J });
	check("keyed 401 fix points at the no-key endpoint", typeof k.json?.fix === "string" && k.json.fix.includes(PUBLIC_URL));
	check("keyed 401 keeps its existing message (nothing that parses it breaks)", typeof k.json?.message === "string" && k.json.message.length > 0);
	check("verifier_unavailable fix is the legal review redline", (await tryImport("refusals.js")).REFUSAL_FIX?.verifier_unavailable === "The key check is unavailable. Retry later.");
	check("keyed 401 keeps WWW-Authenticate", (k.headers.get("www-authenticate") ?? "").startsWith("Bearer"));

	const t1 = await req("/tight", { body: INIT, headers: { ...J, "x-vercel-forwarded-for": "198.18.0.1" } });
	const t2 = await req("/tight", { body: INIT, headers: { ...J, "x-vercel-forwarded-for": "198.18.0.1" } });
	check("public 429: code, fix and Retry-After", t1.status === 200 && t2.status === 429 && t2.json?.error === "rate_limited" && isFixLine(t2.json?.fix) && t2.headers.get("retry-after"), `${t1.status} ${t2.status} ${JSON.stringify(t2.json)}`);

	const rpcCases = [
		["parse error", () => req(PUBLIC_PATH, { body: "{not json", headers: J }), 400, -32700, "parse_error"],
		["non-public tool", () => req(PUBLIC_PATH, { body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "list_offerings", arguments: {} } }), headers: J }), 403, -32601, "tool_not_public"],
		["batch", () => req(PUBLIC_PATH, { body: JSON.stringify([JSON.parse(LIST)]), headers: J }), 400, -32600, "batch_refused"],
		["keyed parse error", () => req("/mcp", { body: "{not json", headers: { ...J, authorization: "Bearer x" } }), 401, null, "missing_credential"],
	];
	for (const [label, run, status, rpcCode, code] of rpcCases) {
		const r = await run();
		if (rpcCode === null) {
			check(`${label}: credential refusal precedes parse (code+fix)`, r.status === status && r.json?.error === code && isFixLine(r.json?.fix), JSON.stringify(r.json));
			continue;
		}
		const e = r.json?.error ?? {};
		check(`${label}: HTTP ${status}, JSON-RPC ${rpcCode}, data.error=${code}, one-line fix, data.disclaimer D6`, r.status === status && e.code === rpcCode && e.data?.error === code && isFixLine(e.data?.fix) && e.data?.sec_disclaimer === D6 && e.data?.disclaimer === undefined, `${r.status} ${JSON.stringify(r.json)}`);
	}
	const leak = await req("/throw", { body: INIT, headers: J });
	check("500 body carries no raw cause", !JSON.stringify(leak.json).includes("secret-path"));
}

/* ------------------------------------------------------------------ */
section("E. the refusal vocabulary is one line each and passes the wording rule");
{
	const { REFUSAL_FIX } = await tryImport("refusals.js");
	const entries = Object.entries(REFUSAL_FIX ?? {});
	check("refusals module exports REFUSAL_FIX", entries.length > 0);
	check("every fix is one line, at most 200 chars", entries.every(([, f]) => isFixLine(f)), entries.filter(([, f]) => !isFixLine(f)).map(([k]) => k).join(","));
	check("no barred wording-guard word in a fix", entries.every(([, f]) => !/\b(verif\w*|vetted|audited)\b/i.test(f)));
}

await new Promise((r) => http.close(r));
process.exit(summary("front door") === 0 ? 0 : 1);
