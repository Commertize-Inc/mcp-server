/**
 * The keyed 401 -> no-key endpoint path, and its gate.
 *
 *   A. A keyless client that calls the keyed `/mcp` gets a 401 whose `fix`
 *      names the no-key endpoint, and following that line works: `initialize`
 *      and `tools/list` on `/mcp/public` with no key, exactly the public three,
 *      a public tool answers, an offering tool is refused, and no session is
 *      kept between requests.
 *   B. W2 (what we tell agents names only endpoints that answer): while the
 *      public gate is CLOSED (unset flag, or the kill switch), no refusal on any
 *      surface names `/mcp/public`, and no refusal ever names an agent card (none is served). The `fix` line is left
 *      out rather than replaced, so no new copy is introduced.
 *   C. Production wiring: `httpEntry`'s keyed handler follows the same gate as
 *      the public handler (child processes, one per environment).
 *
 * DIST may be overridden (PG_DIST) so the same file runs against a base build
 * to show which checks are red without this change.
 */

import { spawn } from "node:child_process";
import { createServer as createNodeServer } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.PG_DIST ?? path.resolve(HERE, "..", "dist");

const tryImport = async (f) => {
	try {
		return await import(path.join(DIST, f));
	} catch {
		return {};
	}
};

/* Pinned HERE, never read back from the module under test. */
const PUBLIC_URL = "https://agents.commertize.com/mcp/public";
const POINTER = /\/mcp\/public|agent-card\.json|agent\.json/;
const PUBLIC_THREE = ["get_article", "get_news", "platform_info"];
const D6 = "Commertize is not registered with or regulated by the SEC as a broker-dealer or investment adviser. This is not a recommendation or investment advice. Consult your own advisers.";

const J = { "content-type": "application/json" };
const INIT = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pointer-agent", version: "2.1" } } });
const LIST = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
const CALL = (name) => JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: {} } });

const listen = async (route) => {
	const s = createNodeServer(route);
	await new Promise((r) => s.listen(0, "127.0.0.1", r));
	return { server: s, base: `http://127.0.0.1:${s.address().port}` };
};

const fetchJson = async (base, p, { method = "POST", body, headers = {} } = {}) => {
	const r = await fetch(`${base}${p}`, { method, headers: { accept: "application/json, text/event-stream", ...headers }, body });
	const text = await r.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {}
	return { status: r.status, json, text, headers: r.headers };
};

/* ------------------------------------------------------------------ */
/* C, child side: one environment per process, because config is read at import. */
if (process.env.PG_CHILD === "1") {
	const entry = await tryImport("httpEntry.js");
	if (typeof entry.handler !== "function") {
		process.stdout.write(JSON.stringify({ missing: true }));
		process.exit(0);
	}
	const { server, base } = await listen((req, res) => {
		entry.handler(req, res).catch(() => {
			if (!res.headersSent) res.writeHead(599).end();
		});
	});
	const r = await fetchJson(base, "/mcp", { body: INIT, headers: J });
	await new Promise((ok) => server.close(ok));
	process.stdout.write(JSON.stringify({ status: r.status, json: r.json, text: r.text }));
	process.exit(0);
}

const { check, resetCounters, section, summary } = await import("./harness.mjs");
const { createServer } = await tryImport("index.js");
const { createPublicHttpHandler, createOpenApiHandler, PUBLIC_PATH = "/mcp/public" } = await tryImport("httpPublic.js");
const { createHttpHandler } = await tryImport("httpServer.js");
const { FixedWindowLimiter } = await tryImport("httpRateLimit.js");

resetCounters();

let publicOpen = true;
const events = [];
const verifierAnswering = (code, status) => ({
	configured: true,
	isCached: () => true,
	verify: async () => ({ ok: false, status, code, message: "refused", cached: true }),
});
const keyedWith = (verifier) =>
	createHttpHandler?.({
		verifier,
		requestLimiter: new FixedWindowLimiter(1000, 60_000),
		inquiryLimiter: new FixedWindowLimiter(1000, 60_000),
		verifyLimiter: new FixedWindowLimiter(1000, 60_000),
		createServer: () => createServer("http"),
		log: () => {},
		maxBodyBytes: 4096,
		version: "test",
		publicOpen: () => publicOpen,
	});
