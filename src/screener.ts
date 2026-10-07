/**
 * Screening, comparison and sponsor roll-up over the public offering set.
 *
 * Pure functions only: they take already-normalized `Offering` records and
 * return plain data. No fetching, no MCP types, no I/O — so every rule below is
 * unit-testable without a network or a spawned process, and the tool handlers
 * in `screenerTools.ts` stay thin.
 *
 * ── The one rule this file exists to enforce ──────────────────────────────
 * A screener that silently drops undisclosed values is a liar with a filter on.
 * If an agent asks for "cap rate above 6%" and an offering does not disclose a
 * cap rate, that offering is NOT a non-match — it is unknown, and the
 * difference matters to anyone deciding where to spend diligence. So:
 *
 *   - an offering dropped because a filtered field is `null` is returned in
 *     `excluded_not_disclosed`, named, with the field that was missing;
 *   - an offering dropped because the disclosed value failed the test is
 *     counted separately in `excluded_by_criteria`;
 *   - every response carries `field_coverage`: how many of the candidates
 *     disclose each numeric field at all. That is what turns "0 results" from a
 *     mystery into "0 of 7 offerings disclose this figure".
 *
 * Coverage is not decoration. As of 2026-08-26 the live public set is 7
 * offerings and every one of them returns `financials: {}` and `tokenomics:
 * {}`, so EVERY numeric field below is undisclosed platform-wide. A numeric
 * screen therefore matches nothing, and `field_coverage` is the only
 * thing that says why.
 *
 * ── Units are cited, not assumed ──────────────────────────────────────────
 * Because no live offering discloses any of these figures, the units cannot be
 * confirmed from data; they are taken from the platform's own committed
 * definitions (commertize.com @ 89614c3e):
 *   - `packages/data/src/entities/Listing.ts` — `derivedCapRate` is
 *     `noi / (purchasePrice ?? acquisitionCost)` and `year1CashOnCash` is
 *     `(noi - interestRate * loanAmount) / equityRequired`: both fractions.
 *   - `packages/data/src/schemas/property.ts` — `targetIRR`, `preferredReturn`,
 *     `targetCoCYear1` are validated `.min(0).max(1)` (fractions);
 *     `targetEquityMultiple` is `.min(1)` (a multiple, not a fraction);
 *     `holdPeriodYears` is `.int().min(1)` (years); `lockupMonths` is
 *     `.int().min(0)` (months).
 * Nothing here rescales anything. A fraction is reported as a fraction.
 */

import type { Offering } from "./normalize.js";

/* ------------------------------------------------------------------ */
/* numeric fields                                                      */
/* ------------------------------------------------------------------ */

export type FieldUnit =
	| "fraction"
	| "multiple"
	| "usd"
	| "tokens"
	| "months"
	| "years";

/**
 * Where a number came from, because it changes how much weight it carries:
 *   "disclosed"  — the sponsor stated it.
 *   "derived"    — arithmetic over disclosed inputs, by the platform or here.
 *   "projection" — forward-looking sponsor estimate. Not a statement of fact.
 */
export type FieldKind = "disclosed" | "derived" | "projection";

export interface NumericFieldSpec {
	readonly id: string;
	/** Where it lives in an offering record, for a reader tracing a number. */
	readonly path: string;
	readonly unit: FieldUnit;
	readonly kind: FieldKind;
	readonly note: string;
	readonly read: (offering: Offering) => number | null;
}

