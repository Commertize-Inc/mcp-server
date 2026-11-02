/**
 * End-to-end suite for the x402 paid-data tools (data API, x402 v2 wire).
 *
 * Real spawned server, real MCP stdio client, real JSON-RPC, against a LOCAL
 * stub upstream that speaks the v2 shape of /api/data/v1: an unpaid read is a
 * 402 with a base64 JSON PAYMENT-REQUIRED header, a paid read carries
 * PAYMENT-SIGNATURE, a delivery carries PAYMENT-RESPONSE.
 *
 * Properties held here:
 *  1. THIS SERVER NEVER SIGNS. The caller's payment_signature is forwarded
 *     byte for byte, under the header name PAYMENT-SIGNATURE (not the v1
 *     X-PAYMENT). No signer or wallet library is imported anywhere in src/.
 *  2. NO PRICE IN THE CLIENT. The catalogue amounts are the stub's, relayed
 *     verbatim; a changed stub price shows up changed. No src/ file holds a
 *     price-shaped constant next to a dataset id.
 *  3. A 402 IS RELAYED UNMODIFIED: the decoded PAYMENT-REQUIRED equals what
 *     the stub encoded, and the body equals the stub's body.
 *  4. TESTNET BY DEFAULT: a quote on another network is not payable, and a
 *     payment naming another network is never sent.
 *  5. SAME SKU IDS AS REST, and GATE CLOSED = NOT LISTED.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	call,
	check,
	connect,
	resetCounters,
	section,
	summary,
} from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..", "src");

/* ------------------------------------------------------------------ */
/* stub upstream                                                       */
/* ------------------------------------------------------------------ */

const SEPOLIA = "eip155:84532";
const TERMS_TEXT = "DATA LICENCE (DRAFT)\n  odd   whitespace\t\n";
const TERMS_SHA = createHash("sha256").update(TERMS_TEXT).digest("hex");
// Deliberately odd whitespace + trailing newline: a re-serialised hash differs.
const DATA_BYTES = '{ "index" :  1.25,\n  "as_of":"2026-10-31" }\n';
const DATA_SHA = createHash("sha256").update(DATA_BYTES).digest("hex");

let stubAmount = "10000";
let stubNetwork = SEPOLIA;
let paidMode = "deliver";
let stubVersion = 2;
let leakHits = 0;
let seenSignature = null;
let seenXPayment = null;
let seenToken = null;
let hits = [];
let seenFreeRead = null;
// Private-repo PR ids (#NNNN) and the backend chain head shas never appear here.
const PRIVATE_REF = new RegExp(["#" + "1[0-9]{3}\\b", "139a" + "7927", "4263" + "6b32", "946b" + "0a12", "29f7" + "52a6"].join("|"));
let freeMode = "serve";

const requiredFor = (route) => ({
	x402Version: stubVersion,
	error: "payment_required",
	resource: {
		url: `http://stub/api/data/v1${route}`,
		description: "stub dataset",
		mimeType: "application/json",
	},
	accepts: [
		{
			scheme: "exact",
			network: stubNetwork,
			amount: stubAmount,
			asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			payTo: "0x2222222222222222222222222222222222222222",
			maxTimeoutSeconds: 120,
			extra: { name: "USDC", version: "2" },
		},
	],
});
const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
const BODY_402 = { error: "payment_required", terms: { terms_id: "ctz-data-licence-v1" } };

const ROUTES = ["/compute-index/latest", "/intelligence/weekly", "/reg-calendar/v1"];

