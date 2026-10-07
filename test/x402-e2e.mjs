/**
 * End-to-end suite for the five x402 paid-data tools.
 *
 * Real spawned server, real MCP stdio client, real JSON-RPC — against a LOCAL
 * stub upstream that speaks the x402 v1 wire shape. The live API does not run
 * this rail (its flag is unset there and its purchase terms are unratified), so
 * a live suite could only assert 404s.
 *
 * The properties this suite exists to hold:
 *
 *  1. THIS SERVER NEVER SIGNS. `x402_fetch` forwards the caller's opaque
 *     `x_payment` VERBATIM. The stub records the header it received and the
 *     suite asserts byte equality, so a future "helpful" transformation — let
 *     alone a signing step — turns this red.
 *  2. NO INPUT ANYWHERE ACCEPTS A KEY. Every tool's input schema is swept for
 *     anything shaped like a private key, seed, or mnemonic. A payment tool
 *     that can ask for one is a payment tool that will be asked to.
 *  3. A 402 IS AN ANSWER, NOT A FAILURE. The quote tool relays the payment
 *     requirements and the terms url, version and hash out of a 402 body
 *     instead of collapsing it into a generic error.
 *  4. A REFUSAL IS RELAYED WITH ITS CODE. A screening decline (403) and a
 *     replayed settlement (409) are reported as themselves, because a caller's
 *     next action differs for each and "something went wrong" serves neither.
 *  5. GATE CLOSED = NOT LISTED, in `tools/list` and in `platform_info`.
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

/* ------------------------------------------------------------------ */
/* stub upstream                                                       */
/* ------------------------------------------------------------------ */

const TERMS_TEXT =
	"COMMERTIZE — PER-CALL DATA PURCHASE TERMS (DRAFT)\nVersion 2026-09-02.1-DRAFT\n";
const TERMS_HASH = "a".repeat(64);
const PRICE = 250000;

const REQUIREMENTS = {
	scheme: "exact",
	network: "base-sepolia",
	maxAmountRequired: String(PRICE),
	asset: "0x1111111111111111111111111111111111111111",
	payTo: "0x2222222222222222222222222222222222222222",
	resource: "http://stub/api/agents/stats/detail",
	description:
		"Platform statistics (detail). One delivery. By completing this payment you accept the terms at http://stub/api/agents/x402/terms (version 2026-09-02.1-DRAFT).",
	mimeType: "application/json",
	maxTimeoutSeconds: 300,
	extra: {
		commertize_product_id: "platform.stats_detail",
		terms_url: "http://stub/api/agents/x402/terms",
		terms_version: "2026-09-02.1-DRAFT",
		terms_hash: TERMS_HASH,
	},
};

/** What the stub does with a presented payment. Set per section. */
let detailMode = "deliver";
let seenPaymentHeader = null;
let hits = [];