export const NUMERIC_FIELDS: readonly NumericFieldSpec[] = [
	{
		id: "cap_rate",
		path: "derived.cap_rate",
		unit: "fraction",
		kind: "derived",
		note: "NOI / (purchase price or acquisition cost). 0.055 = 5.5%. Platform-derived, not a sponsor disclosure in its own right.",
		read: (o) => o.derived.cap_rate,
	},
	{
		id: "year_1_cash_on_cash",
		path: "projections.year_1_cash_on_cash",
		unit: "fraction",
		kind: "derived",
		note: "(NOI - interest-only debt service) / equity required. A fraction. Platform-derived from disclosed financials.",
		read: (o) => o.projections.year_1_cash_on_cash,
	},
	{
		id: "target_irr",
		path: "projections.target_irr",
		unit: "fraction",
		kind: "projection",
		note: "Sponsor's target IRR, a fraction between 0 and 1. Forward-looking estimate.",
		read: (o) => o.projections.target_irr,
	},
	{
		id: "target_equity_multiple",
		path: "projections.target_equity_multiple",
		unit: "multiple",
		kind: "projection",
		note: "Sponsor's target equity multiple, at least 1. A multiple, NOT a fraction.",
		read: (o) => o.projections.target_equity_multiple,
	},
	{
		id: "preferred_rate",
		path: "projections.preferred_rate",
		unit: "fraction",
		kind: "projection",
		note: "Preferred return, a fraction between 0 and 1.",
		read: (o) => o.projections.preferred_rate,
	},
	{
		id: "hold_period_years",
		path: "projections.hold_period_years",
		unit: "years",
		kind: "projection",
		note: "Sponsor's intended hold, in whole years.",
		read: (o) => o.projections.hold_period_years,
	},
	{
		id: "lockup_months",
		path: "tokenomics.lockup_months",
		unit: "months",
		kind: "disclosed",
		note: "Token lockup, in months. 0 is a disclosed zero; null is no disclosure.",
		read: (o) => o.tokenomics.lockup_months,
	},
	{
		id: "token_price",
		path: "tokenomics.token_price",
		unit: "usd",
		kind: "disclosed",
		note: "Price per token as disclosed by the sponsor.",
		read: (o) => o.tokenomics.token_price,
	},
	{
		id: "tokens_for_investors",
		path: "tokenomics.tokens_for_investors",
		unit: "tokens",
		kind: "disclosed",
		note: "Token count allocated to investors.",
		read: (o) => o.tokenomics.tokens_for_investors,
	},
	{
		id: "target_raise",
		path: "derived.target_raise",
		unit: "usd",
		kind: "derived",
		note: "tokens_for_investors x token_price. Offering size. Null if either input is undisclosed.",
		read: (o) => o.derived.target_raise,
	},
	{
		id: "min_investment_amount",
		path: "derived.min_investment_amount",
		unit: "usd",
		kind: "derived",
		note: "min_investment_tokens x token_price. Minimum ticket. Null if either input is undisclosed.",
		read: (o) => o.derived.min_investment_amount,
	},
	{
		id: "implied_equity_valuation",
		path: "derived.implied_equity_valuation",
		unit: "usd",
		kind: "derived",
		note: "Platform-computed implied equity valuation.",
		read: (o) => o.derived.implied_equity_valuation,
	},
	{
		id: "effective_appraisal_value",
		path: "derived.effective_appraisal_value",
		unit: "usd",
		kind: "derived",
		note: "Current appraisal where disclosed, otherwise acquisition cost.",
		read: (o) => o.derived.effective_appraisal_value,
	},
	{
		id: "spv_leverage_ratio",
		path: "spv_leverage.ratio",
		unit: "fraction",
		kind: "disclosed",
		note: "SPV debt / asset value. Null means the sponsor disclosed no SPV debt figure — it does NOT mean zero leverage.",
		read: (o) => o.spv_leverage?.ratio ?? null,
	},
] as const;

const FIELD_BY_ID = new Map(NUMERIC_FIELDS.map((f) => [f.id, f]));

export const numericFieldIds = (): string[] => NUMERIC_FIELDS.map((f) => f.id);

export const numericField = (id: string): NumericFieldSpec | undefined =>
	// Map#get, not a plain object: an object lookup would resolve "constructor".
	FIELD_BY_ID.get(id);

