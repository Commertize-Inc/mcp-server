/**
 * Production gate wiring in src/httpEntry.ts, tested through the BUILT
 * handlers (dist/httpEntry.js), one child process per environment because
 * config is read at import time.
 *
 * The public endpoint and /openapi.json must answer only when
 * COMMERTIZE_MCP_ENABLE_PUBLIC is exactly "1", and the kill switch wins. A
 * call-site mutant (`enabled: () => true` in httpEntry.ts) must turn this red;
 * a unit test of `publicDisabledFrom` alone cannot see it.
 *
 * Run directly: node test/entry-gate.mjs (after npm run build)
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { check, resetCounters, section, summary } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = pathToFileURL(path.resolve(HERE, "..", "dist", "httpEntry.js")).href;

const CHILD = `
import http from "node:http";
const { publicHandler, openApiHandler } = await import(${JSON.stringify(ENTRY)});
const host = [127, 0, 0, 1].join(".");
const srv = http.createServer((q, s) => {
	const h = q.url.startsWith("/openapi.json") ? openApiHandler : publicHandler;
	void h(q, s);
});
await new Promise((r) => srv.listen(0, host, r));
const base = "http://" + host + ":" + srv.address().port;
const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
const pub = await fetch(base + "/mcp/public", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: init });
const api = await fetch(base + "/openapi.json");
process.stdout.write(JSON.stringify({ pub: pub.status, api: api.status }));
srv.close();
process.exit(0);
`;

const child = (env) =>
	new Promise((resolve) => {
		const base = { ...process.env };
		delete base.COMMERTIZE_MCP_ENABLE_PUBLIC;
		delete base.COMMERTIZE_MCP_DISABLE_PUBLIC;
		const p = spawn(process.execPath, ["--input-type=module", "-e", CHILD], { env: { ...base, ...env } });
		let out = "";
		p.stdout.on("data", (d) => (out += d));
		p.on("close", () => {
			try {
				resolve(JSON.parse(out));
			} catch {
				resolve({ pub: null, api: null, raw: out });
			}
		});
	});

resetCounters();
section("public endpoint and openapi follow COMMERTIZE_MCP_ENABLE_PUBLIC, exact \"1\"");
const runs = [
	["unset", {}, false],
	["empty", { COMMERTIZE_MCP_ENABLE_PUBLIC: "" }, false],
	["true", { COMMERTIZE_MCP_ENABLE_PUBLIC: "true" }, false],
	["1 with space", { COMMERTIZE_MCP_ENABLE_PUBLIC: "1 " }, false],
	["1 + kill switch", { COMMERTIZE_MCP_ENABLE_PUBLIC: "1", COMMERTIZE_MCP_DISABLE_PUBLIC: "1" }, false],
	["1", { COMMERTIZE_MCP_ENABLE_PUBLIC: "1" }, true],
];
for (const [label, env, open] of runs) {
	const r = await child(env);
	check(`${label}: /mcp/public ${open ? "answers 200" : "is 404"}`, open ? r.pub === 200 : r.pub === 404, JSON.stringify(r));
	check(`${label}: /openapi.json ${open ? "answers 200" : "is 404"}`, open ? r.api === 200 : r.api === 404, JSON.stringify(r));
}
process.exit(summary("entry gate") ? 1 : 0);
