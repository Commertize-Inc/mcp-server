/**
 * Typed output schemas. Every tool declares one, so an MCP client can rely on
 * the shape instead of parsing prose, and the SDK validates our own output on
 * the way out (a shape drift here fails loudly rather than silently).
 */

import { z } from "zod";

/** Present on every response, success or failure. */
export const envelopeShape = {
	as_of: z
		.string()
		.describe(
			"ISO-8601 timestamp of when the underlying data was fetched from the API — not when this call was made. Older than a few seconds means it was served from cache."
		),
	source_url: z
		.string()
		.describe("The upstream public API URL this response was derived from."),
	cache: z
		.object({
			hit: z.boolean().describe("Served from this server's cache."),
			age_seconds: z.number().describe("Age of the served body in seconds."),
			stale: z
				.boolean()
				.describe(
					"True when the API could not be reached and a previously cached body was served instead. Treat the data as possibly out of date."
				),
		})
		.describe("Cache metadata for this response."),
	disclaimer: z
		.string()
		.describe("Standing disclaimer. Carry it into anything you report to a user."),
	error: z
		.object({
			code: z.string(),
			message: z.string(),
			retryable: z
				.boolean()
				.describe("True if retrying the same call later may succeed."),
		})
		.nullable()
		.describe("Null on success. Populated when the call failed."),
};

const nullableNumber = () => z.number().nullable();

export const offeringSchema = z.object({
	id: z.string().nullable(),
	name: z.string().nullable(),
	asset_class: z.object({
		code: z.string().nullable(),
		label: z.string().nullable(),
	}),
	location: z.object({
		city: z.string().nullable(),
		state: z.string().nullable(),
		street_address: z
			.null()
			.describe("Always null: street address is not public data."),
	}),
	status: z.object({
		code: z.string().nullable(),
		label: z.string().nullable(),
		accepting_investment: z
			.boolean()
			.describe(
				"True only for ACTIVE offerings. Any other status is closed to new subscriptions."
			),
	}),
	offering: z.object({
		exemption_code: z.string().nullable(),
		exemption_label: z.string().nullable(),
		note: z
			.string()
			.nullable()
			.describe("Exemption-specific caveat, when one applies."),
	}),
	sponsor: z.object({
		id: z.string().nullable(),
		name: z.string().nullable(),
	}),
	tokenomics: z
		.object({
			token_price: nullableNumber(),
			total_token_supply: nullableNumber(),
			tokens_for_investors: nullableNumber(),
			tokens_for_sponsor: nullableNumber(),
			tokens_for_treasury: nullableNumber(),
			min_investment_tokens: nullableNumber(),
			max_investment_tokens: nullableNumber().describe(
				"Null means no disclosed per-investor cap."
			),
			lockup_months: nullableNumber(),
		})
		.describe("As disclosed by the sponsor. Null means not disclosed."),
	derived: z
		.object({
			target_raise: nullableNumber().describe(
				"tokens_for_investors x token_price. Null if either input is undisclosed."
			),
			min_investment_amount: nullableNumber().describe(
				"min_investment_tokens x token_price. Null if either input is undisclosed."
			),
			implied_equity_valuation: nullableNumber(),
			effective_appraisal_value: nullableNumber(),
			cap_rate: nullableNumber().describe("Decimal fraction, e.g. 0.055 = 5.5%."),
		})
		.describe(
			"Computed from disclosed inputs by the platform or this server. Not sponsor disclosures in their own right."
		),
	spv_leverage: z
		.object({
			ratio: z.number().describe("debt_amount / asset_value, unrounded."),
			ratio_display: z.string(),
			debt_amount: z.number(),
			asset_value: z.number(),
			basis: z.enum(["APPRAISAL", "PURCHASE_PRICE", "ACQUISITION_COST"]),
			basis_label: z.string(),
		})
		.nullable()
		.describe(
			"Null means the sponsor has not disclosed SPV debt. Null is NOT zero leverage."
		),
	spv_leverage_display: z
		.string()
		.describe('Formatted ratio, or "Not disclosed".'),
	projections: z
		.object({
			note: z.string(),
			year_1_cash_on_cash: nullableNumber(),
			target_irr: nullableNumber(),
			target_equity_multiple: nullableNumber(),
			preferred_rate: nullableNumber(),
			hold_period_years: nullableNumber(),
			distribution_frequency: z.string().nullable(),
		})
		.describe(
			"Forward-looking figures supplied by the sponsor. Estimates, not statements of fact."
		),
	images: z.array(z.string()),
	links: z.object({
		api_url: z.string(),
		detail_page: z.string().nullable(),
		detail_page_requires_sign_in: z.boolean(),
	}),
	not_disclosed: z
		.array(z.string())
		.describe("Names of every field above that came back null."),
});

