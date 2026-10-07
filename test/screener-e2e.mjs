/**
 * End-to-end suite for the four screening tools.
 *
 * Real spawned server, real MCP stdio client, real JSON-RPC — against a LOCAL
 * stub upstream rather than api.commertize.com. Two reasons, both deliberate:
 *
 *   1. the live public set discloses no numeric fields at all (7 offerings,
 *      every `financials`/`tokenomics` empty as of 2026-08-26), so a live suite
 *      could not exercise a single range filter. It would pass at exactly the
 *      value where the bug cannot manifest.
 *   2. a stub makes the assertions exact: "2 of these 4" instead of "some".
 *
 * The stub serves the SHAPE the live API returns — key names taken from a live
 * `GET https://api.commertize.com/api/listings` on 2026-08-26 — with values
 * filled in. It invents no field the API does not have.
 *
 * The offerings gate is exercised with `COMMERTIZE_MCP_DISABLE_OFFERINGS`,
 * which closes the gate whatever the default policy is, so this suite does not
 * depend on it.
 * Sections that need the gate OPEN set `COMMERTIZE_MCP_ENABLE_OFFERINGS=1`,
 * which is a no-op under the committed policy and the opt-in under the other.
 */

import { createServer } from "node:http";

import {
	call,
	check,
	checkEnvelope,
	connect,
	DISCLAIMER,
	resetCounters,
	section,
	summary,
} from "./harness.mjs";

/* ------------------------------------------------------------------ */
/* stub upstream                                                       */
/* ------------------------------------------------------------------ */

const listing = (over) => ({
	id: "id",
	name: "Fixture",
	city: "Springfield",
	state: "IL",
	propertyType: "MULTIFAMILY",
	status: "ACTIVE",
	offeringType: "RULE_506_B",
	sponsor: { id: "sp-1", businessName: "Acme Capital" },
	financials: {},
	tokenomics: {},
	images: [],
	impliedEquityValuation: null,
	investorTokenShare: null,
	sponsorTokenShare: null,
	derivedCapRate: null,
	year1CashOnCash: null,
	...over,
});

const rich = (over) =>
	listing({
		financials: {
			targetIRR: 0.18,
			targetEquityMultiple: 2.1,
			preferredReturn: 0.08,
			holdPeriodYears: 5,
			distributionFrequency: "QUARTERLY",
		},
		tokenomics: {
			tokenPrice: 100,
			totalTokenSupply: 10_000,
			tokensForInvestors: 8_000,
			minInvestmentTokens: 10,
			lockupMonths: 12,
		},
		...over,
	});

const LISTINGS = [
	rich({
		id: "high-cap",
		name: "High Cap Tower",
		city: "Temple",
		state: "TX",
		propertyType: "MULTIFAMILY",
		status: "ACTIVE",
		derivedCapRate: 0.09,
		year1CashOnCash: 0.08,
	}),
	rich({
		id: "low-cap",
		name: "Low Cap Lodge",
		city: "Silverdale",
		state: "WA",
		propertyType: "HOSPITALITY",
		status: "TOKENIZING",
		derivedCapRate: 0.03,
		year1CashOnCash: 0.02,
		sponsor: { id: "sp-2", businessName: "Beta Partners" },
	}),
	listing({
		id: "quiet",
		name: "Quiet Holdings",
		city: "Fond du Lac / De Pere",
		state: "WI",
		propertyType: "MULTIFAMILY",
		status: "TOKENIZING",
	}),
];

const ARTICLES = [
	{
		id: "a1",
		slug: "an-article",
		title: "An article",
		summary: "A summary.",
		content: "<p>Body.</p>",
		category: "Tokenization",
		tags: ["rwa"],
		publishedAt: "2026-08-01T00:00:00.000Z",
		readTime: 3,
		imageUrl: null,
	},
];

