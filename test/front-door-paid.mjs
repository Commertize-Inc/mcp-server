/**
 * The KEY-FREE paid path on `/mcp/public` (front door, slice 2).
 *
 *   1. Gate closed (default): the public surface is the free three; a call
 *      naming a paid tool is 403 tool_not_public. (child process, own env)
 *   2. Gate open: tools/list adds data_products_catalog and
 *      get_supplier_profile, the latter priced `x402` with a free tier.
 *   3. A paid call with NO key and no payment is HTTP 200 carrying the x402
 *      requirements (pay_to, amount) and the sign-in-with-x challenge, never
 *      401: the agent can pay or claim its free calls.
 *   4. wallet_proof is forwarded verbatim as SIGN-IN-WITH-X and
 *      payment_signature as PAYMENT-SIGNATURE; nothing else is invented, and
 *      no Authorization header is ever sent upstream.
 *   5. Every public result carries D-1; the backend's one-line fix is relayed.
 *   6. The agent card lists the paid skills only while the gate is open.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as createNodeServer } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { check, resetCounters, section, summary } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "..", "dist");
const PAY_TO = "0x168b420cC50C994F8FefAC9b1fb8e30ca31479d0";
const D1_ID = "apx-b88a8f669d";
const PRICING_KEY = "com.commertize/pricing";
const apx = (s) => "apx-" + createHash("sha1").update(s, "utf8").digest("hex").slice(0, 10);

const seen = [];
let mode = "challenge";
const upstream = createNodeServer((req, res) => {
	const p = req.url.split("?")[0];
	seen.push({
		path: p,
		sig: req.headers["payment-signature"] ?? null,
		siwx: req.headers["sign-in-with-x"] ?? null,
		auth: req.headers.authorization ?? null,
	});
	const json = (s, b) => {
		res.writeHead(s, { "content-type": "application/json" });
		res.end(JSON.stringify(b));
	};
	if (p === "/api/agent-data/products")
		return json(200, {
			products: [
				{
					id: "P4", name: "Supplier screen status", description: "d", payment: "p", unit: "call",
					price_atomic: "50000", free_calls_per_day: 10, free_calls_per_wallet_per_day: 20,
					cap_per_payer_per_day_atomic: "5000000", cap_global_per_day_atomic: "100000000",
					network: "eip155:84532", pay_to: PAY_TO,
				},
			],
		});
	if (p === "/api/agent-data/suppliers/sup-1/screen") {
		if (req.headers["sign-in-with-x"] === "GOOD-PROOF") return json(200, { output: { supplier_id: "sup-1" }, free: true });
		if (req.headers["payment-signature"] === "SIGNED") return json(200, { output: { supplier_id: "sup-1" }, receipt: { payload: "r" }, free: false });
		if (mode === "bad_proof") return json(400, { error: "siwx_bad_signature", fix: "The signature does not recover to the address in the proof. Sign with that wallet." });
		if (mode === "multiline_fix") return json(429, { error: "daily_cap", fix: "line one\nline two" });
		return json(402, {
			x402Version: 2,
			error: "PAYMENT-SIGNATURE header is required",
			accepts: [{ scheme: "exact", network: "eip155:84532", amount: "50000", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", payTo: PAY_TO, maxTimeoutSeconds: 60 }],
			fix: "Pay with x402: sign the accepts[0] requirements and resend with PAYMENT-SIGNATURE, or send SIGN-IN-WITH-X for free calls.",
			extensions: {
				"sign-in-with-x": {
					info: { domain: "api.commertize.com", uri: "https://api.commertize.com/agent-data/suppliers/sup-1/screen", version: "1", nonce: "n0nce1234567", issuedAt: "2026-10-20T00:00:00.000Z", statement: "Claim up to 20 free calls per day for this wallet." },
					supportedChains: [{ chainId: "eip155:84532", type: "eip191" }, { chainId: "bogus", type: "eip191" }],
					header: "SIGN-IN-WITH-X",
				},
			},
		});
	}
	res.writeHead(404).end();
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;

resetCounters();

/* ------------------------------------------------------------------ */
section("1. gate closed (default): the paid tools are not public");
{
	const probe = `
		const { createServer } = await import(${JSON.stringify(path.join(DIST, "index.js"))});
		const { isPublicTool } = await import(${JSON.stringify(path.join(DIST, "publicSurface.js"))});
		const { AGENT_CARD } = await import(${JSON.stringify(path.join(DIST, "agentCard.js"))});
		const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
		const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
		const s = createServer("public");
		const [a, b] = InMemoryTransport.createLinkedPair();
		const c = new Client({ name: "t", version: "0" });
		await Promise.all([s.connect(a), c.connect(b)]);
		const { tools } = await c.listTools();
		console.log(JSON.stringify({ tools: tools.map((t) => t.name).sort(), paidPublic: isPublicTool("get_supplier_profile"), skills: AGENT_CARD.skills.map((s) => s.id) }));
		await c.close();
	`;
	const env = { ...process.env, COMMERTIZE_API_BASE_URL: UPSTREAM };
	delete env.COMMERTIZE_MCP_ENABLE_DATA_PRODUCTS;
	const out = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { env, cwd: path.resolve(HERE, ".."), encoding: "utf8" });
	let r = null;
	try {
		r = JSON.parse(out.stdout.trim().split("\n").at(-1));
	} catch {}
	check("closed: public tools/list is the free three", JSON.stringify(r?.tools) === JSON.stringify(["get_article", "get_news", "platform_info"]), out.stdout + out.stderr);
	check("closed: get_supplier_profile is not a public tool", r?.paidPublic === false);
	check("closed: the agent card lists no paid skill", JSON.stringify(r?.skills) === JSON.stringify(["get_news", "get_article", "platform_info"]));
}

