/**
 * submit_asset / get_submission_status (funnel map A2b/A3), stub upstream.
 *
 *  1. Gate closed (default, and DISABLE beats ENABLE): not listed, read_only.
 *  2. Gate open, no key: refuses NO_CREDENTIAL and sends nothing.
 *  3. Gate open + key: relays to the keyed route with x-api-key, returns the
 *     API's status and nothing it did not return.
 *  4. A money term or bad id is refused by the schema; nothing is sent.
 *  5. Upstream refusals and malformed bodies are reported, never as filed.
 * Run directly: node test/submission-e2e.mjs (needs loopback)
 */

import { createServer } from "node:http";
import { call, check, connect, resetCounters, section, summary } from "./harness.mjs";

const KEY = "ctz_0123456789abcdef_test-secret";
const ID = "22222222-2222-4222-8222-222222222222";
const STATUS = {
	submission_id: ID,
	counterparty_kind: "agent",
	received_at: "2026-10-21T10:00:00.000Z",
	updated_at: "2026-10-21T10:00:00.000Z",
	asset_class: "energy",
	size_band: "10m_to_500m",
	gate0: { state: "pending", profile: "agent_strict" },
	atlas: { state: "not_started" },
	documents_needed: [],
	principal_signature_required: true,
};

let seen = [];
let reply = { status: 201, body: STATUS };
const server = createServer((req, res) => {
	let raw = "";
	req.on("data", (c) => (raw += c));
	req.on("end", () => {
		seen.push({ method: req.method, url: req.url, key: req.headers["x-api-key"], body: raw ? JSON.parse(raw) : null });
		res.writeHead(reply.status, { "content-type": "application/json" });
		res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
	});
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const ARGS = {
	asset_class: "energy",
	location: { country: "US", region: "TX" },
	size_band: "10m_to_500m",
	documents_available: ["title_or_deed"],
	principal: {
		full_name: "Pat Principal",
		email: "principal@example.com",
		role: "Managing Member",
		authority_attested: true,
	},
};

const names = async (client) => (await client.listTools()).tools.map((t) => t.name);
const info = async (client) => (await call(client, "platform_info")).payload;

resetCounters();

section("1. gate closed");
for (const env of [
	{ COMMERTIZE_MCP_ENABLE_SUBMISSIONS: "" },
	{ COMMERTIZE_MCP_ENABLE_SUBMISSIONS: "true" },
	{ COMMERTIZE_MCP_ENABLE_SUBMISSIONS: "1 " },
	{ COMMERTIZE_MCP_ENABLE_SUBMISSIONS: "1", COMMERTIZE_MCP_DISABLE_SUBMISSIONS: "1" },
]) {
	const c = await connect({ ...env, COMMERTIZE_API_BASE_URL: BASE, COMMERTIZE_AGENT_KEY: KEY });
	const n = await names(c);
	check(`${JSON.stringify(env)}: submit_asset not listed`, !n.includes("submit_asset"));
	check(`${JSON.stringify(env)}: get_submission_status not listed`, !n.includes("get_submission_status"));
	const p = await info(c);
	check(`${JSON.stringify(env)}: platform_info omits them`, !JSON.stringify(p).includes("submit_asset"));
	await c.close();
}

section("2. gate open, no key");
{
	seen = [];
	const c = await connect({ COMMERTIZE_MCP_ENABLE_SUBMISSIONS: "1", COMMERTIZE_API_BASE_URL: BASE, COMMERTIZE_AGENT_KEY: "" });
	const n = await names(c);
	check("both tools listed", n.includes("submit_asset") && n.includes("get_submission_status"));
	const p = await info(c);
	check("platform_info lists submit_asset as a write", p?.capabilities?.write_tools?.includes("submit_asset"), JSON.stringify(p?.capabilities?.write_tools));
	check("platform_info read_only is false", p?.capabilities?.read_only === false);
	const { result, payload } = await call(c, "submit_asset", ARGS);
	check("no key -> isError", result.isError === true);
	check("no key -> NO_CREDENTIAL", payload?.error?.code === "NO_CREDENTIAL");
	check("no key -> nothing sent", seen.length === 0, JSON.stringify(seen));
	await c.close();
}

section("3. gate open + key");
{
	seen = [];
	reply = { status: 201, body: { ...STATUS, extra_field: "never relayed" } };
	const c = await connect({ COMMERTIZE_MCP_ENABLE_SUBMISSIONS: "1", COMMERTIZE_API_BASE_URL: BASE, COMMERTIZE_AGENT_KEY: KEY });
	const { result, payload } = await call(c, "submit_asset", ARGS);
	check("submit ok", !result.isError && payload?.error === null, JSON.stringify(payload?.error));
	check("one POST to /api/agents/submissions", seen.length === 1 && seen[0].method === "POST" && seen[0].url === "/api/agents/submissions", JSON.stringify(seen));
	check("key sent in x-api-key", seen[0]?.key === KEY);
	check("body is the arguments, unchanged", JSON.stringify(seen[0]?.body) === JSON.stringify(ARGS), JSON.stringify(seen[0]?.body));
	check("relays the id and states", payload?.submission?.submission_id === ID && payload?.submission?.gate0?.state === "pending");
	check("drops fields the schema does not name", !JSON.stringify(payload).includes("never relayed"));
	check("key never echoed", !JSON.stringify(payload).includes(KEY));

	seen = [];
	reply = { status: 200, body: { ...STATUS, gate0: { state: "needs_info", profile: "agent_strict" }, documents_needed: ["rent_roll"] } };
	const s = await call(c, "get_submission_status", { submission_id: ID });
	check("status GET path", seen.length === 1 && seen[0].method === "GET" && seen[0].url === `/api/agents/submissions/${ID}`, JSON.stringify(seen));
	check("status relays needs_info + documents", s.payload?.submission?.gate0?.state === "needs_info" && s.payload?.submission?.documents_needed?.[0] === "rent_roll");

	section("4. schema refusals send nothing");
	seen = [];
	for (const [label, args] of [
		["money term", { ...ARGS, target_raise: 10000000 }],
		["free text", { ...ARGS, message: "hello" }],
		["authority false", { ...ARGS, principal: { ...ARGS.principal, authority_attested: false } }],
		["no principal", (({ principal, ...r }) => r)(ARGS)],
		["markup", { ...ARGS, principal: { ...ARGS.principal, role: "<b>x</b>" } }],
		// commertize.com #876 r2 (AEGIS M-1): the organization comes from the
		// key holder's verified Sponsor row; a free-text one is refused.
		["free-text organization", { ...ARGS, principal: { ...ARGS.principal, organization: "Someone Else LLC" } }],
		["duplicate doc", { ...ARGS, documents_available: ["survey", "survey"] }],
	]) {
		let refused = false;
		try {
			const r = await c.callTool({ name: "submit_asset", arguments: args });
			refused = r.isError === true;
		} catch {
			refused = true;
		}
		check(`${label} refused`, refused);
	}
	let badId = false;
	try {
		const r = await c.callTool({ name: "get_submission_status", arguments: { submission_id: "../admin" } });
		badId = r.isError === true;
	} catch {
		badId = true;
	}
	check("non-uuid id refused", badId);
	check("nothing sent for any refusal", seen.length === 0, JSON.stringify(seen.map((x) => x.url)));

	section("5. upstream refusals");
	reply = { status: 403, body: { error: "principal_not_verified" } };
	const r403 = await call(c, "submit_asset", ARGS);
	check("403 -> UPSTREAM_ERROR, not retryable", r403.payload?.error?.code === "UPSTREAM_ERROR" && r403.payload?.error?.retryable === false && r403.payload?.error?.status === 403);
	check("403 -> no submission reported", r403.payload?.submission === null);
	check("403 -> reason relayed", r403.payload?.error?.message.includes("principal_not_verified"));
	reply = { status: 429, body: { error: "daily submission limit reached" } };
	check("429 retryable", (await call(c, "submit_asset", ARGS)).payload?.error?.retryable === true);
	reply = { status: 201, body: { ok: true } };
	const bad = await call(c, "submit_asset", ARGS);
	check("2xx without a status -> UPSTREAM_BAD_BODY, nothing reported filed", bad.payload?.error?.code === "UPSTREAM_BAD_BODY" && bad.payload?.submission === null);
	reply = { status: 201, body: "not json" };
	check("non-JSON 2xx -> UPSTREAM_BAD_BODY", (await call(c, "submit_asset", ARGS)).payload?.error?.code === "UPSTREAM_BAD_BODY");
	await c.close();
}

server.close();
process.exit(summary("submission e2e") > 0 ? 1 : 0);
