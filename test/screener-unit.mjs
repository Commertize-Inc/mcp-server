/**
 * Unit suite for the screening/comparison/sponsor logic.
 *
 * Runs against the BUILT module, not the source, so it exercises the artifact
 * the server actually loads. No network: `normalizeOffering` is a pure mapper,
 * so a synthetic raw listing produces a real `Offering` without an API.
 *
 * Fixtures deliberately disclose figures the LIVE public set does not (every
 * live listing returns `financials: {}` / `tokenomics: {}` as of 2026-08-26).
 * That is the point: the filters have to be exercised against data that
 * exists, or the suite would pass for the same reason a broken screener does.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { check, resetCounters, section, summary } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dist = (file) => path.resolve(HERE, "..", "dist", file);

const { normalizeOffering } = await import(dist("normalize.js"));
const {
	compareOfferings,
	fieldCoverage,
	findSponsor,
	numericField,
	numericFieldIds,
	readNumeric,
	rollUpSponsors,
	screenOfferings,
} = await import(dist("screener.js"));

resetCounters();

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const raw = (over = {}) => ({
	id: "id-x",
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
	...over,
});

/** A listing that discloses everything the screener can filter on. */
const rich = (over = {}) =>
	raw({
		financials: {
			targetIRR: 0.18,
			targetEquityMultiple: 2.1,
			preferredReturn: 0.08,
			holdPeriodYears: 5,
			distributionFrequency: "QUARTERLY",
			...(over.financials ?? {}),
		},
		tokenomics: {
			tokenPrice: 100,
			totalTokenSupply: 10_000,
			tokensForInvestors: 8_000,
			minInvestmentTokens: 10,
			lockupMonths: 12,
			...(over.tokenomics ?? {}),
		},
		derivedCapRate: 0.06,
		year1CashOnCash: 0.07,
		...over,
	});

const off = (over) => normalizeOffering(rich(over));
/** A listing that discloses nothing numeric — the shape of the live set. */
const bare = (over) => normalizeOffering(raw(over));

/* ------------------------------------------------------------------ */
section("1. numeric field catalogue");
{
	const ids = numericFieldIds();
	check("14 numeric fields registered", ids.length === 14, String(ids.length));
	check("ids are unique", new Set(ids).size === ids.length);
	check(
		"every id resolves to a spec with a unit and a kind",
		ids.every((id) => {
			const spec = numericField(id);
			return spec && typeof spec.unit === "string" && typeof spec.kind === "string";
		})
	);
	check(
		"an unknown field resolves to undefined, not a prototype member",
		numericField("constructor") === undefined &&
			numericField("toString") === undefined
	);
	check(
		"readNumeric returns null for an unknown field rather than throwing",
		readNumeric(off({}), "not_a_field") === null
	);
	check(
		"cap_rate reads the platform-derived value",
		readNumeric(off({ derivedCapRate: 0.055 }), "cap_rate") === 0.055
	);
	check(
		"target_raise is tokens_for_investors x token_price",
		readNumeric(off({}), "target_raise") === 800_000
	);
	check(
		"min_investment_amount is min_investment_tokens x token_price",
		readNumeric(off({}), "min_investment_amount") === 1_000
	);
}

/* ------------------------------------------------------------------ */
section("2. field coverage");
{
	const empty = fieldCoverage([]);
	check("empty set still reports every field", empty.length === 14);
	check(
		"coverage of an EMPTY set is null, never 0",
		empty.every((c) => c.coverage === null && c.total === 0 && c.disclosed === 0)
	);

	const mixed = fieldCoverage([off({}), bare({}), bare({})]);
	const capRate = mixed.find((c) => c.field === "cap_rate");
	check(
		"1 of 3 disclosing cap_rate reports 1/3",
		capRate.disclosed === 1 && capRate.total === 3,
		JSON.stringify(capRate)
	);
	check(
		"coverage is the ratio, not a percentage",
		Math.abs(capRate.coverage - 1 / 3) < 1e-12
	);

	const noneCover = fieldCoverage([bare({}), bare({})]);
	check(
		"a set that discloses nothing reports 0 of 2 with coverage 0",
		noneCover.every((c) => c.disclosed === 0 && c.total === 2 && c.coverage === 0)
	);
	check(
		"0-of-2 (coverage 0) is distinguishable from 0-of-0 (coverage null)",
		noneCover[0].coverage === 0 && empty[0].coverage === null
	);
}