/* ------------------------------------------------------------------ */
process.env.COMMERTIZE_API_BASE_URL = UPSTREAM;
process.env.COMMERTIZE_MCP_ENABLE_DATA_PRODUCTS = "1";
const { createPublicHttpHandler, PUBLIC_PATH } = await import(path.join(DIST, "httpPublic.js"));
const { FixedWindowLimiter } = await import(path.join(DIST, "httpRateLimit.js"));
const { createServer } = await import(path.join(DIST, "index.js"));
const { AGENT_CARD } = await import(path.join(DIST, "agentCard.js"));
const results = [];
const handler = createPublicHttpHandler({
	enabled: () => true,
	ipLimiter: new FixedWindowLimiter(1000, 60_000),
	createServer: (onToolResult) => createServer("public", (t, r, d) => {
		results.push(t);
		onToolResult?.(t, r, d);
	}),
	log: () => {},
	maxBodyBytes: 16384,
});
const http = createNodeServer((req, res) => handler(req, res));
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const URL_PUBLIC = `http://127.0.0.1:${http.address().port}${PUBLIC_PATH}`;
let id = 10;
const rpc = async (method, params = {}) => {
	const r = await fetch(URL_PUBLIC, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-vercel-forwarded-for": "203.0.113.9" },
		body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
	});
	return { status: r.status, body: await r.json().catch(() => null) };
};
const call = (name, args) => rpc("tools/call", { name, arguments: args });

section("2. gate open: the paid tools are listed, priced, annotated");
{
	const l = await rpc("tools/list");
	const tools = l.body?.result?.tools ?? [];
	const names = tools.map((t) => t.name).sort();
	check("tools/list = free three + the two data products", JSON.stringify(names) === JSON.stringify(["data_products_catalog", "get_article", "get_news", "get_supplier_profile", "platform_info"]), names.join(","));
	const gsp = tools.find((t) => t.name === "get_supplier_profile") ?? {};
	const p = gsp._meta?.[PRICING_KEY] ?? {};
	check("get_supplier_profile pricing: x402 v2 exact USDC, free tier, price from the challenge", p.model === "x402" && p.x402_version === 2 && p.scheme === "exact" && p.asset === "USDC" && p.free_tier === true && p.price_source === "x402_challenge", JSON.stringify(p));
	check("get_supplier_profile is not read-only and is idempotent (same signature replays)", gsp.annotations?.readOnlyHint === false && gsp.annotations?.idempotentHint === true && gsp.annotations?.destructiveHint === false);
	check("the input accepts wallet_proof and payment_signature, and no key or payee", ["wallet_proof", "payment_signature", "supplier_id"].every((k) => k in (gsp.inputSchema?.properties ?? {})) && !Object.keys(gsp.inputSchema?.properties ?? {}).some((k) => /key|pay_?to|payee|auth/i.test(k)));
	const cat = tools.find((t) => t.name === "data_products_catalog");
	check("data_products_catalog is free and read-only", cat?._meta?.[PRICING_KEY]?.model === "free" && cat?.annotations?.readOnlyHint === true);
	check("the agent card lists the paid skills while the gate is open", AGENT_CARD.skills.some((s) => s.id === "get_supplier_profile" && s.tags.includes("x402")));
}