export const readNumeric = (offering: Offering, id: string): number | null =>
	numericField(id)?.read(offering) ?? null;

/** The public field catalogue, for the tool that has to describe itself. */
export const fieldCatalogue = () =>
	NUMERIC_FIELDS.map(({ id, path, unit, kind, note }) => ({
		field: id,
		path,
		unit,
		kind,
		note,
	}));

/* ------------------------------------------------------------------ */
/* coverage                                                            */
/* ------------------------------------------------------------------ */

export interface FieldCoverage {
	field: string;
	unit: FieldUnit;
	kind: FieldKind;
	disclosed: number;
	total: number;
	/**
	 * disclosed / total, or null when total is 0.
	 *
	 * Null rather than 0: "none of zero offerings disclose this" is not the
	 * same fact as "none of seven do", and a 0 here would read as the latter.
	 */
	coverage: number | null;
}

export const fieldCoverage = (offerings: readonly Offering[]): FieldCoverage[] =>
	NUMERIC_FIELDS.map((spec) => {
		const disclosed = offerings.filter((o) => spec.read(o) !== null).length;
		return {
			field: spec.id,
			unit: spec.unit,
			kind: spec.kind,
			disclosed,
			total: offerings.length,
			coverage: offerings.length === 0 ? null : disclosed / offerings.length,
		};
	});

/* ------------------------------------------------------------------ */
/* screening                                                           */
/* ------------------------------------------------------------------ */

export interface RangeFilter {
	field: string;
	min: number | null;
	max: number | null;
}

export interface ScreenCriteria {
	query?: string | null;
	status?: string | null;
	asset_class?: string | null;
	state?: string | null;
	city?: string | null;
	exemption?: string | null;
	/** Sponsor id (exact) or a case-insensitive substring of the sponsor name. */
	sponsor?: string | null;
	accepting_investment?: boolean | null;
	ranges?: readonly RangeFilter[];
	sort_by?: string | null;
	order?: "asc" | "desc";
	limit?: number | null;
}

export interface UndisclosedExclusion {
	id: string | null;
	name: string | null;
	/** Every filtered field this offering did not disclose, not just the first. */
	missing_fields: string[];
}

export interface ScreenResult {
	matched: Offering[];
	/** Size of the public set handed in, before any filter. */
	total_available: number;
	/** Survivors of the categorical filters, before numeric ranges. */
	candidates: number;
	/** Dropped because a DISCLOSED value failed a range test. */
	excluded_by_criteria: number;
	/** Dropped because a filtered field was undisclosed. Never silent. */
	excluded_not_disclosed: UndisclosedExclusion[];
	/** Coverage over the candidates, i.e. after categorical filters. */
	field_coverage: FieldCoverage[];
	/** Range filters naming a field this server does not know. */
	unknown_fields: string[];
	sorted_by: string | null;
	sort_order: "asc" | "desc";
	/** True when `limit` cut the result short. */
	truncated: boolean;
}

const lower = (v: string | null | undefined): string => (v ?? "").toLowerCase();

const matchesQuery = (offering: Offering, query: string): boolean => {
	const haystack = [
		offering.name,
		offering.location.city,
		offering.location.state,
		offering.sponsor.name,
		offering.asset_class.code,
		offering.asset_class.label,
	]
		.map(lower)
		.join(" ");
	return haystack.includes(query.toLowerCase());
};

const matchesSponsor = (offering: Offering, want: string): boolean =>
	offering.sponsor.id === want ||
	(offering.sponsor.name !== null &&
		lower(offering.sponsor.name).includes(want.toLowerCase()));

/**
 * Compare two possibly-null numbers with nulls sorted LAST in both directions.
 *
 * Deliberately not "nulls are -Infinity": an undisclosed figure is not a small
 * figure, and a descending sort that put undisclosed offerings at the bottom
 * while an ascending one put them at the top would be two different lies.
 */