const server = createServer((req, res) => {
	const path = req.url.split("?")[0];
	hits.push(path);
	const json = (status, body) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};

	if (path === "/api/agents/x402/terms") {
		res.writeHead(200, {
			"content-type": "text/plain; charset=utf-8",
			"x-commertize-terms-sha256": TERMS_HASH,
		});
		res.end(TERMS_TEXT);
		return;
	}

	if (path === "/api/agents/x402/catalog") {
		json(200, {
			network: "base-sepolia",
			asset: REQUIREMENTS.asset,
			assetDecimals: 6,
			terms: {
				url: REQUIREMENTS.extra.terms_url,
				version: REQUIREMENTS.extra.terms_version,
				sha256: TERMS_HASH,
			},
			pricing:
				"Every price is a constant per product. It is the same for every purchaser.",
			products: [
				{
					id: "platform.stats_detail",
					label: "Platform statistics (detail)",
					description: "Commertize's own platform counters in detail.",
					priceAtomic: PRICE,
					resource: REQUIREMENTS.resource,
				},
			],
		});
		return;
	}

	if (path.startsWith("/api/agents/x402/receipts/")) {
		json(200, {
			settlementId: decodeURIComponent(path.split("/").pop()),
			productId: "platform.stats_detail",
			atomicAmount: String(PRICE),
			outcome: "credited",
			seller: { name: "Commertize, Inc." },
		});
		return;
	}

	if (path === "/api/agents/stats/detail") {
		seenPaymentHeader = req.headers["x-payment"] ?? null;
		// The real handler reads the volume meter BEFORE it issues a quote — a
		// quote it would refuse to honour is a quote it should not have made — so
		// the stub refuses here too, ahead of the 402 branch.
		if (detailMode === "volume_stop") {
			json(503, { error: "volume_limit_reached", message: "Not quoting." });
			return;
		}
		if (!seenPaymentHeader) {
			json(402, {
				x402Version: 1,
				error: "This resource is paid.",
				accepts: [REQUIREMENTS],
			});
			return;
		}
		if (detailMode === "screening_declined") {
			json(403, {
				error: "screening_declined",
				message:
					"The payment facilitator's sanctions/high-risk screening declined the paying address. Nothing was delivered.",
				settled: true,
				delivered: false,
				settlement_id: "base-sepolia:0xdeclined",
			});
			return;
		}
		if (detailMode === "replayed") {
			json(409, {
				error: "settlement_replayed",
				message: "This settlement has already been used.",
				settlement_id: "base-sepolia:0xused",
			});
			return;
		}
		json(200, {
			product: "platform.stats_detail",
			settlement: {
				id: "base-sepolia:0xabc",
				network: "base-sepolia",
				transaction: "0xabc",
				payer: "0x3333333333333333333333333333333333333333",
				atomicAmount: String(PRICE),
				receipt: "http://stub/api/agents/x402/receipts/base-sepolia%3A0xabc",
			},
			terms: { version: "2026-09-02.1-DRAFT", sha256: TERMS_HASH },
			data: { agents: { registered: 3 } },
		});
		return;
	}

	json(404, { error: "Not found" });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const ON = {
	COMMERTIZE_MCP_ENABLE_X402: "1",
	COMMERTIZE_MCP_DISABLE_X402: "",
	COMMERTIZE_API_BASE_URL: BASE,
	// The key-shaped-input sweep below runs over EVERY listed tool, so the two
	// deployment-gated tools are opened here as well. Without this the sweep
	// silently stops covering `request_memo` and `get_disclosure_package` —
	// which is exactly how a forall-style security check loses two subjects and
	// still reports green.
	COMMERTIZE_MCP_ENABLE_MEMO: "1",
	COMMERTIZE_MCP_DISABLE_MEMO: "",
	COMMERTIZE_MCP_ENABLE_DISCLOSURE: "1",
	COMMERTIZE_MCP_DISABLE_DISCLOSURE: "",
};

const PAYMENT = Buffer.from(
	JSON.stringify({ x402Version: 1, scheme: "exact", network: "base-sepolia" }),
	"utf8",
).toString("base64");

resetCounters();

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
	for (const name of [
		"x402_catalog",
		"x402_terms",
		"x402_quote",
		"x402_fetch",
		"x402_receipt",
	]) {
		check(`${name} absent from tools/list`, !listed.includes(name));
	}
	check(
		"tools/list still carries the ungated tools",
		listed.includes("get_news"),
	);
	const { payload: info } = await call(client, "platform_info");
	check(
		"platform_info advertises no x402 tool",
		!info.capabilities.tools.some((t) => t.startsWith("x402_")),
	);
	check(
		"platform_info does not list x402_fetch as a write",
		!info.capabilities.write_tools.includes("x402_fetch"),
	);
	await client.close();
}

/* ------------------------------------------------------------------ */
section("gate open: listed, advertised, and honest about what it does");
/* ------------------------------------------------------------------ */
{
	const client = await connect(ON);
	const tools = (await client.listTools()).tools;
	const listed = tools.map((t) => t.name);
	for (const name of [
		"x402_catalog",
		"x402_terms",
		"x402_quote",
		"x402_fetch",
		"x402_receipt",
	]) {
		check(`${name} present in tools/list`, listed.includes(name));
	}

	const { payload: info } = await call(client, "platform_info");
	check(
		"platform_info names x402_fetch as a write tool",
		info.capabilities.write_tools.includes("x402_fetch"),
	);
	check(
		"platform_info still says this server cannot transact securities",
		info.capabilities.can_transact === false,
	);

	/*
	 * THE SWEEP. A payment tool whose input schema can name a key is a payment
	 * tool that will one day be handed one. Asserted by SHAPE across every
	 * tool's inputs, not by checking the four names I happened to think of.
	 */
	const KEY_SHAPED =
		/priv|secret|seed|mnemonic|keystore|passphrase|wallet_key/i;
	for (const t of tools) {
		const props = Object.keys(t.inputSchema?.properties ?? {});
		const offenders = props.filter((p) => KEY_SHAPED.test(p));
		check(
			`${t.name} asks for nothing key-shaped`,
			offenders.length === 0,
			offenders.join(","),
		);
	}
	// Positive control: the sweep read real property names.
	const fetchTool = tools.find((t) => t.name === "x402_fetch");
	check(
		"the sweep read x402_fetch's real inputs",
		Object.keys(fetchTool.inputSchema.properties).includes("x_payment"),
	);
	check(
		"x402_fetch is annotated as not read-only",
		fetchTool.annotations?.readOnlyHint === false,
	);

	await client.close();
}

