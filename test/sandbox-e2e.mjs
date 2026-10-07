/**
 * End-to-end suite for the four simulation-venue tools.
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
			orders: 0,
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
				unitPriceCents: 10000,
				unitsOutstanding: 400000,
			},
		],
	},
	"/api/agents/sandbox/orders": {
		...ENVELOPE,
		order: {
			seq: 1,
			id: "order-1",
			assetId: "fx-harbor-loop",
			universe: "fixture",
			side: "buy",
			status: "filled",
			quantity: 10,
			unitPriceCents: 10000,
			notionalCents: 100000,
			rejectionReason: null,
			simulation: true,
			createdAt: "2026-09-03T00:00:01.000Z",
		},
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

const server = createServer((req, res) => {
	const path = req.url.split("?")[0];
	hits.push(path);
	lastAgentKey = req.headers["x-agent-key"] ?? null;
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
	for (const name of [
		"sandbox_enroll",
		"sandbox_universe",
		"sandbox_place_order",
		"sandbox_account",
	]) {
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
	for (const name of [
		"sandbox_enroll",
		"sandbox_universe",
		"sandbox_place_order",
		"sandbox_account",
	]) {
		check(`${name} present in tools/list`, listed.includes(name));
	}

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
		"platform_info lists exactly what tools/list does",
		[
			"sandbox_enroll",
			"sandbox_universe",
			"sandbox_place_order",
			"sandbox_account",
		].every((n) => info.capabilities.tools.includes(n)),
	);
	check(
		"platform_info names both sandbox writes",
		info.capabilities.write_tools.includes("sandbox_enroll") &&
			info.capabilities.write_tools.includes("sandbox_place_order"),
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
			"sandbox_place_order",
			{
				asset_id: "fx-harbor-loop",
				side: "buy",
				quantity: 1,
				idempotency_key: "abcdefgh",
			},
		],
	]) {
		const { payload: out } = await call(client, name, args);
		check(
			`${name} refuses`,
			out.error?.code === "NO_CREDENTIAL",
			JSON.stringify(out.error),
		);
		check(
			`${name} says how to fix it`,
			/COMMERTIZE_AGENT_KEY/.test(out.error?.message ?? ""),
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

	const { payload: order } = await call(client, "sandbox_place_order", {
		asset_id: "fx-harbor-loop",
		side: "buy",
		quantity: 10,
		idempotency_key: "e2e-key-0001",
	});
	check("order is filled", order.order?.status === "filled");
	check(
		"order simulation flag comes off the row",
		order.order?.simulation === true,
	);
	check(
		"order notional is price x quantity, exactly",
		order.order?.notional_cents ===
			order.order?.unit_price_cents * order.order?.quantity,
	);

	const { payload: account } = await call(client, "sandbox_account");
	check(
		"account reports the derived position",
		account.positions?.[0]?.units === 10,
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
