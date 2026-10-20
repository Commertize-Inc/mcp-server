/**
 * End-to-end suite for the per-call data product tools (dataProductTools.ts).
 * Real spawned server, real MCP stdio client, LOCAL stub upstream speaking
 * the backend /api/agent-data shapes (x402 v2).
 *
 *  1. GATE CLOSED = NOT LISTED (tools/list and platform_info).
 *  2. THIS SERVER NEVER SIGNS: payment_signature is forwarded byte-for-byte
 *     as PAYMENT-SIGNATURE; without one, no payment header is sent at all.
 *  3. NO INPUT ACCEPTS A KEY OR A PAYEE.
 *  4. EVERY BACKEND ANSWER IS RELAYED AS ITSELF: 200 profile, 402
 *     requirements, 404 not_found, 429 daily_cap vs rate_limited, 403/409.
 *  5. THE SUPPLIER ID CANNOT STEER THE PATH.
 */

import { createServer } from "node:http";

import { call, check, connect, resetCounters, section, summary } from "./harness.mjs";

const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const PROFILE = {
	supplier_id: "sup-1",
	legal_name: "Acme GPU LLC",
	jurisdiction: "US-DE",
	kyb_tier: "none",
	subjects: [{ kind: "entity", identifier: "Acme GPU LLC", status: "not_screened" }],
	disclosure: "Upstream operators may be pseudonymous.",
};