/* ------------------------------------------------------------------ */
section("3. categorical filters");
{
	const set = [
		bare({ id: "a", name: "Alpha", city: "Temple", state: "TX", propertyType: "MULTIFAMILY", status: "ACTIVE" }),
		bare({ id: "b", name: "Bravo", city: "Silverdale", state: "WA", propertyType: "HOSPITALITY", status: "TOKENIZING" }),
		bare({ id: "c", name: "Charlie", city: "Fond du Lac / De Pere", state: "WI", propertyType: "MULTIFAMILY", status: "TOKENIZING" }),
	];
	const ids = (r) => r.matched.map((o) => o.id);

	check(
		"no criteria returns everything",
		screenOfferings(set, {}).matched.length === 3
	);
	check(
		"asset_class is exact and case-insensitive",
		ids(screenOfferings(set, { asset_class: "multifamily" })).join() === "a,c"
	);
	check(
		"state is exact and case-insensitive",
		ids(screenOfferings(set, { state: "wa" })).join() === "b"
	);
	check(
		"city is a SUBSTRING, so a two-town listing is findable by either name",
		ids(screenOfferings(set, { city: "de pere" })).join() === "c"
	);
	check(
		"status filters on the code",
		ids(screenOfferings(set, { status: "TOKENIZING" })).join() === "b,c"
	);
	check(
		"accepting_investment true selects only ACTIVE",
		ids(screenOfferings(set, { accepting_investment: true })).join() === "a"
	);
	check(
		"accepting_investment FALSE selects the rest — not ignored as falsy",
		ids(screenOfferings(set, { accepting_investment: false })).join() === "b,c"
	);
	check(
		"query matches the sponsor name, not only the offering name",
		ids(screenOfferings(set, { query: "acme" })).length === 3
	);
	check(
		"query matches a city",
		ids(screenOfferings(set, { query: "silverdale" })).join() === "b"
	);
	check(
		"query that matches nothing returns nothing",
		screenOfferings(set, { query: "zzzz" }).matched.length === 0
	);
	check(
		"sponsor by exact id",
		ids(screenOfferings(set, { sponsor: "sp-1" })).length === 3
	);
	check(
		"sponsor by name substring, case-insensitive",
		ids(screenOfferings(set, { sponsor: "acme cap" })).length === 3
	);
	check(
		"sponsor that matches nothing returns nothing",
		screenOfferings(set, { sponsor: "sp-999" }).matched.length === 0
	);
	check(
		"filters compose (AND, not OR)",
		ids(screenOfferings(set, { asset_class: "MULTIFAMILY", state: "WI" })).join() ===
			"c"
	);
	check(
		"total_available is the pre-filter size",
		screenOfferings(set, { state: "wa" }).total_available === 3
	);
	check(
		"candidates is the post-categorical size",
		screenOfferings(set, { state: "wa" }).candidates === 1
	);
}

