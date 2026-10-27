/**
 * Directory-listing readiness for the public surface (listing review handoff
 * 2026-10-19 F-2 / F-3), offline.
 *
 *   1. Every tool on `/mcp/public` declares annotations with readOnlyHint
 *      true, destructiveHint not true, and an annotations.title equal to its
 *      top-level title (directory portals read the annotations).
 *   2. Every tool a fully-opened stdio build registers, and every keyed-HTTP
 *      tool, declares readOnlyHint explicitly (a boolean, never missing).
 *   3. GET /openapi.json is served only when the public gate is open (404
 *      otherwise, like /mcp/public itself), documents exactly /health and
 *      /mcp/public, never the keyed /mcp, and names exactly the three
 *      public tools.
 */

import { createServer as createNodeServer } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { check, connect, LOOPBACK, resetCounters, section, summary } from "./harness.mjs";

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const PUBLIC_THREE = ["get_news", "get_article", "platform_info"];

resetCounters();

const { createServer } = await import(path.join(DIST, "index.js"));
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const listOn = async (surface) => {
	const s = createServer(surface);
	const [a, b] = InMemoryTransport.createLinkedPair();
	await s.connect(a);
	const c = new Client({ name: "listing-readiness", version: "0" });
	await c.connect(b);
	const { tools } = await c.listTools();
	await c.close();
	return tools;
};

section("1. public tools: readOnlyHint true + annotations.title");
{
	const tools = await listOn("public");
	check(
		"public surface lists exactly the three",
		JSON.stringify(tools.map((t) => t.name)) === JSON.stringify(PUBLIC_THREE),
		tools.map((t) => t.name).join(",")
	);
	for (const t of tools) {
		const a = t.annotations ?? {};
		check(`${t.name}: readOnlyHint === true`, a.readOnlyHint === true, JSON.stringify(a));
		check(`${t.name}: destructiveHint not true`, a.destructiveHint !== true);
		check(
			`${t.name}: annotations.title === title (non-empty)`,
			typeof t.title === "string" && t.title.length > 0 && a.title === t.title,
			`${a.title} vs ${t.title}`
		);
	}
}

section("2. every registered tool declares readOnlyHint explicitly");
{
	const client = await connect({
		COMMERTIZE_MCP_ENABLE_OFFERINGS: "1",
		COMMERTIZE_MCP_ENABLE_SANDBOX: "1",
		COMMERTIZE_MCP_ENABLE_X402: "1",
		COMMERTIZE_MCP_ENABLE_MEMO: "1",
		COMMERTIZE_MCP_ENABLE_DISCLOSURE: "1",
		COMMERTIZE_MCP_ENABLE_INQUIRY: "1",
	});
	const { tools } = await client.listTools();
	await client.close();
	check("positive control: the opened build registers more than 10 tools", tools.length > 10, String(tools.length));
	const missing = tools.filter((t) => typeof t.annotations?.readOnlyHint !== "boolean").map((t) => t.name);
	check("no tool without an explicit readOnlyHint", missing.length === 0, missing.join(","));
	for (const t of await listOn("http")) {
		check(`keyed ${t.name}: readOnlyHint is boolean`, typeof t.annotations?.readOnlyHint === "boolean");
	}
}

section("3. GET /openapi.json");
{
	const mod = await import(path.join(DIST, "httpPublic.js"));
	check("httpPublic exports createOpenApiHandler", typeof mod.createOpenApiHandler === "function");
	if (typeof mod.createOpenApiHandler === "function") {
		let enabled = false;
		const h = mod.createOpenApiHandler({ enabled: () => enabled });
		const srv = createNodeServer((req, res) => void h(req, res));
		await new Promise((r) => srv.listen(0, LOOPBACK, r));
		const base = `http://${LOOPBACK}:${srv.address().port}`;

		let r = await fetch(`${base}/openapi.json`);
		check("gate closed: 404", r.status === 404, String(r.status));
		enabled = true;
		r = await fetch(`${base}/openapi.json`);
		check("gate open: 200", r.status === 200, String(r.status));
		check("content-type is JSON", /^application\/json/.test(r.headers.get("content-type") ?? ""));
		const spec = await r.json();
		check("openapi 3.1.x", /^3\.1\./.test(spec.openapi ?? ""), spec.openapi);
		check("server is agents.commertize.com", spec.servers?.[0]?.url === "https://agents.commertize.com");
		const paths = Object.keys(spec.paths ?? {}).sort();
		check(
			"paths are exactly /health and /mcp/public (keyed /mcp left out)",
			JSON.stringify(paths) === JSON.stringify(["/health", "/mcp/public"]),
			paths.join(",")
		);
		check(
			"/mcp/public is POST only",
			JSON.stringify(Object.keys(spec.paths?.["/mcp/public"] ?? {})) === JSON.stringify(["post"])
		);
		const text = JSON.stringify(spec).toLowerCase();
		check("names the three public tools", PUBLIC_THREE.every((n) => text.includes(n)));
		for (const bad of ["list_offerings", "list_sponsors", "get_offering", "x402", "sandbox", "bearer", "verif", "real estate"]) {
			check(`document never contains '${bad}'`, !text.includes(bad));
		}
		r = await fetch(`${base}/openapi.json`, { method: "POST" });
		check("POST is 405", r.status === 405, String(r.status));
		r = await fetch(`${base}/other.json`);
		check("other path is 404", r.status === 404, String(r.status));
		srv.close();
	}
}

process.exit(summary("listing readiness") === 0 ? 0 : 1);