section("3. no key, no payment: HTTP 200 with the x402 challenge, never 401");
{
	seen.length = 0;
	const r = await call("get_supplier_profile", { supplier_id: "sup-1" });
	const sc = r.body?.result?.structuredContent ?? {};
	check("HTTP 200 (not 401/403)", r.status === 200, String(r.status));
	check("status payment_required", sc.status === "payment_required", JSON.stringify(sc).slice(0, 300));
	check("requirements carry pay_to and the atomic amount", sc.requirements?.pay_to === PAY_TO && sc.requirements?.amount === "50000" && sc.requirements?.network === "eip155:84532");
	const ch = sc.wallet_proof_challenge ?? {};
	check("the sign-in-with-x challenge is relayed (header, domain, uri, nonce)", ch.header === "SIGN-IN-WITH-X" && ch.domain === "api.commertize.com" && ch.uri?.endsWith("/sup-1/screen") && ch.nonce === "n0nce1234567");
	check("an off-shape chain entry is dropped, the good one kept", JSON.stringify(ch.supported_chains) === JSON.stringify([{ chain_id: "eip155:84532", type: "eip191" }]));
	check("the paid result carries the D6 disclaimer as sec_disclaimer (AXIOM cert 10-20 §1)", sc.sec_disclaimer === "Commertize is not registered with or regulated by the SEC as a broker-dealer or investment adviser. This is not a recommendation or investment advice. Consult your own advisers.");
	check("the backend's one-line fix is relayed", typeof sc.fix === "string" && sc.fix.startsWith("Pay with x402"));
	check("D-1 on the paid result (apx id pinned here)", typeof sc.disclaimer === "string" && apx(sc.disclaimer) === D1_ID, String(sc.disclaimer).slice(0, 80));
	check("no payment or proof header was invented upstream", seen.length === 1 && seen[0].sig === null && seen[0].siwx === null && seen[0].auth === null);
}

section("4. wallet_proof and payment_signature are forwarded verbatim");
{
	seen.length = 0;
	const f = await call("get_supplier_profile", { supplier_id: "sup-1", wallet_proof: "GOOD-PROOF" });
	const fs = f.body?.result?.structuredContent ?? {};
	check("a wallet proof yields a free delivery", fs.status === "delivered" && fs.free === true, JSON.stringify(fs).slice(0, 200));
	check("forwarded as SIGN-IN-WITH-X, no payment header", seen[0]?.siwx === "GOOD-PROOF" && seen[0]?.sig === null && seen[0]?.auth === null);
	seen.length = 0;
	const p = await call("get_supplier_profile", { supplier_id: "sup-1", payment_signature: "SIGNED" });
	check("a signed payment yields a paid delivery", p.body?.result?.structuredContent?.status === "delivered" && p.body?.result?.structuredContent?.free === false);
	check("forwarded as PAYMENT-SIGNATURE, no proof header", seen[0]?.sig === "SIGNED" && seen[0]?.siwx === null && seen[0]?.auth === null);
	mode = "bad_proof";
	const b = await call("get_supplier_profile", { supplier_id: "sup-1", wallet_proof: "BAD" });
	const bs = b.body?.result?.structuredContent ?? {};
	check("a refused proof relays its code and fix (HTTP 200 tool result)", b.status === 200 && bs.refusal_code === "siwx_bad_signature" && bs.fix?.startsWith("The signature"), JSON.stringify(bs).slice(0, 300));
	mode = "multiline_fix";
	const m = await call("get_supplier_profile", { supplier_id: "sup-1" });
	check("a multi-line upstream fix is not relayed", m.body?.result?.structuredContent?.fix === null);
	mode = "challenge";
}

section("5. the catalog relays the per-wallet free tier");
{
	const c = await call("data_products_catalog", {});
	const prod = c.body?.result?.structuredContent?.products?.[0] ?? {};
	check("free_calls_per_wallet_per_day relayed", prod.free_calls_per_wallet_per_day === 20 && prod.pay_to === PAY_TO, JSON.stringify(prod));
	check("public observer saw the paid tool results", results.includes("get_supplier_profile") && results.includes("data_products_catalog"));
}

await new Promise((r) => http.close(r));
await new Promise((r) => upstream.close(r));
process.exit(summary("front door paid") === 0 ? 0 : 1);
