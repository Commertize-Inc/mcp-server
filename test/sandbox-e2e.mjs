/**
 * End-to-end suite for the five simulation-venue tools.
 *
 * Real spawned server, real MCP stdio client, real JSON-RPC — against a LOCAL
 * stub upstream. The venue is off on the live API (its flag is unset there and
 * will stay unset until a human decides an open question), so a live suite
 * could only ever assert 404s.
 *
 * The stub serves the SHAPE `apps/backend/src/routes/sandbox.ts` returns. It
 * invents no field that route does not send.
 *
 * The properties this suite exists to hold:
 *
 *  1. GATE CLOSED = NOT LISTED. With `COMMERTIZE_MCP_ENABLE_SANDBOX` unset the
 *     four tools are absent from `tools/list` AND absent from the tool list
 *     `platform_info` publishes. Both, because those are two different readers
 *     and a client trusts whichever it happens to read.
 *  2. NO CREDENTIAL, NO CALL. Every tool refuses without an agent key and says
 *     what to do, rather than returning an empty success.
 *  3. THE SIMULATION DESIGNATION IS RELAYED, NOT ASSERTED. `simulation` and the
 *     disclaimer come off the upstream body. The stub's third section proves
 *     it by REMOVING them and checking they arrive as null rather than as a
 *     locally invented `true`.
 *  4. A CREDENTIALED READ IS NEVER CACHED. Two calls with the same URL hit the
 *     upstream twice; the shared cache is keyed on URL alone and would
 *     otherwise serve one agent's ledger to another.
 *  5. COMMITMENT VOCABULARY, NOT ORDER ENTRY. The write is
 *     `sandbox_record_commitment`: no `side` input, nothing sent upstream
 *     that names a side, and no order/buy/sell/trade/price wording in any
 *     sandbox tool's title, description or schemas. A reversal is a separate
 *     `sandbox_withdraw_commitment`, which the venue declines after its
 *     simulated close. The retired `sandbox_place_order` name records nothing
 *     and names its replacement.
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

/** legal review 2026-09-03. A second, independent copy of the backend's constant. */
const BADGE =
	"SIMULATION — fictional instruments for testing; not offerings; no real assets, sponsors, or transactions.";
const FICTION_NOTICE =
	"Sponsor and asset names are invented; any resemblance to a real company is coincidental.";

const ENVELOPE = {
	simulation: true,
	badge: BADGE,
	disclaimer: "SIMULATION. No securities are offered...",
	disclaimerVersion: "2026-09-03.1",
	banner:
		"SIMULATION — fictional instruments, synthetic terms, no money, no securities.",
};

let hits = [];
let stripEnvelope = false;
let lastAgentKey = null;
/** Parsed JSON bodies of every POST, so the suite can assert what went upstream. */
let posted = [];

const COMMITMENT = (status) => ({
	seq: 1,
	id: "commitment-1",
	assetId: "fx-harbor-loop",
	universe: "fixture",
	status,
	quantity: 10,
	unitAmountCents: 10000,
	notionalCents: 100000,
	declineReason: null,
	simulation: true,
	createdAt: "2026-09-03T00:00:01.000Z",
});

/** The venue's refusal once its simulated close has passed. */
const CLOSED_PATH = "/api/agents/sandbox/commitments/commitment-closed/withdraw";

const bodies = () => ({
	"/api/agents/sandbox/enroll": {
		...ENVELOPE,
		fictionNotice: FICTION_NOTICE,
		notice: "Paper results are for the credential holder's own use.",
		capability: "paper",
		universe: "fixture",
		account: {
			openedAt: "2026-09-03T00:00:00.000Z",
			notionalCents: 25000000,
			commitments: 0,
		},
	},
	"/api/agents/sandbox/universe": {
		...ENVELOPE,
		fictionNotice: FICTION_NOTICE,
		universe: "fixture",
		assets: [
			{
				id: "fx-harbor-loop",
				name: "Harbor Loop Logistics Center",
				city: "Savannah",
				state: "GA",
				propertyType: "industrial",
				sponsor: "Wrenfield Industrial Partners (fictional)",
				unitAmountCents: 10000,
				unitsOutstanding: 400000,
			},
		],
	},
	"/api/agents/sandbox/commitments": {
		...ENVELOPE,
		commitment: COMMITMENT("recorded"),
	},
	"/api/agents/sandbox/commitments/commitment-1/withdraw": {
		...ENVELOPE,
		commitment: COMMITMENT("withdrawn"),
	},
	"/api/agents/sandbox/account": {
		...ENVELOPE,
		account: {
			openedAt: "2026-09-03T00:00:00.000Z",
			resetAt: null,
			notionalCents: 24900000,
			orders: 1,
		},
		positions: [{ assetId: "fx-harbor-loop", units: 10 }],
	},
});