let mode = "free";
let seen = [];
const server = createServer((req, res) => {
	const path = req.url.split("?")[0];
	seen.push({ path, sig: req.headers["payment-signature"] ?? null, xpay: req.headers["x-payment"] ?? null });
	const json = (status, body) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};
	if (path === "/api/agent-data/products") {
		if (mode === "off") return json(404, { error: "not_found" });
		return json(200, {
			provider: "Commertize",
			products: [
				{
					id: "P4",
					name: "Supplier screen status",
					description: "d",
					payment: "Pay per call for Commertize data services",
					unit: "call",
					price_atomic: "50000",
					free_calls_per_day: 10,
					cap_per_payer_per_day_atomic: "5000000",
					cap_global_per_day_atomic: "100000000",
					network: "eip155:84532",
					pay_to: PAY_TO,
				},
			],
		});
	}
	if (path.startsWith("/api/agent-data/suppliers/")) {
		const sig = req.headers["payment-signature"];
		if (path !== "/api/agent-data/suppliers/sup-1/screen") return json(404, { error: "not_found" });
		if (mode === "free") return json(200, { output: PROFILE, free: true });
		if (mode === "cap") return json(429, { error: "daily_cap" });
		if (mode === "rate") return json(429, { error: "rate_limited" });
		if (mode === "refused") return json(403, { error: "COMPLIANCE_REVIEW" });
		if (!sig)
			return json(402, {
				x402Version: 2,
				error: "PAYMENT-SIGNATURE header is required",
				accepts: [
					{ scheme: "exact", network: "eip155:84532", amount: "50000", asset: "0xusdc", payTo: PAY_TO, maxTimeoutSeconds: 60 },
				],
				buyer_terms: { version: "2026-10-15.3" },
			});
		return json(200, { output: PROFILE, receipt: { signature: "0xsig" } });
	}
	json(404, { error: "not_found" });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const ON = {
	COMMERTIZE_API_BASE_URL: BASE,
	COMMERTIZE_MCP_ENABLE_DATA_PRODUCTS: "1",
	COMMERTIZE_MCP_DISABLE_DATA_PRODUCTS: "",
};
const NAMES = ["data_products_catalog", "get_supplier_profile"];

resetCounters();

section("gate closed: the tools do not exist");
{
	for (const env of [
		{ COMMERTIZE_API_BASE_URL: BASE, COMMERTIZE_MCP_ENABLE_DATA_PRODUCTS: "" },
		{ COMMERTIZE_API_BASE_URL: BASE, COMMERTIZE_MCP_ENABLE_DATA_PRODUCTS: "true" },
		{ ...ON, COMMERTIZE_MCP_DISABLE_DATA_PRODUCTS: "1" },
	]) {
		const client = await connect(env);
		const listed = (await client.listTools()).tools.map((t) => t.name);
		for (const n of NAMES) check(`${n} absent (${JSON.stringify(env).slice(-60)})`, !listed.includes(n));
		const { payload: info } = await call(client, "platform_info");
		check("platform_info lists neither", !NAMES.some((n) => info.capabilities.tools.includes(n)));
		check("platform_info write_tools lacks get_supplier_profile", !info.capabilities.write_tools.includes("get_supplier_profile"));
		await client.close();
	}
}

section("gate open: listed, advertised, inputs carry no key or payee");
{
	const client = await connect(ON);
	const tools = (await client.listTools()).tools;
	for (const n of NAMES) check(`${n} listed`, tools.some((t) => t.name === n));
	const { payload: info } = await call(client, "platform_info");
	check("platform_info lists both", NAMES.every((n) => info.capabilities.tools.includes(n)));
	check("get_supplier_profile is a write (it can spend)", info.capabilities.write_tools.includes("get_supplier_profile"));
	for (const t of tools.filter((t) => NAMES.includes(t.name))) {
		const keys = Object.keys(t.inputSchema?.properties ?? {});
		check(`${t.name}: no key/seed/payee input`, !keys.some((k) => /key|seed|mnemonic|private|pay_to|payto|payee/i.test(k)));
	}
	const sp = tools.find((t) => t.name === "get_supplier_profile");
	check("description says it is not a score or approval", /not a score, a rating or an approval/.test(sp.description));
	check("description never claims a screened supply chain", !/supply chain (is|was) screened/i.test(sp.description));
	await client.close();
}

section("catalog relays the listed products");
{
	const client = await connect(ON);
	mode = "free";
	const { payload } = await call(client, "data_products_catalog");
	check("one product", payload.products?.length === 1);
	check("price is the integer string", payload.products?.[0].price_atomic === "50000");
	check("payee relayed", payload.products?.[0].pay_to === PAY_TO);
	mode = "off";
	const { payload: off } = await call(client, "data_products_catalog");
	check("backend off: products null with a note", off.products === null && typeof off.note === "string");
	await client.close();
}

section("get_supplier_profile relays every answer as itself");
{
	const client = await connect(ON);
	seen = [];
	mode = "free";
	const { payload: free } = await call(client, "get_supplier_profile", { supplier_id: "sup-1" });
	check("free call delivered", free.status === "delivered" && free.free === true);
	check("profile relayed", free.profile?.disclosure === PROFILE.disclosure);
	check("no payment header sent without payment_signature", seen.at(-1).sig === null && seen.at(-1).xpay === null);

	mode = "paid";
	const { payload: quote } = await call(client, "get_supplier_profile", { supplier_id: "sup-1" });
	check("402 relayed as payment_required", quote.status === "payment_required");
	check("requirements relayed (amount, payTo)", quote.requirements?.amount === "50000" && quote.requirements?.pay_to === PAY_TO);
	check("buyer terms relayed", quote.buyer_terms?.version === "2026-10-15.3");

	const SIG = Buffer.from(JSON.stringify({ x402Version: 2, payload: { signature: "0xabc" } })).toString("base64");
	const { payload: paid } = await call(client, "get_supplier_profile", { supplier_id: "sup-1", payment_signature: SIG });
	check("payment forwarded byte-for-byte", seen.at(-1).sig === SIG);
	check("forwarded as v2 PAYMENT-SIGNATURE, not v1 X-PAYMENT", seen.at(-1).xpay === null);
	check("paid call delivered with receipt", paid.status === "delivered" && paid.receipt?.signature === "0xsig");
	check("a paid delivery is not reported as free", paid.free === false);

	const { payload: nf } = await call(client, "get_supplier_profile", { supplier_id: "nope" });
	check("unknown supplier: not_found, no profile", nf.status === "not_found" && nf.profile === null);

	mode = "cap";
	const { payload: cap } = await call(client, "get_supplier_profile", { supplier_id: "sup-1" });
	check("daily cap relayed as daily_cap", cap.status === "daily_cap");
	mode = "rate";
	const { payload: rate } = await call(client, "get_supplier_profile", { supplier_id: "sup-1" });
	check("rate limit relayed as rate_limited", rate.status === "rate_limited");
	mode = "refused";
	const { payload: ref } = await call(client, "get_supplier_profile", { supplier_id: "sup-1" });
	check("403 relayed with its code", ref.status === "refused" && ref.refusal_code === "COMPLIANCE_REVIEW");
	await client.close();
}

section("the supplier id cannot steer the path");
{
	const client = await connect(ON);
	seen = [];
	for (const bad of ["../products", "sup-1/../../x", "a?b=1", "a b", "x".repeat(65), ""]) {
		const r = await client.callTool({ name: "get_supplier_profile", arguments: { supplier_id: bad } });
		check(`refused: ${JSON.stringify(bad).slice(0, 20)}`, r.isError === true);
	}
	check("no upstream request for any refused id", seen.length === 0);
	await client.close();
}

server.close();
summary("data products e2e");
