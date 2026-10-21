/**
 * End-to-end suite for the OmniGrid tools (omnigridTools.ts). Real spawned
 * server, real MCP stdio client, LOCAL stub upstream speaking the backend
 * /api/omnigrid/v1 shapes (x402 v2).
 *
 *  1. GATE: both COMMERTIZE_MCP_ENABLE_OMNIGRID=1 and the data gate, or the
 *     tools do not exist (tools/list and platform_info agree).
 *  2. THIS SERVER NEVER SIGNS: payment_signature forwarded byte for byte.
 *  3. NO INPUT ACCEPTS A KEY OR A PAYEE; copy never claims headroom.
 *  4. The query the backend sees is the canonical one (sorted, known keys).
 *  5. Every backend answer is relayed as itself (200, 400, 402, 404, 503).
 */

import { createServer } from "node:http";

import { call, check, connect, resetCounters, section, summary } from "./harness.mjs";

const PAY_TO = "0x168b420cC50C994F8FefAC9b1fb8e30ca31479d0";
const TERMS = "https://commertize.com/omnigrid/data-terms#interconnection-queue";
let mode = "quote";
let seen = [];
const server = createServer((req, res) => {
	const [path, qs = ""] = req.url.split("?");
	seen.push({ path, qs, sig: req.headers["payment-signature"] ?? null, proof: req.headers["sign-in-with-x"] ?? null });
	const json = (status, body) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};
	if (!path.startsWith("/api/omnigrid/v1/")) return json(404, { error: "not_found" });
	if (mode === "off") return json(404, { error: "not_found" });
	if (mode === "bad") return json(400, { error: "unknown_region", field: "iso", terms_url: TERMS });
	if (mode === "stale") return json(503, { error: "unavailable", status: "unavailable", reason: "no_servable_iso", terms_url: TERMS });
	// Backend #868 N-1: a stored authorization retried without the payer's proof.
	if (mode === "used" && !req.headers["sign-in-with-x"])
		return json(402, { x402Version: 2, error: "authorization_used", accepts: [], terms_url: TERMS });
	if (mode === "evil_terms") return json(402, { x402Version: 2, error: "x", accepts: [], terms_url: "https://evil.example/terms" });
	const sig = req.headers["payment-signature"];
	if (!sig)
		return json(402, {
			x402Version: 2,
			error: "PAYMENT-SIGNATURE header is required",
			accepts: [{ scheme: "exact", network: "eip155:84532", amount: "100000", asset: "0xusdc", payTo: PAY_TO, maxTimeoutSeconds: 60 }],
			buyer_terms: { version: "x" },
			terms_url: TERMS,
		});
	return json(200, { output: { schema: "s", as_of: "t", records: [{ queue_id: "J1" }] }, receipt: { signature: "0xsig" }, terms_url: TERMS });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const ON = {
	COMMERTIZE_API_BASE_URL: BASE,
	COMMERTIZE_MCP_ENABLE_DATA_PRODUCTS: "1",
	COMMERTIZE_MCP_DISABLE_DATA_PRODUCTS: "",
	COMMERTIZE_MCP_ENABLE_OMNIGRID: "1",
	COMMERTIZE_MCP_DISABLE_OMNIGRID: "",
};
const NAMES = ["omnigrid_interconnection_queue", "omnigrid_site_feasibility"];

resetCounters();

section("gate closed: the tools do not exist");
for (const env of [
	{ ...ON, COMMERTIZE_MCP_ENABLE_OMNIGRID: "" },
	{ ...ON, COMMERTIZE_MCP_ENABLE_OMNIGRID: "true" },
	{ ...ON, COMMERTIZE_MCP_DISABLE_OMNIGRID: "1" },
	{ ...ON, COMMERTIZE_MCP_ENABLE_DATA_PRODUCTS: "" },
]) {
	const client = await connect(env);
	const listed = (await client.listTools()).tools.map((t) => t.name);
	for (const n of NAMES) check(`${n} absent (${JSON.stringify(env).slice(-70)})`, !listed.includes(n));
	const { payload: info } = await call(client, "platform_info");
	check("platform_info lists neither", !NAMES.some((n) => info.capabilities.tools.includes(n)));
	await client.close();
}

section("gate open: listed, advertised as spending tools, inputs carry no key or payee");
{
	const client = await connect(ON);
	const tools = (await client.listTools()).tools;
	for (const n of NAMES) check(`${n} listed`, tools.some((t) => t.name === n));
	const { payload: info } = await call(client, "platform_info");
	check("platform_info lists both", NAMES.every((n) => info.capabilities.tools.includes(n)));
	check("both are write tools (they can spend)", NAMES.every((n) => info.capabilities.write_tools.includes(n)));
	check("can_transact", info.capabilities.can_transact === true);
	for (const t of tools.filter((t) => NAMES.includes(t.name))) {
		const keys = Object.keys(t.inputSchema?.properties ?? {});
		check(`${t.name}: no key/seed/payee input`, !keys.some((k) => /key|seed|mnemonic|private|pay_to|payto|payee/i.test(k)));
		check(`${t.name}: no wallet_proof input (no free calls)`, !keys.includes("wallet_proof"));
		check(`${t.name}: copy never claims headroom or a likelihood`, !/headroom|likelihood|guarantee|buildable/i.test(t.description));
		check(`${t.name}: x402 pricing meta, no free tier`, t._meta?.["com.commertize/pricing"]?.free_tier === false);
	}
	// AXIOM CERT_omnigrid_og_strings_2026-10-20, byte-for-byte.
	const site = tools.find((t) => t.name === "omnigrid_site_feasibility");
	const queue = tools.find((t) => t.name === "omnigrid_interconnection_queue");
	check("CERT: site title", site?.title === "Site screening data (US)", site?.title);
	check(
		"CERT: site description",
		site?.description ===
			"Use when you need public screening data for a US site for a data center or compute load. Returns, for a point in the US, its county and the pending public interconnection queue filings in that county, or in counties within a radius, with each field's source and status. Substation capacity, transmission, fiber and zoning are reported as not available. Screening data, not an engineering, interconnection or site study, and not a statement that the site can be powered. Paid per call with x402 (radius search costs more): sign the returned requirements with your own wallet and pass the encoded payment as payment_signature. This server never signs.",
	);
	check("CERT: queue title unchanged", queue?.title === "Interconnection queue filings (US ISOs)");
	check(
		"CERT: queue description names filed in-service year",
		queue?.description.includes(
			"Returns normalized public queue filings (for region_snapshot: totals by state, fuel and filed in-service year) with each source and as-of date.",
		),
	);
	check(
		"CERT B-4: no use input on the site tool",
		!Object.keys(site?.inputSchema?.properties ?? {}).includes("use"),
	);
	await client.close();
}

section("queries are canonical; payment forwarded verbatim");
{
	const client = await connect(ON);
	seen = [];
	mode = "quote";
	const { payload: q } = await call(client, "omnigrid_interconnection_queue", { state: "ar", iso: "MISO", mw_min: 50 });
	check("402 relayed as payment_required", q.status === "payment_required");
	check("requirements relayed", q.requirements?.amount === "100000" && q.requirements?.pay_to === PAY_TO);
	check("terms_url relayed", q.terms_url === TERMS);
	check("path", seen.at(-1).path === "/api/omnigrid/v1/interconnection-queue");
	check("query sorted, known keys only", seen.at(-1).qs === "iso=MISO&mw_min=50&state=ar", seen.at(-1).qs);
	check("no payment header without payment_signature", seen.at(-1).sig === null);

	const SIG = "eyJ4NDAyVmVyc2lvbiI6Mn0=";
	const { payload: paid } = await call(client, "omnigrid_interconnection_queue", { iso: "MISO", payment_signature: SIG });
	check("payment_signature forwarded byte for byte", seen.at(-1).sig === SIG);
	check("200 relayed as delivered with data and receipt", paid.status === "delivered" && paid.data?.records?.[0]?.queue_id === "J1" && paid.receipt !== null);

	const n0 = seen.length;
	for (const bad of ["abc\r\nX-Evil: 1", "has space", "{json}"]) {
		const { result } = await call(client, "omnigrid_interconnection_queue", { iso: "MISO", payment_signature: bad });
		check(`non-base64 payment_signature refused (${JSON.stringify(bad)})`, result.isError === true);
	}
	check("refused signatures never reach the upstream", seen.length === n0);

	await call(client, "omnigrid_interconnection_queue", { iso: "PJM", region_snapshot: true });
	check("region path, iso only", seen.at(-1).path === "/api/omnigrid/v1/interconnection-queue/region" && seen.at(-1).qs === "iso=PJM");

	const before = seen.length;
	const { payload: noIso } = await call(client, "omnigrid_interconnection_queue", { region_snapshot: true });
	check("region without iso: bad_input, upstream not called", noIso.status === "bad_input" && seen.length === before);

	// AEGIS r2 mcp16 L-1: region_snapshot with any other filter is refused,
	// never silently dropped into a 1.00 USDC ISO-totals purchase.
	for (const [k, v] of [["state", "VA"], ["mw_min", 10], ["mw_max", 50], ["project_id", "J1"], ["status", "all"]]) {
		const { payload } = await call(client, "omnigrid_interconnection_queue", { iso: "PJM", region_snapshot: true, [k]: v });
		check(`region_snapshot + ${k}: bad_input on ${k}, upstream not called`, payload.status === "bad_input" && payload.field === k && seen.length === before);
	}
	const { payload: falseRegion } = await call(client, "omnigrid_interconnection_queue", { iso: "PJM", state: "VA", region_snapshot: false });
	check("region_snapshot:false with filters is a lookup", falseRegion.status !== "bad_input" && seen.at(-1).path === "/api/omnigrid/v1/interconnection-queue");

	await call(client, "omnigrid_site_feasibility", { lat: 34.77, lon: -92.31 });
	check("site basic: no radius_km", seen.at(-1).path === "/api/omnigrid/v1/site-feasibility" && seen.at(-1).qs === "lat=34.77&lon=-92.31");
	await call(client, "omnigrid_site_feasibility", { lon: -92.31, lat: 34.77, radius_km: 20, target_mw: 50 });
	check("site radius: canonical", seen.at(-1).qs === "lat=34.77&lon=-92.31&radius_km=20&target_mw=50", seen.at(-1).qs);
	await client.close();
}

section("retries: the payer's SIGN-IN-WITH-X proof is forwarded verbatim (backend #868 N-1)");
{
	const client = await connect(ON);
	const { tools } = await client.listTools();
	for (const t of tools.filter((x) => NAMES.includes(x.name))) {
		const p = t.inputSchema?.properties?.payer_proof;
		check(`${t.name}: payer_proof input exists`, !!p);
		check(`${t.name}: payer_proof is described as a SIGN-IN-WITH-X retry proof`, /SIGN-IN-WITH-X/.test(p?.description ?? "") && /retr/i.test(p?.description ?? ""));
		// Tool descriptions are AXIOM-certified byte for byte and stay as they
		// are; the retry instruction lives on the new input only.
		check(`${t.name}: payer_proof says it needs payment_signature`, /payment_signature/.test(p?.description ?? ""));
	}
	seen = [];
	mode = "quote";
	const SIG = "eyJ4NDAyVmVyc2lvbiI6Mn0=";
	const PROOF = "eyJ0eXBlIjoiZWlwMTkxIn0=";
	await call(client, "omnigrid_interconnection_queue", { iso: "MISO", payment_signature: SIG });
	check("no SIGN-IN-WITH-X header without payer_proof", seen.at(-1).proof === null);
	await call(client, "omnigrid_interconnection_queue", { iso: "MISO", payment_signature: SIG, payer_proof: PROOF });
	check("queue: payer_proof forwarded byte for byte as SIGN-IN-WITH-X", seen.at(-1).proof === PROOF && seen.at(-1).sig === SIG);
	await call(client, "omnigrid_interconnection_queue", { iso: "PJM", region_snapshot: true, payment_signature: SIG, payer_proof: PROOF });
	check("region: payer_proof forwarded", seen.at(-1).proof === PROOF);
	await call(client, "omnigrid_site_feasibility", { lat: 34.77, lon: -92.31, payment_signature: SIG, payer_proof: PROOF });
	check("site: payer_proof forwarded", seen.at(-1).proof === PROOF);

	const n0 = seen.length;
	const { payload: alone } = await call(client, "omnigrid_interconnection_queue", { iso: "MISO", payer_proof: PROOF });
	check("payer_proof without payment_signature: bad_input on payer_proof, upstream not called", alone.status === "bad_input" && alone.field === "payer_proof" && seen.length === n0);
	const { payload: alone2 } = await call(client, "omnigrid_site_feasibility", { lat: 34.77, lon: -92.31, payer_proof: PROOF });
	check("site: payer_proof alone is bad_input, upstream not called", alone2.status === "bad_input" && seen.length === n0);
	for (const bad of ["abc\r\nX-Evil: 1", "has space", "{json}", "a".repeat(4097)]) {
		const { result } = await call(client, "omnigrid_interconnection_queue", { iso: "MISO", payment_signature: SIG, payer_proof: bad });
		check(`malformed payer_proof refused (${JSON.stringify(bad).slice(0, 24)})`, result.isError === true);
	}
	check("refused proofs never reach the upstream", seen.length === n0);

	mode = "used";
	const { payload: used } = await call(client, "omnigrid_interconnection_queue", { iso: "MISO", payment_signature: SIG });
	check("402 authorization_used relayed with its code", used.status === "payment_required" && used.refusal_code === "authorization_used");
	const { payload: ok } = await call(client, "omnigrid_interconnection_queue", { iso: "MISO", payment_signature: SIG, payer_proof: PROOF });
	check("the payer's retry with proof is delivered", ok.status === "delivered");
	await client.close();
}

section("refusals relayed as themselves");
{
	const client = await connect(ON);
	mode = "bad";
	const { payload: bad } = await call(client, "omnigrid_interconnection_queue", { iso: "MISO" });
	check("400 -> bad_input with code and field", bad.status === "bad_input" && bad.refusal_code === "unknown_region" && bad.field === "iso");
	mode = "stale";
	const { payload: st } = await call(client, "omnigrid_site_feasibility", { lat: 34.7, lon: -92.3 });
	check("503 -> unavailable with reason, never zero data", st.status === "unavailable" && st.reason === "no_servable_iso" && st.data === null);
	const { payload: st2 } = await call(client, "omnigrid_site_feasibility", { lat: 34.7, lon: -92.3, payment_signature: "x" });
	check("503 after a signed payment carries the caution", typeof st2.payment_note === "string");
	mode = "off";
	const { payload: off } = await call(client, "omnigrid_interconnection_queue", { iso: "MISO" });
	check("404 -> not_found", off.status === "not_found");
	mode = "evil_terms";
	const { payload: evil } = await call(client, "omnigrid_interconnection_queue", { iso: "MISO" });
	check("a non-commertize terms link is never relayed", evil.terms_url === null);
	await client.close();
}

server.close();
process.exit(summary("omnigrid e2e") ? 1 : 0);