const keyed = {
	missing: keyedWith(verifierAnswering("missing_credential", 401)),
	invalid: keyedWith(verifierAnswering("invalid_credential", 401)),
	notConfigured: keyedWith({ configured: false, isCached: () => false, verify: async () => ({ ok: false, status: 503, code: "verifier_not_configured", message: "refused", cached: false }) }),
};
const publicHandler = createPublicHttpHandler?.({
	enabled: () => publicOpen,
	ipLimiter: new FixedWindowLimiter(1000, 60_000),
	createServer: () => createServer("public"),
	log: (e) => events.push(e),
	maxBodyBytes: 4096,
});
const openApi = createOpenApiHandler?.({ enabled: () => publicOpen });

const { server: http, base: BASE } = await listen((req, res) => {
	const u = new URL(req.url, "http://x");
	const p = u.pathname;
	let h;
	if (p === "/openapi.json") h = openApi;
	else if (p === "/mcp" || p === "/health" || p.startsWith("/health/")) {
		h = keyed[u.searchParams.get("v") ?? "missing"];
		req.url = p;
	} else h = publicHandler;
	if (typeof h !== "function") {
		res.writeHead(501).end();
		return;
	}
	h(req, res).catch(() => {
		if (!res.headersSent) res.writeHead(599).end();
	});
});
const req = (p, o) => fetchJson(BASE, p, o);

/* ------------------------------------------------------------------ */
section("A. keyless client: the keyed 401 points at the no-key endpoint, and the pointer works");
{
	publicOpen = true;
	const k = await req("/mcp", { body: INIT, headers: J });
	check("keyless initialize on /mcp: 401 missing_credential", k.status === 401 && k.json?.error === "missing_credential", `${k.status} ${k.text.slice(0, 160)}`);
	check("the 401 fix names the no-key endpoint", typeof k.json?.fix === "string" && k.json.fix.includes(PUBLIC_URL), String(k.json?.fix));
	check("the 401 carries D6 as sec_disclaimer", k.json?.sec_disclaimer === D6);

	const target = typeof k.json?.fix === "string" && k.json.fix.includes(PUBLIC_URL) ? new URL(PUBLIC_URL).pathname : null;
	check("the pointed-at path is the public path", target === PUBLIC_PATH, String(target));
	const i = await req(target ?? PUBLIC_PATH, { body: INIT, headers: J });
	check("following it: initialize with no key is 200 with serverInfo", i.status === 200 && i.json?.result?.serverInfo?.name === "commertize", `${i.status} ${i.text.slice(0, 160)}`);
	check("no session: the initialize response sets no mcp-session-id", i.status === 200 && i.headers.get("mcp-session-id") === null);
	const l = await req(PUBLIC_PATH, { body: LIST, headers: J });
	const names = (l.json?.result?.tools ?? []).map((t) => t.name).sort();
	check("no session: tools/list without a session id is 200", l.status === 200, String(l.status));
	check("tools/list is exactly the public three", JSON.stringify(names) === JSON.stringify(PUBLIC_THREE), names.join(","));
	const c = await req(PUBLIC_PATH, { body: CALL("platform_info"), headers: J });
	check("a public tool answers (platform_info)", c.status === 200 && c.json?.result?.isError !== true && typeof c.json?.result?.structuredContent === "object", `${c.status} ${c.text.slice(0, 160)}`);
	for (const t of ["list_offerings", "get_offering"]) {
		const o = await req(PUBLIC_PATH, { body: CALL(t), headers: J });
		check(`${t} is refused on the no-key surface (403 tool_not_public)`, o.status === 403 && o.json?.error?.data?.error === "tool_not_public", `${o.status} ${o.text.slice(0, 160)}`);
	}
	const logged = events.filter((e) => e.event === "public_request" && Array.isArray(e.rpc) && e.rpc.includes("initialize"));
	check("the initialize log line carries clientInfo name and version", logged.some((e) => e.client_name === "pointer-agent" && e.client_version === "2.1"), JSON.stringify(logged.at(-1) ?? {}));
	check("no public log line carries the client address", events.length > 0 && !JSON.stringify(events).includes("127.0.0.1"));
}