const startStub = () =>
	new Promise((resolve) => {
		const server = createServer((req, res) => {
			const url = new URL(req.url, "http://localhost");
			res.writeHead(200, { "content-type": "application/json" });
			if (url.pathname === "/api/listings") res.end(JSON.stringify(LISTINGS));
			else if (url.pathname === "/api/news")
				res.end(JSON.stringify({ data: ARTICLES }));
			else res.end("{}");
		});
		server.listen(0, "127.0.0.1", () =>
			resolve({ server, port: server.address().port })
		);
	});

const NEW_TOOLS = [
	"search_offerings",
	"compare_offerings",
	"list_sponsors",
	"get_sponsor",
];

resetCounters();
const { server: stub, port } = await startStub();
const OPEN = {
	COMMERTIZE_API_BASE_URL: `http://127.0.0.1:${port}`,
	COMMERTIZE_MCP_ENABLE_OFFERINGS: "1",
	COMMERTIZE_MCP_DISABLE_OFFERINGS: "",
	// This suite counts the FULL default surface, so both deployment gates are
	// opened here. The count they produce is asserted twice: 12 with them open
	// (below) and 10 with them closed (gates-e2e.mjs).
	COMMERTIZE_MCP_ENABLE_MEMO: "1",
	COMMERTIZE_MCP_DISABLE_MEMO: "",
	COMMERTIZE_MCP_ENABLE_DISCLOSURE: "1",
	COMMERTIZE_MCP_DISABLE_DISCLOSURE: "",
	// Every section below expects a fresh fetch; a shared 60s cache across
	// separately-spawned processes would not matter, but a 1ms TTL makes that
	// independence explicit rather than incidental.
	COMMERTIZE_CACHE_TTL_MS: "1",
};

/* ---------------------------------------------------------------- */
section("1. the new tools are advertised");
{
	const client = await connect(OPEN);
	const { tools } = await client.listTools();
	const names = tools.map((t) => t.name);

	for (const name of NEW_TOOLS) {
		check(`tools/list advertises ${name}`, names.includes(name));
	}
	check(
		"the five remaining original tools are untouched (get_platform_stats removed 2026-09-26)",
		[
			"list_offerings",
			"get_offering",
			"get_news",
			"get_article",
			"platform_info",
		].every((n) => names.includes(n))
	);
	// Eleven reads plus `request_memo`, the one write, WITH EVERY DEPLOYMENT
	// GATE OPEN. Was 10 before 2026-09-02 and 11 before
	// `get_disclosure_package` (2026-09-08). With the gates at their shipped
	// defaults it is 10 — see gates-e2e.mjs, which asserts that number and the
	// difference between the two lists. get_platform_stats was removed on
	// 2026-09-26: 12 -> 11 open, 10 -> 9 default.
	check("eleven tools total, gates open", names.length === 11, String(names.length));
	check("no duplicate tool names", new Set(names).size === names.length);

	for (const name of NEW_TOOLS) {
		const tool = tools.find((t) => t.name === name);
		check(
			`${name}: declares readOnlyHint`,
			tool?.annotations?.readOnlyHint === true
		);
		check(
			`${name}: declares an output schema`,
			typeof tool?.outputSchema === "object" && tool.outputSchema !== null
		);
		check(
			`${name}: description states it is not an offer or recommendation`,
			/not an offer, solicitation, or recommendation/i.test(
				tool?.description ?? ""
			)
		);
	}
	check(
		"search_offerings exposes min/max range arguments",
		(() => {
			const props =
				tools.find((t) => t.name === "search_offerings")?.inputSchema
					?.properties ?? {};
			return (
				"min_cap_rate" in props &&
				"max_cap_rate" in props &&
				"min_target_irr" in props &&
				"max_spv_leverage_ratio" in props
			);
		})()
	);
	await client.close();
}