const server = createServer(async (req, res) => {
	const path = req.url.split("?")[0];
	hits.push(path);
	lastAgentKey = req.headers["x-agent-key"] ?? null;
	if (req.method === "POST") {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		try {
			posted.push({ path, body: raw ? JSON.parse(raw) : {} });
		} catch {
			posted.push({ path, body: raw });
		}
	}
	if (path === CLOSED_PATH) {
		res.writeHead(409, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				error:
					"The simulated close has passed; this commitment can no longer be withdrawn.",
			}),
		);
		return;
	}
	const body = bodies()[path];
	if (!body) {
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "Not found" }));
		return;
	}
	const payload = { ...body };
	if (stripEnvelope) {
		delete payload.simulation;
		delete payload.badge;
		delete payload.disclaimer;
		delete payload.disclaimerVersion;
	}
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify(payload));
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

/** An independent copy of the published list, so a drift in the module fails here. */
const SANDBOX_TOOLS = [
	"sandbox_enroll",
	"sandbox_universe",
	"sandbox_record_commitment",
	"sandbox_withdraw_commitment",
	"sandbox_account",
];
const SANDBOX_WRITES = [
	"sandbox_enroll",
	"sandbox_record_commitment",
	"sandbox_withdraw_commitment",
];
/** Retired for one release: callable, records nothing, names its replacement. */
const RETIRED = "sandbox_place_order";

/**
 * Order-entry vocabulary barred from every sandbox tool surface (legal ruling
 * 2026-10-28, item 5). Word-bounded, so the retired name's `_order` suffix in
 * a schema is not a hit by itself, but a description saying "order" is.
 */
const ORDER_WORDS =
	/\b(orders?|buy|buys|sell|sells|selling|side|trades?|trading|fill|filled|price|prices|priced)\b/i;

const ON = {
	COMMERTIZE_MCP_ENABLE_MEMO: "1",
	COMMERTIZE_MCP_DISABLE_MEMO: "",
	COMMERTIZE_MCP_ENABLE_SANDBOX: "1",
	COMMERTIZE_MCP_DISABLE_SANDBOX: "",
	COMMERTIZE_API_BASE_URL: BASE,
	COMMERTIZE_AGENT_KEY: "ctza_test_secret",
};

resetCounters();

/* ------------------------------------------------------------------ */
section("gate closed: the tools do not exist");
/* ------------------------------------------------------------------ */
{
	const client = await connect({
		COMMERTIZE_API_BASE_URL: BASE,
		COMMERTIZE_MCP_ENABLE_SANDBOX: "",
		COMMERTIZE_MCP_DISABLE_SANDBOX: "",
		COMMERTIZE_AGENT_KEY: "ctza_test_secret",
		// `request_memo` is behind its own (deployment) gate as of 2026-09-10.
		// This section's point is that closing the SANDBOX gate does not take
		// the ungated surface with it, so the memo gate is held open here and
		// the check below is a real positive control rather than a tautology.
		COMMERTIZE_MCP_ENABLE_MEMO: "1",
		COMMERTIZE_MCP_DISABLE_MEMO: "",
	});
	const listed = (await client.listTools()).tools.map((t) => t.name);
	for (const name of [...SANDBOX_TOOLS, RETIRED]) {
		check(`${name} absent from tools/list`, !listed.includes(name));
	}
	// Positive control: the sweep read a real list, not an empty one.
	check(
		"tools/list still carries the ungated tools",
		listed.includes("get_news"),
	);

	const { payload: info } = await call(client, "platform_info");
	const advertised = info.capabilities.tools;
	check(
		"platform_info advertises no sandbox tool",
		!advertised.some((t) => t.startsWith("sandbox_")),
	);
	check(
		"platform_info advertises no sandbox write tool",
		!info.capabilities.write_tools.some((t) => t.startsWith("sandbox_")),
	);
	check(
		"platform_info still advertises request_memo",
		info.capabilities.write_tools.includes("request_memo"),
	);
	await client.close();
}

