/**
 * Signed relay identity (AEGIS mcp #14 M-1 = backend #835 M-2).
 *
 *   1. GOLDEN VECTOR shared byte for byte with the backend suite
 *      (apps/backend/test/agent_data_relay_identity.test.ts).
 *   2. Fail closed: flag not exactly "1", secret short/absent, no caller
 *      bucket, "unknown" bucket -> no header at all.
 *   3. End to end on /mcp/public against a stub upstream that verifies the
 *      header exactly as the backend does and keeps a per-bucket free
 *      ceiling: a busy agent exhausting ITS bucket does not turn another
 *      agent's call into a payment challenge; a caller-sent relay header is
 *      never forwarded; flag off sends nothing (today's behaviour).
 */

import { createHmac } from "node:crypto";
import { createServer as createNodeServer } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { check, resetCounters, section, summary } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "..", "dist");
const R = await import(path.join(DIST, "relayIdentity.js"));

const V = {
	secret: "relay-test-secret-0123456789abcdef-NOT-PROD",
	ts: "1800000000",
	nonce: "00112233445566778899aabbccddeeff",
	subject: "0f203d96fe376e2dc6fd76b66500975b4ab97f5aae7bdae8b9117381dac657fd",
	scope: "p4:sup-1",
	sig: "0dc91b03080ead11ccbebea103e69583e915d8c04bc6853d658d7b1f9a4a9376",
};
const ON = { enabled: true, secret: V.secret };

resetCounters();

section("1. golden vector (shared with the backend suite)");
check("header name", R.RELAY_IDENTITY_HEADER === "x-commertize-relay-identity");
check("relaySignature reproduces the backend's golden sig", R.relaySignature(V.secret, V.ts, V.nonce, V.subject, V.scope) === V.sig);
{
	const h = R.relayIdentityHeaders("p4:sup-1", { config: ON, nowSec: 1800000000, nonce: V.nonce, bucket: "203.0.113.9" });
	const parts = String(h[R.RELAY_IDENTITY_HEADER]).split(".");
	const subj = createHmac("sha256", V.secret).update("commertize-relay-subject/v1\n203.0.113.9").digest("hex");
	check("header layout v1.ts.nonce.subject.sig", parts.length === 5 && parts[0] === "v1" && parts[1] === V.ts && parts[2] === V.nonce && parts[3] === subj);
	check("sig over the backend's preimage", parts[4] === R.relaySignature(V.secret, V.ts, V.nonce, subj, "p4:sup-1"));
	check("the address itself is not in the header", !String(h[R.RELAY_IDENTITY_HEADER]).includes("203.0.113.9"));
	const h2 = R.relayIdentityHeaders("p4:sup-1", { config: ON, bucket: "203.0.113.9" });
	check("fresh random 32-hex nonce per call", /^[0-9a-f]{32}$/.test(String(h2[R.RELAY_IDENTITY_HEADER]).split(".")[2]) && h2[R.RELAY_IDENTITY_HEADER] !== R.relayIdentityHeaders("p4:sup-1", { config: ON, bucket: "203.0.113.9" })[R.RELAY_IDENTITY_HEADER]);
}

section("2. fail closed: nothing sent");
{
	const long = "x".repeat(32);
	check("default env: off, no secret", JSON.stringify(R.relayConfigFromEnv({})) === JSON.stringify({ enabled: false, secret: null }));
	for (const v of ["true", "yes", "1 ", " 1", "0", ""])
		check(`flag ${JSON.stringify(v)} is off`, R.relayConfigFromEnv({ COMMERTIZE_MCP_RELAY_IDENTITY_ENABLED: v, COMMERTIZE_MCP_RELAY_SECRET: long }).enabled === false);
	check("31-char secret is no secret", R.relayConfigFromEnv({ COMMERTIZE_MCP_RELAY_IDENTITY_ENABLED: "1", COMMERTIZE_MCP_RELAY_SECRET: "x".repeat(31) }).secret === null);
	check("32-char secret accepted", R.relayConfigFromEnv({ COMMERTIZE_MCP_RELAY_IDENTITY_ENABLED: "1", COMMERTIZE_MCP_RELAY_SECRET: long }).secret === long);
	const none = (o) => Object.keys(R.relayIdentityHeaders("p4:sup-1", o)).length === 0;
	check("flag off -> {}", none({ config: { enabled: false, secret: V.secret }, bucket: "203.0.113.9" }));
	check("no secret -> {}", none({ config: { enabled: true, secret: null }, bucket: "203.0.113.9" }));
	check("no caller in scope -> {}", none({ config: ON }));
	check("null bucket -> {}", none({ config: ON, bucket: null }));
	check("'unknown' bucket -> {}", none({ config: ON, bucket: "unknown" }));
	check("runAsRelayCaller scopes the bucket", R.runAsRelayCaller("198.51.100.7", () => Object.keys(R.relayIdentityHeaders("p4:sup-1", { config: ON })).length === 1) && none({ config: ON }));
}