/* ---------------------------------------------------------------- */
section("2. search_offerings against real filters");
{
	const client = await connect(OPEN);

	const all = await call(client, "search_offerings");
	checkEnvelope("search_offerings", all.payload);
	check("no criteria returns the whole public set", all.payload.count === 3);
	check("total_available reports the pre-filter size", all.payload.total_available === 3);
	check("not flagged as an error", all.result.isError !== true);

	const tx = await call(client, "search_offerings", { state: "tx" });
	check("state filter narrows, case-insensitively", tx.payload.count === 1);
	check(
		"the matched record is a full offering, not a stub",
		tx.payload.offerings[0]?.tokenomics?.token_price === 100 &&
			tx.payload.offerings[0]?.derived?.target_raise === 800_000
	);

	const capped = await call(client, "search_offerings", { min_cap_rate: 0.05 });
	check("min_cap_rate keeps only the disclosed value above it", capped.payload.count === 1);
	check(
		"the disclosed value BELOW the floor is counted as a criteria exclusion",
		capped.payload.excluded_by_criteria === 1,
		String(capped.payload.excluded_by_criteria)
	);
	check(
		"the UNDISCLOSED offering is reported, not silently dropped",
		capped.payload.excluded_not_disclosed.length === 1 &&
			capped.payload.excluded_not_disclosed[0].id === "quiet" &&
			capped.payload.excluded_not_disclosed[0].missing_fields.join() === "cap_rate",
		JSON.stringify(capped.payload.excluded_not_disclosed)
	);
	check(
		"field_coverage explains the result (2 of 3 disclose cap_rate)",
		capped.payload.field_coverage.find((c) => c.field === "cap_rate")
			?.disclosed === 2
	);
	check(
		"field_catalogue documents each field's unit and provenance",
		capped.payload.field_catalogue.find((f) => f.field === "cap_rate")?.unit ===
			"fraction" &&
			capped.payload.field_catalogue.find((f) => f.field === "target_equity_multiple")
				?.unit === "multiple"
	);

	const sorted = await call(client, "search_offerings", {
		sort_by: "cap_rate",
		order: "asc",
	});
	check(
		"sorting puts undisclosed LAST even ascending",
		sorted.payload.offerings.map((o) => o.id).join() === "low-cap,high-cap,quiet",
		sorted.payload.offerings.map((o) => o.id).join()
	);

	const limited = await call(client, "search_offerings", { limit: 1 });
	check("limit truncates and says so", limited.payload.count === 1 && limited.payload.truncated === true);

	const bogus = await call(client, "search_offerings", { sort_by: "vibes" });
	check(
		"an unknown sort field is reported rather than silently ignored",
		bogus.payload.unknown_fields.join() === "vibes" && bogus.payload.count === 3
	);

	const none = await call(client, "search_offerings", { state: "ZZ" });
	check("a genuine no-match returns count 0 without an error", none.payload.count === 0 && none.result.isError !== true);
	check(
		"a no-match still carries coverage, so 0 results is explainable",
		Array.isArray(none.payload.field_coverage) &&
			none.payload.field_coverage.every((c) => c.total === 0 && c.coverage === null)
	);
	await client.close();
}

/* ---------------------------------------------------------------- */
section("3. compare_offerings");
{
	const client = await connect(OPEN);

	const cmp = await call(client, "compare_offerings", {
		offering_ids: ["high-cap", "low-cap"],
	});
	checkEnvelope("compare_offerings", cmp.payload);
	check("comparison is not an error", cmp.result.isError !== true);
	check("ids echo in request order", cmp.payload.offering_ids.join() === "high-cap,low-cap");
	check(
		"a differing disclosed field is listed",
		cmp.payload.differing_fields.includes("cap_rate")
	);
	check(
		"a field neither discloses is named as a gap",
		cmp.payload.undisclosed_by_all.includes("implied_equity_valuation")
	);
	check(
		"rows carry units so a fraction is not misread",
		cmp.payload.rows.find((r) => r.field === "cap_rate")?.unit === "fraction"
	);

	const partial = await call(client, "compare_offerings", {
		offering_ids: ["high-cap", "quiet"],
	});
	check(
		"partial disclosure is flagged rather than shown as a bare null",
		partial.payload.rows.find((r) => r.field === "cap_rate")
			?.partially_disclosed === true
	);

	const missing = await call(client, "compare_offerings", {
		offering_ids: ["high-cap", "low-cap", "does-not-exist"],
	});
	check(
		"an unmatched id is reported so a comparison of 3 is never silently 2",
		missing.payload.not_found.join() === "does-not-exist" &&
			missing.payload.offering_ids.length === 2
	);

	const tooFew = await call(client, "compare_offerings", {
		offering_ids: ["high-cap", "nope"],
	});
	check(
		"fewer than two resolvable ids is a refusal, not a one-column comparison",
		tooFew.result.isError === true && tooFew.payload.error?.code === "NOT_FOUND",
		tooFew.payload.error?.code
	);
	check(
		"the refusal names the ids that did not resolve",
		/nope/.test(tooFew.payload.error?.message ?? "")
	);
	checkEnvelope("compare_offerings refusal", tooFew.payload);
	await client.close();
}

