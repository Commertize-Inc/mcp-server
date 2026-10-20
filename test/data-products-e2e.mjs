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
 *     requirements, 404 not_found, 429 daily_cap vs rate_limited, 403/409,
 *     409 refund_queued as its own status, 202 with its tx hash, 503 codes.
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
		if (mode === "refund") return json(409, { error: "refund_queued" });
		if (mode === "mismatch") return json(409, { error: "input_mismatch" });
		if (mode === "pending")
			return json(202, { status: "pending", retry: "resend the same request", transaction: "0x" + "cd".repeat(32) });
		if (mode === "pending_notx") return json(202, { status: "pending", retry: "resend the same request" });
		if (mode === "pending_junk") return json(202, { status: "pending", transaction: "see etherscan <a>" });
		if (mode === "drift") return json(503, { error: "output_drift" });
		// DP-FLAG-18: refusals for an authorization that already settled.
		const PAID = { settled: true, transaction: "0x" + "ab".repeat(32), job_id: "job-1", receipt_issued: true };
		if (mode === "paid_refused") return json(403, { error: "COMPLIANCE_REVIEW", payment: PAID });
		if (mode === "paid_mismatch") return json(409, { error: "input_mismatch", payment: PAID });
		if (mode === "paid_drift") return json(503, { error: "output_drift", payment: PAID });
		if (mode === "paid_noreceipt")
			return json(409, { error: "input_mismatch", payment: { ...PAID, receipt_issued: false } });
		if (mode === "paid_junk_tx") return json(503, { error: "output_drift", payment: { ...PAID, transaction: "see <a>" } });
		if (mode === "paid_junk_job") return json(503, { error: "output_drift", payment: { ...PAID, job_id: "../x" } });
		if (mode === "paid_false") return json(409, { error: "input_mismatch", payment: { ...PAID, settled: false } });
		if (mode === "down") return json(503, { error: "unavailable" });
		// DP-FLAG-23: the backend refused a signed payment without settling it.
		if (mode === "sig_402") return json(402, { x402Version: 2, error: "payment_failed", accepts: [] });
		if (mode === "hangup") return req.socket.destroy();
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
// Pinned as a literal, not imported, so a changed caution string fails here.
const CAUTION =
	"No result was delivered for this call, and the payment authorization you signed may still settle until its expiry. Do not re-sign with a new nonce; to retry, resend the same payment_signature.";

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
	check("a refusal carries no transaction", ref.transaction === null);

	// AEGIS mcp #12 L-1: money moved and a refund is queued; never "refused".
	mode = "refund";
	const { payload: rq } = await call(client, "get_supplier_profile", { supplier_id: "sup-1", payment_signature: SIG });
	check("409 refund_queued is its own status", rq.status === "refund_queued" && rq.refusal_code === "refund_queued");
	check("refund_queued is never reported as refused", rq.status !== "refused");
	mode = "mismatch";
	const { payload: mm } = await call(client, "get_supplier_profile", { supplier_id: "sup-1", payment_signature: SIG });
	check("any other 409 stays refused with its code", mm.status === "refused" && mm.refusal_code === "input_mismatch");

	// AEGIS mcp #12 L-2: the 202 keeps the on-chain reference.
	mode = "pending";
	const { payload: pe } = await call(client, "get_supplier_profile", { supplier_id: "sup-1", payment_signature: SIG });
	check("202 pending relays the transaction hash", pe.status === "pending" && pe.transaction === "0x" + "cd".repeat(32));
	mode = "pending_notx";
	const { payload: pn } = await call(client, "get_supplier_profile", { supplier_id: "sup-1", payment_signature: SIG });
	check("202 without a transaction: null, not invented", pn.status === "pending" && pn.transaction === null);
	mode = "pending_junk";
	const { payload: pj } = await call(client, "get_supplier_profile", { supplier_id: "sup-1", payment_signature: SIG });
	check("a non-hash transaction value is not relayed", pj.status === "pending" && pj.transaction === null);

	// Backend #817 L-2: a paid replay that drifted is told apart from an outage.
	mode = "drift";
	const { payload: dr } = await call(client, "get_supplier_profile", { supplier_id: "sup-1", payment_signature: SIG });
	check("503 output_drift relayed as unavailable with its code", dr.status === "unavailable" && dr.refusal_code === "output_drift");
	mode = "down";
	const { payload: dn } = await call(client, "get_supplier_profile", { supplier_id: "sup-1" });
	check("a plain 503 is unavailable", dn.status === "unavailable" && dn.refusal_code === "unavailable");
	check("a refusal without a payment block makes no payment claim", dn.payment_settled === null && dn.payment_note === null);

	// DP-FLAG-18: after a settled payment, never "nothing charged".
	const TXP = "0x" + "ab".repeat(32);
	const NOTE = "Payment settled, receipt job-1. This call was not charged again.";
	for (const [m, st, code] of [
		["paid_refused", "refused", "COMPLIANCE_REVIEW"],
		["paid_mismatch", "refused", "input_mismatch"],
		["paid_drift", "unavailable", "output_drift"],
	]) {
		mode = m;
		const { payload: pp } = await call(client, "get_supplier_profile", { supplier_id: "sup-1", payment_signature: SIG });
		check(
			`${m}: settled payment relayed (${st}/${code}, receipt, not charged again)`,
			pp.status === st &&
				pp.refusal_code === code &&
				pp.payment_settled === true &&
				pp.transaction === TXP &&
				pp.receipt_id === "job-1" &&
				pp.payment_note === NOTE,
		);
		check(`${m}: the note never says nothing was charged`, !/nothing (was )?charged/i.test(JSON.stringify(pp)));
	}
	mode = "paid_noreceipt";
	const { payload: nr } = await call(client, "get_supplier_profile", { supplier_id: "sup-1", payment_signature: SIG });
	check(
		"settled without a receipt: no receipt id, tx and job in the note",
		nr.payment_settled === true &&
			nr.receipt_id === null &&
			nr.payment_note === `Payment settled (transaction ${TXP}, job job-1). This call was not charged again.`,
	);
	// A malformed block makes no SETTLEMENT claim. On the 503s the signed
	// authorization is still an unknown, so the DP-FLAG-23 caution applies.
	for (const [m, note] of [
		["paid_junk_tx", CAUTION],
		["paid_junk_job", CAUTION],
		["paid_false", null],
	]) {
		mode = m;
		const { payload: pk } = await call(client, "get_supplier_profile", { supplier_id: "sup-1", payment_signature: SIG });
		check(`${m}: a malformed payment block makes no settlement claim`, pk.payment_settled === null && pk.transaction === null && pk.payment_note === note);
	}

	// DP-FLAG-23 (independent M-2): a 402/503/transport failure answered to a
	// SIGNED request never reads as "nothing charged".
	for (const [m, st] of [
		["sig_402", "payment_required"],
		["down", "unavailable"],
		["drift", "unavailable"],
		["hangup", "unavailable"],
	]) {
		mode = m;
		const { payload: sp } = await call(client, "get_supplier_profile", { supplier_id: "sup-1", payment_signature: SIG });
		check(`${m} after a signature: ${st} with the may-still-settle caution`, sp.status === st && sp.payment_note === CAUTION && sp.payment_settled === null);
		check(`${m} after a signature: never "nothing charged"`, !/nothing (was )?charged|not charged/i.test(JSON.stringify(sp)));
	}
	// Without a signature there is nothing that could settle: no caution.
	for (const m of ["sig_402", "down", "hangup"]) {
		mode = m;
		const { payload: un } = await call(client, "get_supplier_profile", { supplier_id: "sup-1" });
		check(`${m} unsigned: no caution`, un.payment_note === null);
	}
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
process.exit(summary("data products e2e") === 0 ? 0 : 1);