const compareNullable = (
	a: number | null,
	b: number | null,
	order: "asc" | "desc"
): number => {
	if (a === null && b === null) return 0;
	if (a === null) return 1;
	if (b === null) return -1;
	return order === "asc" ? a - b : b - a;
};

export const screenOfferings = (
	offerings: readonly Offering[],
	criteria: ScreenCriteria
): ScreenResult => {
	const total = offerings.length;

	/* --- categorical --------------------------------------------------- */
	let candidates = [...offerings];
	if (criteria.status) {
		const want = criteria.status.toUpperCase();
		candidates = candidates.filter(
			(o) => (o.status.code ?? "").toUpperCase() === want
		);
	}
	if (criteria.asset_class) {
		const want = criteria.asset_class.toUpperCase();
		candidates = candidates.filter(
			(o) => (o.asset_class.code ?? "").toUpperCase() === want
		);
	}
	if (criteria.state) {
		const want = criteria.state.toUpperCase();
		candidates = candidates.filter(
			(o) => (o.location.state ?? "").toUpperCase() === want
		);
	}
	if (criteria.city) {
		// Substring, not equality: the live set contains "Fond du Lac / De Pere",
		// a two-town listing that an equality match on "De Pere" would miss.
		const want = criteria.city.toLowerCase();
		candidates = candidates.filter((o) => lower(o.location.city).includes(want));
	}
	if (criteria.exemption) {
		const want = criteria.exemption.toUpperCase();
		candidates = candidates.filter(
			(o) => (o.offering.exemption_code ?? "").toUpperCase() === want
		);
	}
	if (criteria.sponsor) {
		const want = criteria.sponsor;
		candidates = candidates.filter((o) => matchesSponsor(o, want));
	}
	if (criteria.accepting_investment !== null && criteria.accepting_investment !== undefined) {
		const want = criteria.accepting_investment;
		candidates = candidates.filter(
			(o) => o.status.accepting_investment === want
		);
	}
	if (criteria.query) {
		const q = criteria.query;
		candidates = candidates.filter((o) => matchesQuery(o, q));
	}

	/* --- numeric ranges ------------------------------------------------- */
	const rawRanges = criteria.ranges ?? [];
	const unknownFields = rawRanges
		.map((r) => r.field)
		.filter((f) => numericField(f) === undefined);
	/*
	 * An unknown field is reported and IGNORED rather than silently matching
	 * nothing. Both choices are defensible; this one is chosen because the
	 * alternative ("unknown field matches nothing") returns an empty list that
	 * looks exactly like a real screen with no hits, and an agent cannot tell
	 * a typo from a market fact. `unknown_fields` is in the response.
	 */
	const ranges = rawRanges.filter((r) => numericField(r.field) !== undefined);

	const excludedNotDisclosed: UndisclosedExclusion[] = [];
	let excludedByCriteria = 0;
	const matched: Offering[] = [];

	for (const offering of candidates) {
		const missing: string[] = [];
		let failed = false;
		for (const range of ranges) {
			const value = readNumeric(offering, range.field);
			if (value === null) {
				missing.push(range.field);
				continue;
			}
			if (range.min !== null && value < range.min) failed = true;
			if (range.max !== null && value > range.max) failed = true;
		}
		if (missing.length > 0) {
			excludedNotDisclosed.push({
				id: offering.id,
				name: offering.name,
				missing_fields: missing,
			});
			continue;
		}
		if (failed) {
			excludedByCriteria += 1;
			continue;
		}
		matched.push(offering);
	}

	/* --- sort + limit --------------------------------------------------- */
	const order: "asc" | "desc" = criteria.order ?? "desc";
	const sortBy =
		criteria.sort_by && numericField(criteria.sort_by) ? criteria.sort_by : null;
	if (sortBy) {
		matched.sort((a, b) =>
			compareNullable(readNumeric(a, sortBy), readNumeric(b, sortBy), order)
		);
	}
	if (criteria.sort_by && !sortBy) unknownFields.push(criteria.sort_by);

	const limit = criteria.limit ?? null;
	const truncated = limit !== null && matched.length > limit;
	const page = limit !== null ? matched.slice(0, limit) : matched;

	return {
		matched: page,
		total_available: total,
		candidates: candidates.length,
		excluded_by_criteria: excludedByCriteria,
		excluded_not_disclosed: excludedNotDisclosed,
		field_coverage: fieldCoverage(candidates),
		unknown_fields: [...new Set(unknownFields)],
		sorted_by: sortBy,
		sort_order: order,
		truncated,
	};
};

