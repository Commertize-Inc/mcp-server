/**
 * `get_disclosure_package` against a stub upstream.
 *
 * What is pinned: the offerings gate holds it closed by default; a served
 * package is relayed with its signature and verification endpoints intact
 * (the tool RELAYS, it does not restate — a restatement could drift from the
 * signed bytes); a 404 from the API is a typed NOT_FOUND, not an exception;
 * and the tool never asks for anything but an offering id.
 */

import { createServer } from "node:http";

import {
	call,
	check,
	connect,
	resetCounters,
	section,
	summary,
} from "./harness.mjs";

const PACKAGE = {
	schema: "commertize.disclosure/1",
	offeringId: "off-1",
	generatedAt: "2026-09-08T12:00:00.000Z",
	terms: {
		tokenPrice: { value: 5000, provenance: "sponsor_reported", asOf: "2026-09-01T00:00:00.000Z" },
	},
};
const SIGNATURE = {
	alg: "Ed25519",
	keyId: "0123456789abcdef",
	canonicalization: "commertize-jcs/1",
	sha256: "ab".repeat(32),
	value: "c2ln",
};

let hits = [];
const server = createServer((req, res) => {
	const path = req.url.split("?")[0];
	hits.push(path);
	const json = (status, body) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};
	if (path === "/api/offerings/v1/off-1/disclosure") {
		return json(200, {
			package: PACKAGE,
			signature: SIGNATURE,
			verify: {
				keysUrl: "http://stub/api/agents/signing/keys",
				verifyUrl: "http://stub/api/agents/signing/verify",
			},
			pdfUrl: "http://stub/api/offerings/v1/off-1/disclosure.pdf",
		});
	}
	if (path.startsWith("/api/offerings/v1/")) {
		return json(404, { error: "No disclosure package for that id." });
	}
	return json(404, { error: "not found" });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

resetCounters();

section("closed by default");
{
	const client = await connect({
		COMMERTIZE_API_BASE_URL: BASE,
		COMMERTIZE_MCP_ENABLE_DISCLOSURE: "1",
		COMMERTIZE_MCP_DISABLE_DISCLOSURE: "",
	});
	const { tools } = await client.listTools();
	check(
		"registered",
		tools.some((t) => t.name === "get_disclosure_package")
	);
	const tool = tools.find((t) => t.name === "get_disclosure_package");
	check(
		"takes only an offering id",
		JSON.stringify(Object.keys(tool?.inputSchema?.properties ?? {})) ===
			JSON.stringify(["offering_id"])
	);
	const { payload } = await call(client, "get_disclosure_package", {
		offering_id: "off-1",
	});
	check("gate: TOOL_DISABLED", payload.error?.code === "TOOL_DISABLED");
	check("gate: no package", payload.package === null);
	check("gate: upstream never called", hits.length === 0);
	await client.close();
}

section("relays a served package with its signature");
{
	hits = [];
	const client = await connect({
		COMMERTIZE_API_BASE_URL: BASE,
		COMMERTIZE_MCP_ENABLE_OFFERINGS: "1",
		COMMERTIZE_MCP_ENABLE_DISCLOSURE: "1",
		COMMERTIZE_MCP_DISABLE_DISCLOSURE: "",
	});
	const { payload } = await call(client, "get_disclosure_package", {
		offering_id: "off-1",
	});
	check("no error", payload.error === null, JSON.stringify(payload.error));
	check(
		"package relayed byte-for-byte",
		JSON.stringify(payload.package) === JSON.stringify(PACKAGE)
	);
	check("signature.key_id", payload.signature?.key_id === SIGNATURE.keyId);
	check("signature.sha256", payload.signature?.sha256 === SIGNATURE.sha256);
	check("signature.value", payload.signature?.value === SIGNATURE.value);
	check(
		"verify endpoints relayed",
		payload.verify?.keys_url.endsWith("/api/agents/signing/keys") &&
			payload.verify?.verify_url.endsWith("/api/agents/signing/verify")
	);
	check("pdf url relayed", payload.pdf_url?.endsWith("/disclosure.pdf"));
	check(
		"source url is the disclosure endpoint",
		payload.source_url === `${BASE}/api/offerings/v1/off-1/disclosure`
	);
	check("disclaimer present", typeof payload.disclaimer === "string");
	check(
		"called the versioned path once",
		hits.filter((h) => h === "/api/offerings/v1/off-1/disclosure").length === 1
	);
	await client.close();
}

section("a refused id is NOT_FOUND, not an exception");
{
	const client = await connect({
		COMMERTIZE_API_BASE_URL: BASE,
		COMMERTIZE_MCP_ENABLE_OFFERINGS: "1",
		COMMERTIZE_MCP_ENABLE_DISCLOSURE: "1",
		COMMERTIZE_MCP_DISABLE_DISCLOSURE: "",
	});
	const { result, payload } = await call(client, "get_disclosure_package", {
		offering_id: "designated-row",
	});
	check("isError", result.isError === true);
	check("NOT_FOUND", payload.error?.code === "NOT_FOUND");
	check("not retryable", payload.error?.retryable === false);
	check("no package", payload.package === null);
	check("no signature", payload.signature === null);
	await client.close();
}

server.close();
const failures = summary("disclosure e2e");
process.exit(failures ? 1 : 0);