/* ------------------------------------------------------------------ */
section("gate open: the tools exist and are advertised");
/* ------------------------------------------------------------------ */
{
	const client = await connect(ON);
	const tools = (await client.listTools()).tools;
	const listed = tools.map((t) => t.name);
	for (const name of SANDBOX_TOOLS) {
		check(`${name} present in tools/list`, listed.includes(name));
	}

	/*
	 * THE WORDING GUARD. Title, description and both schemas of every sandbox
	 * tool, as the protocol reports them. The retired stub is scanned too: its
	 * prose must say where to go without describing the old behaviour.
	 */
	for (const t of tools.filter((x) => x.name.startsWith("sandbox_"))) {
		const text = [
			t.title ?? "",
			t.description ?? "",
			JSON.stringify(t.inputSchema ?? {}),
			JSON.stringify(t.outputSchema ?? {}),
		].join(" ");
		const hit = text.match(ORDER_WORDS);
		check(
			`${t.name} carries no order-entry vocabulary`,
			hit === null,
			hit ? `found "${hit[0]}"` : "",
		);
	}
	// Positive control: the guard really matches the words it bars, on the
	// pre-rename description, so a broken regex cannot pass the sweep above.
	check(
		"the wording guard catches the pre-rename description",
		ORDER_WORDS.test(
			"A rejected order still returns a row. Generate one per intended order.",
		) && ORDER_WORDS.test('{"side":{"enum":["buy","sell"]}}'),
	);

	const record = tools.find((t) => t.name === "sandbox_record_commitment");
	check(
		"record_commitment has no side input",
		record !== undefined &&
			!Object.keys(record.inputSchema?.properties ?? {}).includes("side"),
		JSON.stringify(Object.keys(record?.inputSchema?.properties ?? {})),
	);
	check(
		"record_commitment is titled as a simulated commitment",
		record?.title === "Record one simulated commitment",
	);
	const withdraw = tools.find((t) => t.name === "sandbox_withdraw_commitment");
	check(
		"withdraw_commitment says it works only before the simulated close",
		/before the simulated close/.test(withdraw?.description ?? ""),
	);
	check(
		"the commitment tools keep the no-money, no-obligation line",
		[record, withdraw].every((t) =>
			/moves no money and creates no obligation/i.test(t?.description ?? ""),
		) &&
			/not a subscription, and not an investment/i.test(
				record?.description ?? "",
			),
	);

	/*
	 * THE BADGE ON THE DESCRIPTIONS. A tool description travels into
	 * transcripts, tool catalogues and registry listings that a response payload
	 * never reaches, so it is a surface in its own right. Byte equality against
	 * an independent copy of the constant, so a drift between the two
	 * repositories fails here rather than shipping as two subtly different
	 * badges.
	 */
	for (const t of tools.filter((x) => x.name.startsWith("sandbox_"))) {
		check(
			`${t.name} description opens with the badge`,
			(t.description ?? "").startsWith(BADGE),
			(t.description ?? "").slice(0, 60),
		);
	}
	check(
		"the two name-bearing tools carry the invented-names line",
		["sandbox_enroll", "sandbox_universe"].every((n) =>
			(tools.find((t) => t.name === n)?.description ?? "").includes(
				FICTION_NOTICE,
			),
		),
	);

	const { payload: info } = await call(client, "platform_info");
	check(
		"platform_info lists every sandbox tool",
		SANDBOX_TOOLS.every((n) => info.capabilities.tools.includes(n)),
	);
	check(
		"platform_info names every sandbox write",
		SANDBOX_WRITES.every((n) => info.capabilities.write_tools.includes(n)),
	);
	check(
		"platform_info does not advertise the retired name",
		!info.capabilities.tools.includes(RETIRED) &&
			!info.capabilities.write_tools.includes(RETIRED),
	);
	check(
		"platform_info still says this server cannot transact",
		info.capabilities.can_transact === false,
	);
	await client.close();
}