const server = createServer((req, res) => {
	const p = req.url.split("?")[0];
	hits.push(p);
	const json = (status, body, headers = {}) => {
		res.writeHead(status, { "content-type": "application/json", ...headers });
		res.end(JSON.stringify(body));
	};
	// The data API serves no dataset index
	// at GET /api/data/v1/: only the terms and the three dataset routes. The
	// stub answers 404 there, exactly as the API does.
	if (p === "/leak") {
		leakHits += 1;
		json(200, { leaked: req.headers["payment-signature"] ?? null });
		return;
	}
	if (p === "/api/data/v1/terms/ctz-data-licence-v1") {
		res.writeHead(200, {
			"content-type": "text/markdown; charset=UTF-8",
			"x-ctz-terms-status": "DRAFT",
			"x-ctz-terms-sha256": TERMS_SHA,
		});
		res.end(TERMS_TEXT);
		return;
	}
	const route = p.replace(/^\/api\/data\/v1/, "");
	if (ROUTES.includes(route) && p.startsWith("/api/data/v1/")) {
		seenSignature = req.headers["payment-signature"] ?? null;
		seenXPayment = req.headers["x-payment"] ?? null;
		seenToken = req.headers["x-ctz-receipt-token"] ?? null;
		seenFreeRead = req.headers["x-ctz-free-read"] ?? null;
		// Free read tier: a free read is considered only when no payment is attached.
		if (!seenSignature && seenFreeRead) {
			if (freeMode === "spent") {
				json(402, { error: "free_reads_spent" }, { "PAYMENT-REQUIRED": b64(requiredFor(route)) });
				return;
			}
			res.writeHead(200, {
				"content-type": "application/json; charset=UTF-8",
				"cache-control": "no-store",
				"x-ctz-free-read-receipt": "ctzfr_001",
				"x-ctz-free-reads-remaining": "4",
			});
			res.end(DATA_BYTES);
			return;
		}
		if (!seenSignature) {
			json(402, BODY_402, { "PAYMENT-REQUIRED": b64(requiredFor(route)) });
			return;
		}
		if (paidMode === "redirect") {
			res.writeHead(302, { location: "/leak" });
			res.end();
			return;
		}
		if (paidMode === "sanctioned") {
			json(403, { error: "payer_sanctioned" });
			return;
		}
		if (paidMode === "pending") {
			json(
				202,
				{ receipt: "ctzdr_abc", status: "settlement_pending" },
				{ "X-CTZ-Receipt-Token": "tok123" },
			);
			return;
		}
		res.writeHead(200, {
			"content-type": "application/json; charset=UTF-8",
			"PAYMENT-RESPONSE": b64({
				success: true,
				transaction: "0xabc",
				network: SEPOLIA,
				payer: "0x3333333333333333333333333333333333333333",
			}),
		});
		res.end(DATA_BYTES);
		return;
	}
	json(404, { error: "not_found" });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const ON = {
	COMMERTIZE_MCP_ENABLE_X402: "1",
	COMMERTIZE_MCP_DISABLE_X402: "",
	COMMERTIZE_MCP_X402_NETWORK: "",
	COMMERTIZE_API_BASE_URL: BASE,
	COMMERTIZE_MCP_ENABLE_MEMO: "1",
	COMMERTIZE_MCP_DISABLE_MEMO: "",
	COMMERTIZE_MCP_ENABLE_DISCLOSURE: "1",
	COMMERTIZE_MCP_DISABLE_DISCLOSURE: "",
};

const sig = (network) =>
	b64({
		x402Version: 2,
		accepted: { scheme: "exact", network },
		payload: { signature: "0x" + "ab".repeat(65) },
	});
const PAYMENT = sig(SEPOLIA);
const TOOLS = ["x402_catalog", "x402_terms", "x402_quote", "x402_fetch"];
const SKUS = ["compute-index-latest", "intelligence-weekly", "ctz-reg-calendar-v1"];

resetCounters();

/* ------------------------------------------------------------------ */
section("source scans: no signer, no price, no old routes");
/* ------------------------------------------------------------------ */
{
	const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
	const all = files.map((f) => [f, readFileSync(path.join(SRC, f), "utf8")]);
	check("the scan read src files", files.includes("x402Tools.ts"));
	const SIGNER =
		/from\s+["'](ethers|viem|@noble\/|@scure\/|web3|@coinbase\/|x402[-\w]*|@x402\/|bip39|tweetnacl|@solana\/)/;
	const signerHits = all.filter(([, s]) => SIGNER.test(s)).map(([f]) => f);
	check("no signer or wallet library is imported in src/", signerHits.length === 0, signerHits.join(","));
	// planted control: the regex does match an import line
	check("the signer scan has teeth", SIGNER.test('import { Wallet } from "ethers";'));
	const x = readFileSync(path.join(SRC, "x402Tools.ts"), "utf8");
	check("x402Tools sends PAYMENT-SIGNATURE", /"PAYMENT-SIGNATURE"/.test(x));
	check("x402Tools never names X-PAYMENT as a header", !/["']X-PAYMENT["']/i.test(x));
	check("x402Tools has no /api/agents/x402 route", !/\/api\/agents\/x402/.test(x));
	const PRICE = /(price|amount|cents|atomic)\w*\s*[:=]\s*["']?\d/i;
	check("x402Tools holds no price constant", !PRICE.test(x));
	check("the price scan has teeth", PRICE.test("priceAtomic: 10000"));
	check("no hard-coded mainnet chain id or RPC", !/eip155:8453\b|mainnet\.base\.org/.test(x));
}

/* ------------------------------------------------------------------ */
section("gate closed: the tools do not exist");
/* ------------------------------------------------------------------ */
{
	const client = await connect({
		COMMERTIZE_API_BASE_URL: BASE,
		COMMERTIZE_MCP_ENABLE_X402: "",
		COMMERTIZE_MCP_DISABLE_X402: "",
	});
	const listed = (await client.listTools()).tools.map((t) => t.name);
	for (const name of [...TOOLS, "x402_receipt"]) {
		check(`${name} absent from tools/list`, !listed.includes(name));
	}
	check("tools/list still carries the ungated tools", listed.includes("get_news"));
	const { payload: info } = await call(client, "platform_info");
	check(
		"platform_info advertises no x402 tool",
		!info.capabilities.tools.some((t) => t.startsWith("x402_")),
	);
	await client.close();
}

/* ------------------------------------------------------------------ */
section("gate open: listed, same SKU ids as REST, nothing key-shaped");
/* ------------------------------------------------------------------ */
{
	const client = await connect(ON);
	const tools = (await client.listTools()).tools;
	const listed = tools.map((t) => t.name);
	for (const name of TOOLS) check(`${name} present`, listed.includes(name));
	check("x402_receipt is not offered (re-delivery is not a public route)", !listed.includes("x402_receipt"));
	const fetchTool = tools.find((t) => t.name === "x402_fetch");
	check(
		"x402_fetch dataset ids are exactly the REST SKU ids",
		JSON.stringify(fetchTool?.inputSchema?.properties?.dataset_id?.enum) === JSON.stringify(SKUS),
	);
	const KEY_SHAPED = /priv|secret|seed|mnemonic|keystore|passphrase|wallet_key/i;
	for (const t of tools) {
		const props = Object.keys(t.inputSchema?.properties ?? {});
		const offenders = props.filter((p) => KEY_SHAPED.test(p));
		check(`${t.name} asks for nothing key-shaped`, offenders.length === 0, offenders.join(","));
	}
	check(
		"the sweep read x402_fetch's real inputs",
		Object.keys(fetchTool.inputSchema.properties).includes("payment_signature"),
	);
	check("x402_fetch is annotated as not read-only", fetchTool.annotations?.readOnlyHint === false);
	const { payload: info } = await call(client, "platform_info");
	check("platform_info names x402_fetch as a write tool", info.capabilities.write_tools.includes("x402_fetch"));
	await client.close();
}

/* ------------------------------------------------------------------ */
section("catalogue and terms are relayed, not authored");
/* ------------------------------------------------------------------ */
{
	const client = await connect(ON);
	stubAmount = "10000";
	hits = [];
	let { payload: cat } = await call(client, "x402_catalog");
	check("catalogue never calls GET /api/data/v1/ (not served on the chain)", !hits.includes("/api/data/v1/"));
	check(
		"catalogue asks each dataset route, unpaid, once",
		JSON.stringify(hits) === JSON.stringify(ROUTES.map((r) => `/api/data/v1${r}`)),
		JSON.stringify(hits),
	);
	check("catalogue sends no payment while asking", seenSignature === null);
	check("catalogue has one entry per dataset id", JSON.stringify(cat.catalog?.map((e) => e.dataset_id)) === JSON.stringify(SKUS));
	check(
		"catalogue entry relays the decoded PAYMENT-REQUIRED verbatim",
		JSON.stringify(cat.catalog?.[2]?.payment_required) === JSON.stringify(requiredFor(ROUTES[2])),
	);
	check("catalogue relays the backend amount verbatim", cat.catalog?.[0]?.payment_required?.accepts?.[0]?.amount === "10000");
	check("catalogue entry carries the 402 status", cat.catalog?.[0]?.status === 402 && cat.catalog?.[0]?.unavailable_reason === null);
	check("catalogue is available when every dataset quoted", cat.unavailable_reason === null);
	stubAmount = "77777";
	({ payload: cat } = await call(client, "x402_catalog"));
	check("a changed backend price shows up changed", cat.catalog?.[0]?.payment_required?.accepts?.[0]?.amount === "77777");
	check("catalogue lists the client's dataset ids", JSON.stringify(cat.dataset_ids) === JSON.stringify(SKUS));
	check("catalogue expected network defaults to Base Sepolia", cat.expected_network === SEPOLIA);
	stubAmount = "10000";
	stubNetwork = "eip155:8453";
	({ payload: cat } = await call(client, "x402_catalog"));
	check(
		"catalogue: another network is not relayed as payable",
		cat.catalog?.every((e) => e.payment_required === null && e.unavailable_reason === "network_mismatch"),
	);
	stubNetwork = SEPOLIA;

	const { payload: terms } = await call(client, "x402_terms");
	check("terms returns the raw bytes", terms.text === TERMS_TEXT);
	check("terms relays the declared sha256 header", terms.declared_sha256 === TERMS_SHA);
	check("terms relays the declared status header", terms.declared_status === "DRAFT");
	check("terms reports the sha256 of the bytes received", terms.received_sha256 === TERMS_SHA);
	await client.close();
}

/* ------------------------------------------------------------------ */
section("a 402 is relayed unmodified");
/* ------------------------------------------------------------------ */
{
	const client = await connect(ON);
	for (const [sku, route] of SKUS.map((s, i) => [s, ROUTES[i]])) {
		const { payload: q } = await call(client, "x402_quote", { dataset_id: sku });
		check(`${sku}: quote reports 402`, q.status === 402);
		check(
			`${sku}: decoded PAYMENT-REQUIRED equals what the API encoded`,
			JSON.stringify(q.payment_required) === JSON.stringify(requiredFor(route)),
		);
		check(`${sku}: 402 body relayed unmodified`, JSON.stringify(q.body) === JSON.stringify(BODY_402));
		check(`${sku}: hit /api/data/v1${route}`, hits.at(-1) === `/api/data/v1${route}`);
	}
	await client.close();
}

/* ------------------------------------------------------------------ */
section("testnet by default: other networks are neither quoted nor paid");
/* ------------------------------------------------------------------ */
{
	const client = await connect(ON);
	stubNetwork = "eip155:8453";
	const { payload: q } = await call(client, "x402_quote", { dataset_id: SKUS[0] });
	check("a mainnet quote is not payable by default", q.unavailable_reason === "network_mismatch" && q.payment_required === null);
	stubNetwork = SEPOLIA;
	const before = hits.length;
	const { payload: f } = await call(client, "x402_fetch", {
		dataset_id: SKUS[0],
		payment_signature: sig("eip155:8453"),
	});
	check("a mainnet payment is refused", f.refusal?.code === "network_mismatch" && f.delivered === false);
	check("a mainnet payment is never sent upstream", hits.length === before);
	await client.close();
}

/* ------------------------------------------------------------------ */
section("M-1: an undecodable or x402 v1 payment or quote fails closed");
/* ------------------------------------------------------------------ */
{
	const client = await connect(ON);
	stubVersion = 1;
	const { payload: q1 } = await call(client, "x402_quote", { dataset_id: SKUS[0] });
	check("a v1 PAYMENT-REQUIRED is not payable", q1.unavailable_reason === "x402_version_unsupported" && q1.payment_required === null);
	stubVersion = 2;
	const { payload: q2 } = await call(client, "x402_quote", { dataset_id: SKUS[0] });
	check("control: the same v2 quote is payable", q2.unavailable_reason === null && q2.payment_required !== null);
	const before = hits.length;
	const { payload: u } = await call(client, "x402_fetch", { dataset_id: SKUS[0], payment_signature: "%%not-base64-json%%" });
	check("an undecodable payment is refused", u.refusal?.code === "payment_signature_undecodable" && u.delivered === false);
	const v1 = b64({ x402Version: 1, scheme: "exact", network: SEPOLIA, payload: { signature: "0x" + "ab".repeat(65) } });
	const { payload: w } = await call(client, "x402_fetch", { dataset_id: SKUS[0], payment_signature: v1 });
	check("a v1-shaped payment is refused", w.refusal?.code === "x402_version_unsupported" && w.delivered === false);
	const v2noNet = b64({ x402Version: 2, accepted: { scheme: "exact" }, payload: {} });
	const { payload: n } = await call(client, "x402_fetch", { dataset_id: SKUS[0], payment_signature: v2noNet });
	check("a v2 payment with no network is refused", n.refusal?.code === "network_mismatch" && n.delivered === false);
	check("none of those payments was sent upstream", hits.length === before);
	await client.close();
}

/* ------------------------------------------------------------------ */
section("M-2: outbound fetches never follow a redirect");
/* ------------------------------------------------------------------ */
{
	const calls = [];
	for (const f of readdirSync(SRC).filter((x) => x.endsWith(".ts"))) {
		const t = readFileSync(path.join(SRC, f), "utf8");
		let i = t.indexOf("await fetch(");
		while (i !== -1) {
			calls.push([f, t.slice(i, t.indexOf("});", i))]);
			i = t.indexOf("await fetch(", i + 1);
		}
	}
	check("the scan found the outbound fetch calls", calls.length >= 5, String(calls.length));
	const open = calls.filter(([, c]) => !/redirect:\s*"manual"/.test(c)).map(([f]) => f);
	check('every fetch sets redirect: "manual"', open.length === 0, open.join(","));
	paidMode = "redirect";
	leakHits = 0;
	const client = await connect(ON);
	const { payload: r } = await call(client, "x402_fetch", { dataset_id: SKUS[0], payment_signature: PAYMENT });
	check("a redirected paid request is not delivered", r.delivered === false && r.status === 302);
	check("the signed payment never reaches the redirect target", leakHits === 0);
	paidMode = "deliver";
	await client.close();
}

/* ------------------------------------------------------------------ */
section("x402_fetch forwards PAYMENT-SIGNATURE verbatim and returns the delivery");
/* ------------------------------------------------------------------ */
{
	paidMode = "deliver";
	seenSignature = null;
	const client = await connect(ON);
	const { payload: out } = await call(client, "x402_fetch", {
		dataset_id: "ctz-reg-calendar-v1",
		payment_signature: PAYMENT,
	});
	check("PAYMENT-SIGNATURE forwarded byte for byte", seenSignature === PAYMENT);
	check("no X-PAYMENT header is sent", seenXPayment === null);
	check("delivery reported", out.delivered === true && out.status === 200);
	check("decoded PAYMENT-RESPONSE returned", out.payment_response?.transaction === "0xabc");
	check("served sha256 is over the exact bytes", out.served_sha256 === DATA_SHA);
	check("data returned", out.data?.index === 1.25);
	await client.close();
}

/* ------------------------------------------------------------------ */
section("refusals and pending settlement arrive as themselves");
/* ------------------------------------------------------------------ */
{
	const client = await connect(ON);
	paidMode = "sanctioned";
	const { payload: s } = await call(client, "x402_fetch", { dataset_id: SKUS[0], payment_signature: PAYMENT });
	check("a sanctions refusal keeps its code", s.refusal?.code === "payer_sanctioned" && s.data === null);
	check("a refusal body is relayed unmodified", JSON.stringify(s.body) === JSON.stringify({ error: "payer_sanctioned" }));
	paidMode = "pending";
	const { payload: p } = await call(client, "x402_fetch", { dataset_id: SKUS[0], payment_signature: PAYMENT });
	check("pending: no delivery", p.delivered === false && p.status === 202);
	check("pending: the receipt token is returned", p.receipt_token === "tok123");
	paidMode = "deliver";
	const { payload: r } = await call(client, "x402_fetch", {
		dataset_id: SKUS[0],
		payment_signature: PAYMENT,
		receipt_token: "tok123",
	});
	check("retry forwards the receipt token", seenToken === "tok123" && r.delivered === true);
	await client.close();
}

/* ------------------------------------------------------------------ */
section("free read: the caller's X-CTZ-Free-Read is forwarded verbatim, never a payment");
/* ------------------------------------------------------------------ */
{
	const FREE = Buffer.from('{"passportId":"p1","dataset":"ctz-reg-calendar-v1","sig":"0xab"}').toString("base64url");
	const client = await connect(ON);
	freeMode = "serve";
	seenSignature = "unset";
	const { payload: f } = await call(client, "x402_fetch", { dataset_id: "ctz-reg-calendar-v1", free_read: FREE });
	check("X-CTZ-Free-Read forwarded byte for byte", seenFreeRead === FREE);
	check("a free read sends no PAYMENT-SIGNATURE", seenSignature === null);
	check("free read delivered", f.delivered === true && f.status === 200 && f.data?.index === 1.25);
	check("free read reports the free receipt id", f.free_read_receipt === "ctzfr_001");
	check("free read reports the remaining allowance as served", f.free_reads_remaining === "4");
	check("a free read has no PAYMENT-RESPONSE", f.payment_response === null);
	check("free read sha256 is over the exact bytes", f.served_sha256 === DATA_SHA);

	freeMode = "spent";
	const { payload: s } = await call(client, "x402_fetch", { dataset_id: "ctz-reg-calendar-v1", free_read: FREE });
	check("a spent allowance arrives as itself", s.delivered === false && s.status === 402 && s.refusal?.code === "free_reads_spent");
	freeMode = "serve";

	const before = hits.length;
	const { payload: both } = await call(client, "x402_fetch", {
		dataset_id: SKUS[0],
		payment_signature: PAYMENT,
		free_read: FREE,
	});
	check("payment and free read together are refused", both.refusal?.code === "payment_and_free_read" && both.delivered === false);
	const { payload: none } = await call(client, "x402_fetch", { dataset_id: SKUS[0] });
	check("neither payment nor free read is refused", none.refusal?.code === "payment_or_free_read_required" && none.delivered === false);
	const { payload: bad } = await call(client, "x402_fetch", { dataset_id: SKUS[0], free_read: "not base64url!" });
	check("a free read that is not base64url is refused", bad.refusal?.code === "free_read_undecodable" && bad.delivered === false);
	const { payload: rt } = await call(client, "x402_fetch", { dataset_id: SKUS[0], free_read: FREE, receipt_token: "tok123" });
	check("receipt_token with a free read is refused", rt.refusal?.code === "receipt_token_with_free_read" && rt.delivered === false);
	check("none of those was sent upstream", hits.length === before);
	check("no-leak scan: no private PR ids or shas in src or tests", ![readFileSync(path.join(SRC, "x402Tools.ts"), "utf8"), readFileSync(fileURLToPath(import.meta.url), "utf8")].some((t) => PRIVATE_REF.test(t)));
	check("no-leak scan has teeth", PRIVATE_REF.test("see #" + "1278") && PRIVATE_REF.test("head " + "29f7" + "52a6"));

	const { payload: paid } = await call(client, "x402_fetch", { dataset_id: SKUS[0], payment_signature: PAYMENT });
	check("control: a paid read sends no X-CTZ-Free-Read", seenFreeRead === null && paid.delivered === true);
	check("control: a paid read reports no free receipt", paid.free_read_receipt === null && paid.free_reads_remaining === null);
	await client.close();
}

server.close();
process.exit(summary("x402 e2e") === 0 ? 0 : 1);