/* ------------------------------------------------------------------ */
section("4. numeric ranges — the undisclosed/non-matching distinction");
{
	const set = [
		off({ id: "hi", derivedCapRate: 0.09 }),
		off({ id: "mid", derivedCapRate: 0.06 }),
		off({ id: "lo", derivedCapRate: 0.03 }),
		bare({ id: "quiet" }),
	];

	const r = screenOfferings(set, {
		ranges: [{ field: "cap_rate", min: 0.05, max: null }],
	});
	check(
		"min filter keeps the disclosed values above it",
		r.matched.map((o) => o.id).join() === "hi,mid"
	);
	check(
		"a disclosed value below the floor counts as excluded_by_criteria",
		r.excluded_by_criteria === 1,
		String(r.excluded_by_criteria)
	);
	check(
		"an UNDISCLOSED value is not counted as a non-match",
		r.excluded_by_criteria === 1 && r.excluded_not_disclosed.length === 1
	);
	check(
		"the undisclosed exclusion names the offering AND the missing field",
		r.excluded_not_disclosed[0].id === "quiet" &&
			r.excluded_not_disclosed[0].missing_fields.join() === "cap_rate",
		JSON.stringify(r.excluded_not_disclosed)
	);

	// Boundary: a test that only probes 0.05 vs 0.09 cannot tell inclusive from
	// exclusive. These two probe EXACTLY the bound.
	const exact = screenOfferings([off({ id: "on", derivedCapRate: 0.05 })], {
		ranges: [{ field: "cap_rate", min: 0.05, max: null }],
	});
	check("min is INCLUSIVE at the exact bound", exact.matched.length === 1);
	const exactMax = screenOfferings([off({ id: "on", derivedCapRate: 0.05 })], {
		ranges: [{ field: "cap_rate", max: 0.05, min: null }],
	});
	check("max is INCLUSIVE at the exact bound", exactMax.matched.length === 1);
	const justOver = screenOfferings(
		[off({ id: "over", derivedCapRate: 0.050000001 })],
		{ ranges: [{ field: "cap_rate", max: 0.05, min: null }] }
	);
	check(
		"max excludes a value one epsilon above the bound",
		justOver.matched.length === 0 && justOver.excluded_by_criteria === 1
	);

	const band = screenOfferings(set, {
		ranges: [{ field: "cap_rate", min: 0.04, max: 0.07 }],
	});
	check(
		"min and max together form a closed band",
		band.matched.map((o) => o.id).join() === "mid"
	);

	const multi = screenOfferings([bare({ id: "quiet" })], {
		ranges: [
			{ field: "cap_rate", min: 0.05, max: null },
			{ field: "target_irr", min: 0.1, max: null },
		],
	});
	check(
		"EVERY missing filtered field is listed, not just the first",
		multi.excluded_not_disclosed[0].missing_fields.join() === "cap_rate,target_irr",
		JSON.stringify(multi.excluded_not_disclosed[0].missing_fields)
	);

	const lockup = screenOfferings(
		[off({ id: "z", tokenomics: { lockupMonths: 0 } })],
		{ ranges: [{ field: "lockup_months", min: null, max: 0 }] }
	);
	check(
		"a DISCLOSED zero passes a max-0 filter (0 is not treated as absent)",
		lockup.matched.length === 1 && lockup.excluded_not_disclosed.length === 0
	);

	const unknown = screenOfferings(set, {
		ranges: [{ field: "made_up_metric", min: 1, max: null }],
	});
	check(
		"an unknown range field is REPORTED",
		unknown.unknown_fields.join() === "made_up_metric"
	);
	check(
		"an unknown range field is then ignored, not silently a no-match",
		unknown.matched.length === 4
	);

	check(
		"field_coverage is computed over CANDIDATES, so it explains an empty result",
		screenOfferings(set, {
			state: "ZZ",
			ranges: [{ field: "cap_rate", min: 0.05, max: null }],
		}).field_coverage.find((c) => c.field === "cap_rate").total === 0
	);
}