/* ------------------------------------------------------------------ */
section("no credential: every tool refuses and says what to do");
/* ------------------------------------------------------------------ */
{
	hits = [];
	const client = await connect({ ...ON, COMMERTIZE_AGENT_KEY: "" });
	for (const [name, args] of [
		["sandbox_enroll", {}],
		["sandbox_universe", {}],
		["sandbox_account", {}],
		[
			"sandbox_record_commitment",
			{
				asset_id: "fx-harbor-loop",
				quantity: 1,
				idempotency_key: "abcdefgh",
			},
		],
		["sandbox_withdraw_commitment", { commitment_id: "commitment-1" }],
	]) {
		const { payload: out } = await call(client, name, args);
		check(
			`${name} refuses`,
			out?.error?.code === "NO_CREDENTIAL",
			JSON.stringify(out?.error),
		);
		check(
			`${name} says how to fix it`,
			/COMMERTIZE_AGENT_KEY/.test(out?.error?.message ?? ""),
		);
	}
	check(
		"nothing reached the upstream without a credential",
		hits.length === 0,
		hits.join(","),
	);
	await client.close();
}

/* ------------------------------------------------------------------ */
section("the happy path relays the venue's own designation");
/* ------------------------------------------------------------------ */
{
	hits = [];
	stripEnvelope = false;
	const client = await connect(ON);

	const { payload: enroll } = await call(client, "sandbox_enroll");
	check("enroll relays simulation:true", enroll.simulation === true);
	check("enroll relays the badge verbatim", enroll.simulation_badge === BADGE);
	check(
		"enroll relays the invented-names line",
		enroll.simulation_fiction_notice === FICTION_NOTICE,
	);
	check(
		"enroll relays the disclaimer version",
		enroll.simulation_disclaimer_version === ENVELOPE.disclaimerVersion,
	);
	check(
		"enroll relays the publication notice",
		/credential holder's own use/.test(enroll.notice ?? ""),
	);
	check("enroll reports the fixture universe", enroll.universe === "fixture");
	check("enroll carries the credential", lastAgentKey === "ctza_test_secret");

	const { payload: universe } = await call(client, "sandbox_universe");
	check(
		"universe returns the invented asset",
		universe.assets?.[0]?.id === "fx-harbor-loop",
	);
	check(
		"every sponsor is marked fictional",
		universe.assets.every((a) => /\(fictional\)$/.test(a.sponsor)),
	);
	check(
		"no asset carries a performance field",
		universe.assets.every(
			(a) =>
				!Object.keys(a).some((k) => /return|yield|cap_rate|project/i.test(k)),
		),
	);

	posted = [];
	const { payload: rec } = await call(client, "sandbox_record_commitment", {
		asset_id: "fx-harbor-loop",
		quantity: 10,
		idempotency_key: "e2e-key-0001",
	});
	check("commitment is recorded", rec.commitment?.status === "recorded");
	check("the payload has no order key", !("order" in rec));
	check(
		"commitment carries no side field",
		rec.commitment !== null && !("side" in rec.commitment),
	);
	check(
		"commitment simulation flag comes off the row",
		rec.commitment?.simulation === true,
	);
	check(
		"commitment notional is unit amount x quantity, exactly",
		rec.commitment?.notional_cents === 100000 &&
			rec.commitment?.notional_cents ===
				rec.commitment?.unit_amount_cents * rec.commitment?.quantity,
	);
	const sent = posted.find((p) => p.path === "/api/agents/sandbox/commitments");
	check(
		"the record call went to the commitments path",
		sent !== undefined,
		posted.map((p) => p.path).join(","),
	);
	check(
		"nothing naming a side went upstream",
		sent !== undefined && !("side" in sent.body),
		JSON.stringify(sent?.body),
	);
	check(
		"the upstream body carries exactly the commitment fields",
		sent !== undefined &&
			JSON.stringify(Object.keys(sent.body).sort()) ===
				JSON.stringify(["assetId", "idempotencyKey", "quantity"]),
		JSON.stringify(sent?.body),
	);

	// A caller still passing `side` (an old client) does not smuggle it through.
	posted = [];
	await call(client, "sandbox_record_commitment", {
		asset_id: "fx-harbor-loop",
		side: "sell",
		quantity: 10,
		idempotency_key: "e2e-key-0002",
	});
	check(
		"a stray side argument is not forwarded",
		posted.length === 1 && !("side" in posted[0].body),
		JSON.stringify(posted),
	);

	const { payload: wd } = await call(client, "sandbox_withdraw_commitment", {
		commitment_id: "commitment-1",
	});
	check("withdrawal relays the withdrawn row", wd.commitment?.status === "withdrawn");
	check("withdrawal is not an error", wd.error === null);

	const { result: lateRes, payload: late } = await call(
		client,
		"sandbox_withdraw_commitment",
		{ commitment_id: "commitment-closed" },
	);
	check("a withdrawal after the simulated close is an error", lateRes.isError === true);
	check(
		"the late withdrawal relays the venue's reason",
		/simulated close has passed/.test(late?.error?.message ?? ""),
		JSON.stringify(late?.error),
	);
	check("the late withdrawal returns no commitment", late?.commitment === null);

	const { payload: weird } = await call(client, "sandbox_withdraw_commitment", {
		commitment_id: "../account",
	});
	check(
		"a commitment id that is not a plain id is refused before any call",
		weird?.error !== null && weird?.error !== undefined,
		JSON.stringify(weird?.error),
	);

	const { payload: account } = await call(client, "sandbox_account");
	check(
		"account reports the derived position",
		account.positions?.[0]?.units === 10,
	);

	await client.close();
}