/* ------------------------------------------------------------------ */
/* comparison                                                          */
/* ------------------------------------------------------------------ */

export type CompareValue = string | number | boolean | null;

interface CompareFieldSpec {
	readonly field: string;
	readonly unit: FieldUnit | null;
	readonly kind: FieldKind | "categorical";
	readonly read: (offering: Offering) => CompareValue;
}

const CATEGORICAL_COMPARE: readonly CompareFieldSpec[] = [
	{ field: "name", unit: null, kind: "categorical", read: (o) => o.name },
	{
		field: "asset_class",
		unit: null,
		kind: "categorical",
		read: (o) => o.asset_class.code,
	},
	{
		field: "city",
		unit: null,
		kind: "categorical",
		read: (o) => o.location.city,
	},
	{
		field: "state",
		unit: null,
		kind: "categorical",
		read: (o) => o.location.state,
	},
	{
		field: "status",
		unit: null,
		kind: "categorical",
		read: (o) => o.status.code,
	},
	{
		field: "accepting_investment",
		unit: null,
		kind: "categorical",
		read: (o) => o.status.accepting_investment,
	},
	{
		field: "exemption",
		unit: null,
		kind: "categorical",
		read: (o) => o.offering.exemption_code,
	},
	{
		field: "sponsor",
		unit: null,
		kind: "categorical",
		read: (o) => o.sponsor.name,
	},
	{
		field: "distribution_frequency",
		unit: null,
		kind: "categorical",
		read: (o) => o.projections.distribution_frequency,
	},
] as const;

const COMPARE_FIELDS: readonly CompareFieldSpec[] = [
	...CATEGORICAL_COMPARE,
	...NUMERIC_FIELDS.map(
		(spec): CompareFieldSpec => ({
			field: spec.id,
			unit: spec.unit,
			kind: spec.kind,
			read: (o) => spec.read(o),
		})
	),
];

export interface ComparisonRow {
	field: string;
	unit: FieldUnit | null;
	kind: FieldKind | "categorical";
	/** One entry per requested offering, in request order. */
	values: CompareValue[];
	/** How many of the compared offerings disclose this field at all. */
	disclosed_by: number;
	/**
	 * True only when every offering discloses the field AND the values agree.
	 * Two nulls are not agreement — they are two absences.
	 */
	identical: boolean;
	/** True when at least one offering discloses it and at least one does not. */
	partially_disclosed: boolean;
}

export interface ComparisonResult {
	offering_ids: string[];
	offering_names: (string | null)[];
	rows: ComparisonRow[];
	/** Fields no compared offering discloses. The shape of the data gap. */
	undisclosed_by_all: string[];
	/** Fields every compared offering discloses and on which they differ. */
	differing_fields: string[];
}