/* ---------------------------------------------------------------- */
section("4. sponsors");
{
	const client = await connect(OPEN);

	const list = await call(client, "list_sponsors");
	checkEnvelope("list_sponsors", list.payload);
	check("both sponsors in the set are listed", list.payload.count === 2);
	check(
		"the sponsor with two offerings sorts first",
		list.payload.sponsors[0]?.sponsor_id === "sp-1" &&
			list.payload.sponsors[0]?.offering_count === 2
	);
	check(
		"the basis says explicitly that this is not a track record",
		/NOT a track record/.test(list.payload.basis ?? "")
	);

	const one = await call(client, "get_sponsor", { sponsor: "sp-2" });
	checkEnvelope("get_sponsor", one.payload);
	check("a sponsor resolves by exact id", one.payload.sponsor?.sponsor_name === "Beta Partners");
	check(
		"the record names every unavailable sponsor fact",
		["track_record", "prior_deals", "realized_returns", "assets_under_management", "principals"].every(
			(f) => one.payload.sponsor?.not_available?.includes(f)
		),
		JSON.stringify(one.payload.sponsor?.not_available)
	);
	check(
		"no field in the sponsor record resembles a performance claim",
		!JSON.stringify(one.payload.sponsor).match(/"(irr|returns_realized|performance|aum)"/i)
	);

	const byName = await call(client, "get_sponsor", { sponsor: "beta" });
	check("a unique name substring resolves", byName.payload.sponsor?.sponsor_id === "sp-2");

	const ambiguous = await call(client, "get_sponsor", { sponsor: "a" });
	check(
		"a substring spanning two sponsors refuses instead of merging them",
		ambiguous.result.isError === true &&
			ambiguous.payload.error?.code === "AMBIGUOUS",
		ambiguous.payload.error?.code
	);
	check(
		"the ambiguous refusal lists the candidates",
		ambiguous.payload.ambiguous_matches?.length === 2
	);
	check("an ambiguous refusal returns no sponsor record", ambiguous.payload.sponsor === null);

	const absent = await call(client, "get_sponsor", { sponsor: "nobody-here" });
	check(
		"an unknown sponsor is NOT_FOUND, not an empty record",
		absent.result.isError === true && absent.payload.error?.code === "NOT_FOUND"
	);
	await client.close();
}

/* ---------------------------------------------------------------- */
section("5. the offerings gate closes ALL FOUR new tools");
{
	// DISABLE beats every other flag whatever the default policy, so this
	// section does not depend on it.
	const client = await connect({
		...OPEN,
		COMMERTIZE_MCP_DISABLE_OFFERINGS: "1",
	});

	const probes = [
		["search_offerings", {}],
		["compare_offerings", { offering_ids: ["high-cap", "low-cap"] }],
		["list_sponsors", {}],
		["get_sponsor", { sponsor: "sp-1" }],
	];
	for (const [tool, args] of probes) {
		const { result, payload } = await call(client, tool, args);
		check(
			`${tool}: refused by the gate`,
			result.isError === true && payload.error?.code === "TOOL_DISABLED",
			payload.error?.code
		);
		check(
			`${tool}: the refusal says it is policy, not an outage`,
			/policy state, not an outage/.test(payload.error?.message ?? "")
		);
		checkEnvelope(`${tool} gated`, payload);
	}
	// Aggregation is not a loophole: sponsor data is listing data.
	const sponsors = await call(client, "list_sponsors");
	check(
		"gated list_sponsors leaks no sponsor rows",
		Array.isArray(sponsors.payload.sponsors) && sponsors.payload.sponsors.length === 0
	);
	const search = await call(client, "search_offerings");
	check(
		"gated search_offerings leaks no offering rows",
		search.payload.offerings.length === 0 && search.payload.total_available === 0
	);

	const news = await call(client, "get_news", { limit: 1 });
	check(
		"the gate does not touch non-offering tools",
		news.result.isError !== true && news.payload.articles.length === 1
	);
	await client.close();
}