/* ------------------------------------------------------------------ */
section("the retired name records nothing and names its replacement");
/* ------------------------------------------------------------------ */
{
	hits = [];
	const client = await connect(ON);
	const { result, payload } = await call(client, RETIRED, {
		asset_id: "fx-harbor-loop",
		side: "buy",
		quantity: 1,
		idempotency_key: "abcdefgh",
	});
	check("the retired name is an error", result.isError === true);
	check(
		"the retired name's error code says renamed",
		payload?.error?.code === "TOOL_RENAMED",
		JSON.stringify(payload?.error),
	);
	check(
		"the retired name's error names the new tool",
		/sandbox_record_commitment/.test(payload?.error?.message ?? ""),
	);
	check(
		"the retired name reached no upstream",
		hits.length === 0,
		hits.join(","),
	);
	await client.close();
}

/* ------------------------------------------------------------------ */
section("a credentialed read is never served from the shared cache");
/* ------------------------------------------------------------------ */
{
	hits = [];
	const client = await connect(ON);
	await call(client, "sandbox_account");
	await call(client, "sandbox_account");
	const accountHits = hits.filter(
		(h) => h === "/api/agents/sandbox/account",
	).length;
	// THE POINT: `getJson`'s cache is keyed on URL alone, so a cached
	// credentialed read would serve one agent's ledger to another. Two calls
	// must be two requests.
	check(
		"two reads are two upstream requests",
		accountHits === 2,
		`saw ${accountHits}`,
	);
	await client.close();
}

/* ------------------------------------------------------------------ */
section("if the venue stops sending its designation, we relay the absence");
/* ------------------------------------------------------------------ */
{
	stripEnvelope = true;
	const client = await connect(ON);
	const { payload: out } = await call(client, "sandbox_enroll");
	// Not `true`. A locally hardcoded designation would be a claim about a
	// response we did not read, and it would hide exactly the regression that
	// matters most on this surface.
	check("simulation is null, not invented", out.simulation === null);
	check("badge is null, not invented", out.simulation_badge === null);
	check("disclaimer is null, not invented", out.simulation_disclaimer === null);
	await client.close();
	stripEnvelope = false;
}

server.close();
summary("sandbox e2e");