/* ------------------------------------------------------------------ */
section("5. sorting and limits");
{
	const set = [
		off({ id: "lo", derivedCapRate: 0.03 }),
		bare({ id: "quiet" }),
		off({ id: "hi", derivedCapRate: 0.09 }),
		off({ id: "mid", derivedCapRate: 0.06 }),
	];

	const desc = screenOfferings(set, { sort_by: "cap_rate", order: "desc" });
	check(
		"desc sorts high to low",
		desc.matched.map((o) => o.id).join() === "hi,mid,lo,quiet"
	);
	const asc = screenOfferings(set, { sort_by: "cap_rate", order: "asc" });
	check(
		"asc sorts low to high",
		asc.matched.map((o) => o.id).join() === "lo,mid,hi,quiet"
	);
	// The bug this pins: nulls treated as -Infinity would put "quiet" FIRST on
	// asc and last on desc, i.e. two different answers about the same absence.
	check(
		"undisclosed sorts LAST in BOTH directions",
		desc.matched.at(-1).id === "quiet" && asc.matched.at(-1).id === "quiet"
	);
	check("sorted_by echoes the field", desc.sorted_by === "cap_rate");
	check(
		"an unknown sort field is reported and sorting is skipped",
		(() => {
			const r = screenOfferings(set, { sort_by: "nope" });
			return r.unknown_fields.join() === "nope" && r.sorted_by === null;
		})()
	);
	check("default order is desc", screenOfferings(set, {}).sort_order === "desc");

	const limited = screenOfferings(set, {
		sort_by: "cap_rate",
		order: "desc",
		limit: 2,
	});
	check("limit cuts the page", limited.matched.length === 2);
	check("limit sets truncated", limited.truncated === true);
	// Boundary: limit exactly equal to the result size is NOT truncation.
	check(
		"limit equal to the match count is not truncated",
		screenOfferings(set, { limit: 4 }).truncated === false
	);
	check(
		"limit of 1 over the match count is not truncated",
		screenOfferings(set, { limit: 5 }).truncated === false
	);
	check(
		"no limit is not truncated",
		screenOfferings(set, {}).truncated === false
	);
}

/* ------------------------------------------------------------------ */
section("6. comparison");
{
	const a = off({ id: "a", name: "Alpha", state: "TX", derivedCapRate: 0.06 });
	const b = off({ id: "b", name: "Bravo", state: "WA", derivedCapRate: 0.08 });
	const quiet = bare({ id: "q", name: "Quiet", state: "TX" });

	const cmp = compareOfferings([a, b]);
	check(
		"values are in the order the offerings were given",
		cmp.rows.find((r) => r.field === "name").values.join() === "Alpha,Bravo"
	);
	check(
		"a field both disclose and agree on is identical",
		cmp.rows.find((r) => r.field === "exemption").identical === true
	);
	check(
		"a field both disclose and differ on is not identical",
		cmp.rows.find((r) => r.field === "cap_rate").identical === false
	);
	check(
		"differing_fields lists exactly the fully-disclosed disagreements",
		cmp.differing_fields.includes("cap_rate") &&
			cmp.differing_fields.includes("state") &&
			!cmp.differing_fields.includes("exemption")
	);
	check(
		"a field neither discloses is reported in undisclosed_by_all",
		cmp.undisclosed_by_all.includes("implied_equity_valuation")
	);
	check(
		"an undisclosed-by-all field is NOT reported as identical",
		cmp.rows.find((r) => r.field === "implied_equity_valuation").identical === false
	);

	const partial = compareOfferings([a, quiet]);
	const capRow = partial.rows.find((r) => r.field === "cap_rate");
	check(
		"partial disclosure is flagged and counted",
		capRow.disclosed_by === 1 && capRow.partially_disclosed === true
	);
	check(
		"a partially disclosed field is not identical and not in differing_fields",
		capRow.identical === false && !partial.differing_fields.includes("cap_rate")
	);
	check(
		"units travel with the row so a fraction is not read as a percent",
		capRow.unit === "fraction" && capRow.kind === "derived"
	);
	check(
		"categorical rows carry a null unit",
		partial.rows.find((r) => r.field === "state").unit === null
	);
	check(
		"a projection is labelled as a projection",
		partial.rows.find((r) => r.field === "target_irr").kind === "projection"
	);

	const none = compareOfferings([]);
	check(
		"comparing an EMPTY list reports nothing identical (0 === 0 is not agreement)",
		none.rows.every((r) => r.identical === false)
	);
	// Regression: `disclosed_by === offerings.length` is trivially true when
	// both are 0, which put every field into differing_fields — a comparison of
	// nothing claiming everything disagreed.
	check(
		"an empty comparison claims NOTHING differs",
		none.differing_fields.length === 0
	);
	check(
		"an empty comparison claims NOTHING is undisclosed-by-all either",
		none.undisclosed_by_all.length === 0
	);
	check(
		"an empty comparison still enumerates every field as a row",
		none.rows.length > 0 && none.rows.every((r) => r.values.length === 0)
	);
	const single = compareOfferings([a]);
	check(
		"a ONE-offering comparison reports no differences (nothing to differ from)",
		single.differing_fields.length === 0
	);
	check(
		"a boolean field compares as a boolean, not as a truthy string",
		compareOfferings([a, quiet]).rows.find(
			(r) => r.field === "accepting_investment"
		).values.join() === "true,true"
	);
}