/* ------------------------------------------------------------------ */
section("B. gate closed: no refusal names the no-key endpoint or the card (W2)");
{
	publicOpen = false;
	const cases = [
		["keyed 401 missing_credential", () => req("/mcp?v=missing", { body: INIT, headers: J }), 401, "missing_credential"],
		["keyed 401 invalid_credential", () => req("/mcp?v=invalid", { body: INIT, headers: { ...J, authorization: "Bearer cfa_x" } }), 401, "invalid_credential"],
		["keyed verifier_not_configured", () => req("/mcp?v=notConfigured", { body: INIT, headers: { ...J, authorization: "Bearer cfa_x" } }), null, "verifier_not_configured"],
		["keyed 404", () => req("/health/x?v=missing", { method: "GET" }), 404, "not_found"],
		["public 404", () => req(PUBLIC_PATH, { body: INIT, headers: J }), 404, "not_found"],
		["openapi 404", () => req("/openapi.json", { method: "GET" }), 404, "not_found"],
		["well-known 404 (no card served)", () => req("/.well-known/agent-card.json", { method: "GET" }), 404, "not_found"],
	];
	for (const [label, run, status, code] of cases) {
		const r = await run();
		const statusOk = status === null ? r.status >= 400 : r.status === status;
		check(`${label}: same code, still JSON`, statusOk && r.json?.error === code, `${r.status} ${r.text.slice(0, 160)}`);
		check(`${label}: names no closed endpoint`, r.json !== null && !POINTER.test(r.text), r.text.slice(0, 200));
		check(`${label}: keeps D6`, r.json?.sec_disclaimer === D6);
	}
	publicOpen = true;
	const control = await req("/nope", { body: INIT, headers: J });
	// not_found's certified line also names the agent card, which this server
	// no longer serves, so it is never sent; the open-gate 401 in A is the
	// control that a pointer line still goes out when its URL answers.
	check("gate OPEN: a 404 on another path is not_found with no card pointer", control.status === 404 && control.json?.error === "not_found" && !/agent-card\.json|agent\.json/.test(control.text), control.text.slice(0, 200));
	const k = await req("/mcp?v=missing", { body: INIT, headers: J });
	check("control: gate OPEN, the keyed 401 names the no-key endpoint again", k.status === 401 && (k.json?.fix ?? "").includes(PUBLIC_URL), k.text.slice(0, 200));
}

/* ------------------------------------------------------------------ */
section("C. production wiring: the keyed handler follows the public gate");
{
	const child = (env) =>
		new Promise((resolve) => {
			const base = { ...process.env, PG_CHILD: "1", COMMERTIZE_API_BASE_URL: `http://${[127, 0, 0, 1].join(".")}:${9}` };
			delete base.COMMERTIZE_MCP_ENABLE_PUBLIC;
			delete base.COMMERTIZE_MCP_DISABLE_PUBLIC;
			const p = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"] });
			let out = "";
			p.stdout.on("data", (d) => (out += d));
			p.on("exit", () => {
				try {
					resolve(JSON.parse(out));
				} catch {
					resolve({ text: out });
				}
			});
		});
	const runs = [
		["flag unset", {}, false],
		["ENABLE=1", { COMMERTIZE_MCP_ENABLE_PUBLIC: "1" }, true],
		["ENABLE=1 + kill switch", { COMMERTIZE_MCP_ENABLE_PUBLIC: "1", COMMERTIZE_MCP_DISABLE_PUBLIC: "1" }, false],
		["ENABLE=true (not exactly 1)", { COMMERTIZE_MCP_ENABLE_PUBLIC: "true" }, false],
	];
	for (const [label, env, expectPointer] of runs) {
		const r = await child(env);
		const refused = typeof r.status === "number" && r.status >= 400 && typeof r.json?.error === "string";
		const pointed = POINTER.test(r.text ?? "");
		check(`${label}: keyless /mcp is refused with a JSON code`, refused, JSON.stringify(r).slice(0, 200));
		check(`${label}: ${expectPointer ? "names" : "does not name"} the no-key endpoint`, refused && pointed === expectPointer, (r.text ?? "").slice(0, 200));
	}
}

await new Promise((r) => http.close(r));
process.exit(summary("pointer gate") === 0 ? 0 : 1);