/* ---------------------------------------------------------------- */
section("6. envelope parity with the original tools");
{
	/*
	 * `envelope.ts` is an extraction of private helpers that still live in
	 * `tools.ts` (see that file's docblock for why the duplication is temporary
	 * and one-directional). A comment cannot stop them drifting; this can.
	 */
	const client = await connect(OPEN);
	const ENVELOPE_KEYS = ["as_of", "source_url", "cache", "disclaimer", "error"];

	const old = await call(client, "get_news", { limit: 1 });
	const fresh = await call(client, "search_offerings");

	check(
		"a new tool carries exactly the same envelope keys as an original one",
		ENVELOPE_KEYS.every((k) => k in old.payload && k in fresh.payload)
	);
	check(
		"the disclaimer is the same constant, byte for byte",
		fresh.payload.disclaimer === old.payload.disclaimer &&
			fresh.payload.disclaimer === DISCLAIMER
	);
	check(
		"the cache block has the same shape",
		Object.keys(fresh.payload.cache).sort().join() ===
			Object.keys(old.payload.cache).sort().join()
	);

	const oldErr = await call(client, "get_article", { slug: "no-such-article" });
	const freshErr = await call(client, "get_sponsor", { sponsor: "no-such-sponsor" });
	check(
		"failure envelopes match too: same keys, same error shape",
		ENVELOPE_KEYS.every((k) => k in oldErr.payload && k in freshErr.payload) &&
			Object.keys(freshErr.payload.error).sort().join() ===
				Object.keys(oldErr.payload.error).sort().join(),
		`${Object.keys(freshErr.payload.error ?? {})} vs ${Object.keys(oldErr.payload.error ?? {})}`
	);
	check(
		"both failure envelopes keep their payload keys present",
		"article" in oldErr.payload && "sponsor" in freshErr.payload
	);
	await client.close();
}

/* ---------------------------------------------------------------- */
section("7. upstream failure never becomes an empty answer");
{
	// Port 1 on loopback: nothing listens, connection refused immediately.
	const client = await connect({
		COMMERTIZE_API_BASE_URL: "http://127.0.0.1:1",
		COMMERTIZE_MCP_ENABLE_OFFERINGS: "1",
		COMMERTIZE_MCP_DISABLE_OFFERINGS: "",
	});
	for (const [tool, args, emptyKey] of [
		["search_offerings", {}, "offerings"],
		["list_sponsors", {}, "sponsors"],
		["get_sponsor", { sponsor: "sp-1" }, null],
		["compare_offerings", { offering_ids: ["a", "b"] }, "rows"],
	]) {
		const { result, payload } = await call(client, tool, args);
		check(
			`${tool}: upstream down is flagged isError`,
			result.isError === true,
			JSON.stringify(payload?.error)
		);
		check(
			`${tool}: reports UPSTREAM_UNREACHABLE, not an empty result`,
			payload.error?.code === "UPSTREAM_UNREACHABLE",
			payload.error?.code
		);
		check(`${tool}: marked retryable`, payload.error?.retryable === true);
		if (emptyKey) {
			check(
				`${tool}: ${emptyKey} is empty AND the error says why`,
				Array.isArray(payload[emptyKey]) && payload[emptyKey].length === 0
			);
		}
		checkEnvelope(`${tool} upstream-down`, payload);
	}
	await client.close();
}

stub.close();
process.exit(summary("screener e2e") === 0 ? 0 : 1);