/* ------------------------------------------------------------------ */
section("7. sponsors");
{
	const set = [
		off({ id: "1", sponsor: { id: "sp-1", businessName: "Acme Capital" }, status: "ACTIVE", propertyType: "MULTIFAMILY", state: "TX" }),
		bare({ id: "2", sponsor: { id: "sp-1", businessName: "Acme Capital" }, status: "TOKENIZING", propertyType: "MULTIFAMILY", state: "WI" }),
		bare({ id: "3", sponsor: { id: "sp-2", businessName: "Beta Partners" }, status: "TOKENIZING", propertyType: "HOSPITALITY", state: "WA" }),
		bare({ id: "4", sponsor: null }),
	];

	const { sponsors, unattributed } = rollUpSponsors(set);
	check("distinct sponsors are grouped by id", sponsors.length === 2);
	check(
		"sponsors sort by offering count, descending",
		sponsors[0].sponsor_id === "sp-1" && sponsors[0].offering_count === 2
	);
	check(
		"an offering with no sponsor id or name is counted, not invented",
		unattributed === 1
	);
	check(
		"status tally counts each code",
		JSON.stringify(sponsors[0].by_status) ===
			JSON.stringify([
				{ code: "ACTIVE", count: 1 },
				{ code: "TOKENIZING", count: 1 },
			]),
		JSON.stringify(sponsors[0].by_status)
	);
	check(
		"states are de-duplicated and sorted",
		sponsors[0].states.join() === "TX,WI"
	);
	check(
		"a PARTIAL target-raise sum is labelled with its contributing count",
		sponsors[0].target_raise_disclosed_only === 800_000 &&
			sponsors[0].target_raise_disclosed_count === 1
	);
	check(
		"a sponsor disclosing NO raise reports null, not 0",
		sponsors[1].target_raise_disclosed_only === null &&
			sponsors[1].target_raise_disclosed_count === 0
	);
	check(
		"every sponsor record names what is unavailable",
		sponsors.every(
			(s) =>
				s.not_available.includes("track_record") &&
				s.not_available.includes("realized_returns") &&
				s.not_available.includes("assets_under_management")
		)
	);
	check(
		"every sponsor record states its basis is not a track record",
		sponsors.every((s) => /NOT a track record/.test(s.basis))
	);
	check(
		"an empty set produces no sponsors and no unattributed",
		(() => {
			const r = rollUpSponsors([]);
			return r.sponsors.length === 0 && r.unattributed === 0;
		})()
	);

	check(
		"findSponsor resolves an exact id",
		findSponsor(set, "sp-2").status === "found" &&
			findSponsor(set, "sp-2").sponsor.offering_count === 1
	);
	check(
		"findSponsor resolves a unique name substring, case-insensitively",
		findSponsor(set, "beta").status === "found"
	);
	check(
		"findSponsor reports not_found rather than an empty record",
		findSponsor(set, "nobody").status === "not_found"
	);
	check(
		"a substring spanning two sponsors is AMBIGUOUS, never merged",
		(() => {
			const r = findSponsor(
				[
					bare({ id: "1", sponsor: { id: "sp-1", businessName: "Acme Capital" } }),
					bare({ id: "2", sponsor: { id: "sp-2", businessName: "Beta Capital" } }),
				],
				"capital"
			);
			return r.status === "ambiguous" && r.candidates.length === 2;
		})()
	);
	check(
		"an id match wins over a name match, so an exact id is never ambiguous",
		findSponsor(set, "sp-1").status === "found"
	);
}

process.exit(summary("screener unit") === 0 ? 0 : 1);