/* ------------------------------------------------------------------ */
section("catalogue and terms");
/* ------------------------------------------------------------------ */
{
	const client = await connect(ON);
	const { payload: cat } = await call(client, "x402_catalog");
	check("catalogue names the testnet", cat.network === "base-sepolia");
	check(
		"catalogue price is an integer of atomic units",
		Number.isInteger(cat.products[0].price_atomic),
	);
	check(
		"catalogue price is the constant",
		cat.products[0].price_atomic === PRICE,
	);
	check(
		"catalogue names no offering vocabulary",
		!/offering|506|reg d|exempt|pipeline/i.test(JSON.stringify(cat.products)),
	);

	const { payload: terms } = await call(client, "x402_terms");
	check("terms returns the raw bytes", terms.text === TERMS_TEXT);
	/*
	 * The server does NOT hand back a hash it computed itself. A hash produced
	 * by the same process that served the bytes is not evidence of anything, and
	 * offering one would invite a caller to skip the check that matters.
	 */
	check(
		"terms does not compute the hash for the caller",
		terms.declared_sha256 === null,
	);
	check(
		"terms tells the caller to hash it themselves",
		/SHA-256/.test(terms.verify),
	);
	await client.close();
}

/* ------------------------------------------------------------------ */
section("a 402 is an answer, not a failure");
/* ------------------------------------------------------------------ */
{
	detailMode = "deliver";
	const client = await connect(ON);
	const { payload: quote } = await call(client, "x402_quote", {
		product_id: "platform.stats_detail",
	});
	check("quote reports the 402 status", quote.status === 402);
	check("quote has no error", quote.error === null);
	check(
		"quote relays the amount",
		quote.requirements?.max_amount_required === String(PRICE),
	);
	check(
		"quote relays the single receiving address",
		quote.requirements?.pay_to === REQUIREMENTS.payTo,
	);
	check(
		"quote relays the terms url",
		quote.requirements?.terms_url === REQUIREMENTS.extra.terms_url,
	);
	check(
		"quote relays the terms hash",
		quote.requirements?.terms_hash === TERMS_HASH,
	);
	check(
		"quote relays the acceptance line",
		/accept the terms at/.test(quote.requirements?.description ?? ""),
	);
	await client.close();
}

/* ------------------------------------------------------------------ */
section("x402_fetch forwards the caller's payment verbatim");
/* ------------------------------------------------------------------ */
{
	detailMode = "deliver";
	seenPaymentHeader = null;
	const client = await connect(ON);
	const { payload: out } = await call(client, "x402_fetch", {
		product_id: "platform.stats_detail",
		x_payment: PAYMENT,
	});
	// THE PROPERTY. Byte equality, so a future transformation of any kind —
	// re-encoding, re-signing, "normalising" — turns this red.
	check(
		"the payment header is forwarded byte for byte",
		seenPaymentHeader === PAYMENT,
	);
	check("delivery is reported", out.delivered === true);
	check(
		"the settlement id comes back",
		out.settlement?.id === "base-sepolia:0xabc",
	);
	check("the data comes back", out.data?.agents?.registered === 3);
	check(
		"a receipt url comes back",
		/receipts/.test(out.settlement?.receipt ?? ""),
	);

	const { payload: receipt } = await call(client, "x402_receipt", {
		settlement_id: "base-sepolia:0xabc",
	});
	check(
		"the receipt is fetchable with no account",
		receipt.receipt?.productId === "platform.stats_detail",
	);
	check(
		"the receipt names the seller",
		receipt.receipt?.seller?.name === "Commertize, Inc.",
	);
	await client.close();
}

/* ------------------------------------------------------------------ */
section("refusals arrive as themselves");
/* ------------------------------------------------------------------ */
{
	const client = await connect(ON);

	detailMode = "screening_declined";
	const { payload: declined } = await call(client, "x402_fetch", {
		product_id: "platform.stats_detail",
		x_payment: PAYMENT,
	});
	check("a screening decline is not a delivery", declined.delivered === false);
	check(
		"a screening decline keeps its code",
		declined.refusal?.code === "screening_declined",
	);
	check("a screening decline returns no data", declined.data === null);
	// The relay must not invent a disposition the server did not promise.
	check(
		"the relay promises no refund",
		!/refund|returned to you|money back/i.test(declined.refusal?.message ?? ""),
	);

	detailMode = "replayed";
	const { payload: replayed } = await call(client, "x402_fetch", {
		product_id: "platform.stats_detail",
		x_payment: PAYMENT,
	});
	check(
		"a replayed settlement keeps its code",
		replayed.refusal?.code === "settlement_replayed",
	);
	check("a replayed settlement delivers nothing", replayed.delivered === false);

	detailMode = "volume_stop";
	const { payload: stopped } = await call(client, "x402_quote", {
		product_id: "platform.stats_detail",
	});
	check(
		"a volume stop is relayed as its own reason",
		stopped.unavailable_reason === "volume_limit_reached",
	);
	check(
		"a volume stop yields no requirements to sign",
		stopped.requirements === null,
	);

	detailMode = "deliver";
	await client.close();
}

server.close();
summary("x402 e2e");