export const articleSummarySchema = z.object({
	slug: z.string().nullable(),
	title: z.string().nullable(),
	summary: z.string().nullable(),
	category: z.string().nullable(),
	tags: z.array(z.string()),
	published_at: z.string().nullable(),
	read_time_minutes: z.number().nullable(),
	image_url: z.string().nullable(),
	url: z.string().nullable(),
});

export const articleFullSchema = articleSummarySchema.extend({
	content_text: z
		.string()
		.nullable()
		.describe("Article body as plain text, with markup and embedded metadata removed."),
});

/* ------------------------------------------------------------------ */
/* screening / comparison / sponsors                                   */
/* ------------------------------------------------------------------ */

const fieldUnitSchema = z.enum([
	"fraction",
	"multiple",
	"usd",
	"tokens",
	"months",
	"years",
]);

const fieldKindSchema = z.enum(["disclosed", "derived", "projection"]);

/**
 * How much of the candidate set discloses a given figure at all.
 *
 * The load-bearing part of a screener response when the platform's numeric
 * disclosure is sparse: it is the difference between "nothing matched your
 * criteria" and "nothing on this platform publishes this number".
 */
export const fieldCoverageSchema = z.object({
	field: z.string(),
	unit: fieldUnitSchema,
	kind: fieldKindSchema,
	disclosed: z
		.number()
		.describe("Candidates disclosing a non-null value for this field."),
	total: z.number().describe("Candidates considered."),
	coverage: z
		.number()
		.nullable()
		.describe("disclosed / total. Null when total is 0 — never 0."),
});

export const undisclosedExclusionSchema = z.object({
	id: z.string().nullable(),
	name: z.string().nullable(),
	missing_fields: z
		.array(z.string())
		.describe(
			"Filtered fields this offering does not disclose. It was excluded as UNKNOWN, not as a non-match."
		),
});

export const comparisonRowSchema = z.object({
	field: z.string(),
	unit: fieldUnitSchema.nullable(),
	kind: z.enum(["disclosed", "derived", "projection", "categorical"]),
	values: z
		.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
		.describe("One value per compared offering, in the order requested."),
	disclosed_by: z.number(),
	identical: z
		.boolean()
		.describe(
			"True only when every offering discloses the field and the values agree. Two nulls are two absences, not agreement."
		),
	partially_disclosed: z.boolean(),
});

export const sponsorSummarySchema = z.object({
	sponsor_id: z.string().nullable(),
	sponsor_name: z.string().nullable(),
	offering_count: z.number(),
	offerings: z.array(
		z.object({
			id: z.string().nullable(),
			name: z.string().nullable(),
			status: z.string().nullable(),
			asset_class: z.string().nullable(),
			city: z.string().nullable(),
			state: z.string().nullable(),
		})
	),
	by_status: z.array(z.object({ code: z.string(), count: z.number() })),
	by_asset_class: z.array(z.object({ code: z.string(), count: z.number() })),
	states: z.array(z.string()),
	target_raise_disclosed_only: z
		.number()
		.nullable()
		.describe(
			"Sum of target_raise over ONLY the offerings that disclose one. Not a total. Null when none disclose it."
		),
	target_raise_disclosed_count: z.number(),
	not_available: z
		.array(z.string())
		.describe(
			"Sponsor facts NO public Commertize endpoint exposes. This server does not have them and will not estimate them."
		),
	basis: z
		.string()
		.describe("What this record is assembled from, and what it is not."),
});