export const compareOfferings = (
	offerings: readonly Offering[]
): ComparisonResult => {
	const rows: ComparisonRow[] = COMPARE_FIELDS.map((spec) => {
		const values = offerings.map((o) => spec.read(o));
		const disclosedBy = values.filter((v) => v !== null).length;
		const identical =
			offerings.length > 0 &&
			disclosedBy === offerings.length &&
			values.every((v) => v === values[0]);
		return {
			field: spec.field,
			unit: spec.unit,
			kind: spec.kind,
			values,
			disclosed_by: disclosedBy,
			identical,
			partially_disclosed: disclosedBy > 0 && disclosedBy < offerings.length,
		};
	});

	/*
	 * Both summary lists are empty for an empty input, and neither is derived
	 * by a bare equality against `offerings.length`.
	 *
	 * With zero offerings every row has `disclosed_by === 0 === offerings.length`,
	 * so an unguarded `disclosed_by === offerings.length && !identical` puts
	 * EVERY field into `differing_fields` — a comparison of nothing reporting
	 * that everything disagrees. The unit suite caught exactly that. Vacuous
	 * truth reads as a claim in a payload an agent will quote, so both lists
	 * make no statement when there was nothing to compare.
	 */
	const compared = offerings.length > 0;

	return {
		offering_ids: offerings.map((o) => o.id ?? ""),
		offering_names: offerings.map((o) => o.name),
		rows,
		undisclosed_by_all: compared
			? rows.filter((r) => r.disclosed_by === 0).map((r) => r.field)
			: [],
		differing_fields: compared
			? rows
					.filter((r) => r.disclosed_by === offerings.length && !r.identical)
					.map((r) => r.field)
			: [],
	};
};

/* ------------------------------------------------------------------ */
/* sponsors                                                            */
/* ------------------------------------------------------------------ */

/**
 * What this server CANNOT tell you about a sponsor, named in every response.
 *
 * `GET /api/sponsor` is authenticated, so the only sponsor data reachable here
 * is the `{ id, businessName }` stub embedded in each public listing. Everything
 * below would be a fabrication if this server produced it, and an agent asked to
 * "check the sponsor's track record" needs to be told that in the payload rather
 * than left to infer it from an absence.
 */
export const SPONSOR_NOT_AVAILABLE: readonly string[] = [
	"track_record",
	"prior_deals",
	"realized_returns",
	"assets_under_management",
	"principals",
	"years_in_business",
	"sponsor_verification_status",
	"contact_details",
] as const;

export const SPONSOR_BASIS =
	"Assembled from the sponsor stub embedded in Commertize's public listing set " +
	"({ id, businessName }) and from that sponsor's offerings on this platform. " +
	"It is an inventory of what they have listed here — NOT a track record, and " +
	"not evidence of performance. No prior-deal, realized-return or AUM data is " +
	"available through any public Commertize endpoint.";

export interface SponsorOfferingRef {
	id: string | null;
	name: string | null;
	status: string | null;
	asset_class: string | null;
	city: string | null;
	state: string | null;
}

export interface SponsorSummary {
	sponsor_id: string | null;
	sponsor_name: string | null;
	offering_count: number;
	offerings: SponsorOfferingRef[];
	by_status: { code: string; count: number }[];
	by_asset_class: { code: string; count: number }[];
	states: string[];
	/**
	 * Sum of `derived.target_raise` over ONLY those offerings that disclose one,
	 * with the contributing count beside it. Named "disclosed_only" because a
	 * partial sum presented as a total understates by an unknown amount, and
	 * null when nothing is disclosed — never 0.
	 */
	target_raise_disclosed_only: number | null;
	target_raise_disclosed_count: number;
	not_available: string[];
	basis: string;
}