/* ---- 3. end to end: stub upstream verifies like the backend ---------- */
const SECRET = "e2e-relay-secret-abcdefghijklmnopqrstuvwxyz";
const FREE = 3; // stub per-bucket free ceiling (backend: 100/day)
const used = new Map();
const seenNonces = new Set();
const seen = [];
const verify = (h, scope) => {
	const m = /^v1\.(\d{1,12})\.([0-9a-f]{32})\.([0-9a-f]{64})\.([0-9a-f]{64})$/.exec(h ?? "");
	if (!m) return null;
	const [, ts, nonce, subject, sig] = m;
	if (Math.abs(Date.now() / 1000 - Number(ts)) > 60) return null;
	if (createHmac("sha256", SECRET).update(`commertize-relay-identity/v1\n${ts}\n${nonce}\n${subject}\n${scope}`).digest("hex") !== sig) return null;
	if (seenNonces.has(nonce)) return null;
	seenNonces.add(nonce);
	return subject;
};
const upstream = createNodeServer((req, res) => {
	const p = req.url.split("?")[0];
	const h = req.headers["x-commertize-relay-identity"];
	seen.push(h ?? null);
	const json = (s, b) => {
		res.writeHead(s, { "content-type": "application/json" });
		res.end(JSON.stringify(b));
	};
	if (p !== "/api/agent-data/suppliers/sup-1/screen") return json(404, { error: "not_found" });
	const subject = verify(h, "p4:sup-1");
	const key = subject ? `relay:${subject}` : "ip:egress";
	const n = (used.get(key) ?? 0) + 1;
	used.set(key, n);
	if (n > FREE)
		return json(402, { error: "payment_required", fix: "Pay with x402.", accepts: [] });
	return json(200, { free: true, output: { supplier_id: "sup-1" } });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));

process.env.COMMERTIZE_API_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
process.env.COMMERTIZE_MCP_ENABLE_DATA_PRODUCTS = "1";
const { createPublicHttpHandler, PUBLIC_PATH } = await import(path.join(DIST, "httpPublic.js"));
const { FixedWindowLimiter } = await import(path.join(DIST, "httpRateLimit.js"));
const { createServer } = await import(path.join(DIST, "index.js"));
const handler = createPublicHttpHandler({
	enabled: () => true,
	ipLimiter: new FixedWindowLimiter(1000, 60_000),
	createServer: (cb) => createServer("public", cb),
	log: () => {},
	maxBodyBytes: 16384,
});
const http = createNodeServer((req, res) => handler(req, res));
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const URL_PUBLIC = `http://127.0.0.1:${http.address().port}${PUBLIC_PATH}`;
let id = 1;
const screen = async (ip, extra = {}) => {
	const r = await fetch(URL_PUBLIC, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-vercel-forwarded-for": ip, ...extra },
		body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "get_supplier_profile", arguments: { supplier_id: "sup-1" } } }),
	});
	const b = await r.json().catch(() => null);
	return b?.result?.structuredContent?.status ?? `http_${r.status}`;
};
const reset = () => {
	used.clear();
	seen.length = 0;
};
const A = "203.0.113.10";
const B = "198.51.100.20";

section("3a. flag OFF (default): behaviour identical to today");
{
	delete process.env.COMMERTIZE_MCP_RELAY_IDENTITY_ENABLED;
	process.env.COMMERTIZE_MCP_RELAY_SECRET = SECRET;
	reset();
	for (let i = 0; i < FREE; i++) await screen(A);
	check("no relay header sent with the flag off", seen.length === FREE && seen.every((h) => h === null));
	check("shared bucket: B is challenged after A used it up (today's defect, unchanged)", (await screen(B)) === "payment_required");
	reset();
	await screen(A, { "x-commertize-relay-identity": `v1.1.${"0".repeat(32)}.${"a".repeat(64)}.${"b".repeat(64)}` });
	check("a caller-sent relay header is never forwarded", seen.length === 1 && seen[0] === null);
}

section("3b. flag ON, secret set: each relayed agent has its own bucket");
{
	process.env.COMMERTIZE_MCP_RELAY_IDENTITY_ENABLED = "1";
	reset();
	const a = [];
	for (let i = 0; i < FREE + 1; i++) a.push(await screen(A));
	check("busy agent A exhausts ITS bucket", a.slice(0, FREE).every((s) => s === "delivered") && a[FREE] === "payment_required", a.join(","));
	check("agent B is NOT handed a false payment challenge", (await screen(B)) === "delivered");
	const subjects = new Set(seen.map((h) => String(h).split(".")[3]));
	check("two agents, two subjects; every header verified", subjects.size === 2 && [...used.keys()].every((k) => k.startsWith("relay:")), [...used.keys()].join(","));
	reset();
	const forged = `v1.${Math.floor(Date.now() / 1000)}.${"1".repeat(32)}.${"c".repeat(64)}.${"d".repeat(64)}`;
	await screen(A, { "x-commertize-relay-identity": forged });
	check("a caller-sent header is replaced by this server's own", seen.length === 1 && seen[0] !== null && seen[0] !== forged);
}

section("3c. flag ON, secret short: nothing sent, shared bucket");
{
	process.env.COMMERTIZE_MCP_RELAY_SECRET = "short";
	reset();
	await screen(A);
	check("no header with a short secret", seen.length === 1 && seen[0] === null && used.has("ip:egress"));
}

await new Promise((r) => http.close(r));
await new Promise((r) => upstream.close(r));
process.exit(summary("relay identity") === 0 ? 0 : 1);