const tally = (values: (string | null)[]): { code: string; count: number }[] => {
	const counts = new Map<string, number>();
	for (const v of values) {
		if (v === null) continue;
		counts.set(v, (counts.get(v) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([code, count]) => ({ code, count }))
		.sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
};

const summarize = (
	sponsorId: string | null,
	sponsorName: string | null,
	offerings: readonly Offering[]
): SponsorSummary => {
	const raises = offerings
		.map((o) => o.derived.target_raise)
		.filter((v): v is number => v !== null);
	return {
		sponsor_id: sponsorId,
		sponsor_name: sponsorName,
		offering_count: offerings.length,
		offerings: offerings.map((o) => ({
			id: o.id,
			name: o.name,
			status: o.status.code,
			asset_class: o.asset_class.code,
			city: o.location.city,
			state: o.location.state,
		})),
		by_status: tally(offerings.map((o) => o.status.code)),
		by_asset_class: tally(offerings.map((o) => o.asset_class.code)),
		states: [
			...new Set(
				offerings
					.map((o) => o.location.state)
					.filter((s): s is string => s !== null)
			),
		].sort(),
		target_raise_disclosed_only:
			raises.length === 0 ? null : raises.reduce((a, b) => a + b, 0),
		target_raise_disclosed_count: raises.length,
		not_available: [...SPONSOR_NOT_AVAILABLE],
		basis: SPONSOR_BASIS,
	};
};

/**
 * Group the public set by sponsor.
 *
 * Grouping key is the sponsor id. Offerings whose sponsor stub carries neither
 * an id nor a name are collected into `unattributed` and counted rather than
 * folded into some "(unknown)" pseudo-sponsor — inventing a sponsor record is
 * exactly the thing this module refuses to do.
 */
export const rollUpSponsors = (
	offerings: readonly Offering[]
): { sponsors: SponsorSummary[]; unattributed: number } => {
	const groups = new Map<string, Offering[]>();
	let unattributed = 0;

	for (const offering of offerings) {
		const key = offering.sponsor.id ?? offering.sponsor.name;
		if (key === null) {
			unattributed += 1;
			continue;
		}
		const bucket = groups.get(key);
		if (bucket) bucket.push(offering);
		else groups.set(key, [offering]);
	}

	const sponsors = [...groups.values()]
		.map((group) => {
			const first = group[0];
			return summarize(
				first?.sponsor.id ?? null,
				first?.sponsor.name ?? null,
				group
			);
		})
		.sort(
			(a, b) =>
				b.offering_count - a.offering_count ||
				(a.sponsor_name ?? "").localeCompare(b.sponsor_name ?? "")
		);

	return { sponsors, unattributed };
};

export type SponsorLookup =
	| { status: "found"; sponsor: SponsorSummary }
	| { status: "not_found" }
	/** A name substring that spans more than one sponsor. */
	| { status: "ambiguous"; candidates: { id: string | null; name: string | null }[] };

/**
 * One sponsor by id (exact) or by case-insensitive name substring.
 *
 * The three outcomes are distinct on purpose. "Not found" and "your substring
 * matched two sponsors" are different problems with different fixes, and
 * collapsing them into one null would have the handler tell an agent the
 * sponsor does not exist when in fact it exists twice. Merging the matches into
 * one record is the outcome this refuses outright: it would invent a sponsor.
 */
export const findSponsor = (
	offerings: readonly Offering[],
	needle: string
): SponsorLookup => {
	const byId = offerings.filter((o) => o.sponsor.id === needle);
	if (byId.length > 0) {
		const first = byId[0];
		return {
			status: "found",
			sponsor: summarize(
				first?.sponsor.id ?? null,
				first?.sponsor.name ?? null,
				byId
			),
		};
	}

	const want = needle.toLowerCase();
	const byName = offerings.filter(
		(o) => o.sponsor.name !== null && lower(o.sponsor.name).includes(want)
	);
	if (byName.length === 0) return { status: "not_found" };

	const distinct = new Map(
		byName.map((o) => [
			o.sponsor.id ?? o.sponsor.name ?? "",
			{ id: o.sponsor.id, name: o.sponsor.name },
		])
	);
	if (distinct.size > 1) {
		return { status: "ambiguous", candidates: [...distinct.values()] };
	}
	const first = byName[0];
	return {
		status: "found",
		sponsor: summarize(
			first?.sponsor.id ?? null,
			first?.sponsor.name ?? null,
			byName
		),
	};
};
