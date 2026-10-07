/**
 * Screening tools: the four read-only tools that turn a list endpoint into
 * something an agent can actually screen with.
 *
 *   search_offerings   filter + sort the public set on real criteria
 *   compare_offerings  align 2-5 offerings field by field
 *   list_sponsors      who is sponsoring on this platform
 *   get_sponsor        one sponsor's Commertize inventory (NOT a track record)
 *
 * ── Same data, same gate, no new surface ─────────────────────────────────
 * Every one of these reads `GET /api/listings` and nothing else — the same
 * public, unauthenticated endpoint `list_offerings` reads, through the same
 * cached `getJson` helper, so four new tools cost zero extra upstream requests
 * inside the cache TTL. They therefore sit behind the SAME offerings gate:
 * `config.offeringsDisabled` closes all four exactly as it closes
 * `list_offerings` / `get_offering`. Sponsor data is listing data; it does not
 * get its own, looser gate because it is aggregated.
 *
 * ── What is NOT here, and why ────────────────────────────────────────────
 * Deliberate omissions, so nobody has to guess whether they were forgotten:
 *   - sponsor track record / prior deals / realized returns / AUM: `/api/sponsor`
 *     is authenticated. The only public sponsor data is `{ id, businessName }`
 *     embedded in each listing. `SPONSOR_NOT_AVAILABLE` names every one of
 *     these in every response rather than leaving an agent to infer it.
 *   - market statistics over time: `/api/stats/platform` is a point-in-time
 *     snapshot with no history endpoint and no `as_of` parameter. A trend tool
 *     would have to either store snapshots (state this server does not have) or
 *     fabricate a series. Neither ships.
 *   - funding progress, subscriber counts, escrow state, documents, street
 *     address: authenticated fields, absent from the public listing payload.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { config } from "./config.js";
import { fail, ok, offeringGateClosed, refuse } from "./envelope.js";
import { getJson } from "./http.js";
import { normalizeOffering, type Offering, type RawListing } from "./normalize.js";
import {
	compareOfferings,
	fieldCatalogue,
	fieldCoverage,
	findSponsor,
	numericFieldIds,
	rollUpSponsors,
	screenOfferings,
	SPONSOR_BASIS,
	type RangeFilter,
} from "./screener.js";
import {
	comparisonRowSchema,
	envelopeShape,
	fieldCoverageSchema,
	offeringSchema,
	sponsorSummarySchema,
	undisclosedExclusionSchema,
} from "./schemas.js";

/**
 * The tools this module registers, as data.
 *
 * `platform_info` publishes a machine-readable list of this server's surface
 * and a live test asserts that list against `tools/list`. Exported here so
 * `tools.ts` can spread it rather than retyping four names that would then be
 * free to drift — the failure mode being a customer-facing tool that
 * under-reports what the server can do.
 */
export const SCREENER_TOOL_NAMES = [
	"search_offerings",
	"compare_offerings",
	"list_sponsors",
	"get_sponsor",
] as const;

const LISTINGS_PATH = "/api/listings";
const listingsUrl = () => `${config.apiBaseUrl}${LISTINGS_PATH}`;

/** One fetch of the public set, normalized. Shared by all four tools. */
const fetchOfferings = async () => {
	const res = await getJson<RawListing[]>(LISTINGS_PATH);
	const raw = Array.isArray(res.body) ? res.body : [];
	return { res, offerings: raw.map(normalizeOffering) as Offering[] };
};

/**
 * A range filter arrives as two optional numbers per field. Building the list
 * here — rather than accepting a caller-shaped array of objects — keeps the
 * input schema flat and self-documenting for a model, which is measurably
 * better at `min_cap_rate: 0.06` than at `[{field, min, max}]`.
 */
const rangesFrom = (
	args: Record<string, unknown>
): { ranges: RangeFilter[]; requested: string[] } => {
	const ranges: RangeFilter[] = [];
	const requested: string[] = [];
	for (const field of numericFieldIds()) {
		const min = args[`min_${field}`];
		const max = args[`max_${field}`];
		const hasMin = typeof min === "number";
		const hasMax = typeof max === "number";
		if (!hasMin && !hasMax) continue;
		ranges.push({
			field,
			min: hasMin ? (min as number) : null,
			max: hasMax ? (max as number) : null,
		});
		requested.push(field);
	}
	return { ranges, requested };
};

/**
 * The subset of numeric fields exposed as `min_*` / `max_*` arguments.
 *
 * Not all fourteen: an input schema with twenty-eight numeric arguments is
 * worse for a model than one with the eight that a screener actually reasons
 * about, and every field remains reachable through `sort_by` plus the
 * `field_coverage` block. The list is derived, not retyped, so a new numeric
 * field cannot silently fail to appear here.
 */
const RANGE_ARG_FIELDS = [
	"cap_rate",
	"year_1_cash_on_cash",
	"target_irr",
	"target_equity_multiple",
	"hold_period_years",
	"lockup_months",
	"target_raise",
	"min_investment_amount",
	"spv_leverage_ratio",
] as const;

const rangeArgShape = (): Record<string, z.ZodTypeAny> => {
	const shape: Record<string, z.ZodTypeAny> = {};
	for (const field of RANGE_ARG_FIELDS) {
		// Guard against a rename in screener.ts silently dropping an argument.
		if (!numericFieldIds().includes(field)) {
			throw new Error(
				`range argument "${field}" is not a known numeric field — screener.ts and screenerTools.ts have drifted`
			);
		}
		shape[`min_${field}`] = z
			.number()
			.optional()
			.describe(`Minimum ${field}, inclusive. Undisclosed values never match.`);
		shape[`max_${field}`] = z
			.number()
			.optional()
			.describe(`Maximum ${field}, inclusive. Undisclosed values never match.`);
	}
	return shape;
};

export const registerScreenerTools = (server: McpServer): void => {
	/* ---------------------------------------------------------- */
	/* search_offerings                                            */
	/* ---------------------------------------------------------- */
	server.registerTool(
		"search_offerings",
		{
			title: "Screen Commertize offerings by criteria",
			description:
				"Screen the public Commertize offering set: free-text search plus asset class, geography, status and exemption filters, plus inclusive min/max ranges on cap rate, year-1 cash-on-cash, target IRR, equity multiple, hold period, lockup, offering size, minimum ticket and SPV leverage, with sorting on any numeric field. Rates are DECIMAL FRACTIONS (0.06 = 6%). Undisclosed values never match a range filter and are returned in `excluded_not_disclosed` rather than silently dropped; `field_coverage` reports how many candidates disclose each figure at all, so an empty result is explainable. Public data only, filters narrow the public set and never widen it. Informational reference data — not an offer, solicitation, or recommendation.",
			inputSchema: {
				query: z
					.string()
					.optional()
					.describe(
						"Case-insensitive substring over name, city, state, sponsor name and asset class. Applied locally to the fetched public set — not a search index."
					),
				status: z
					.enum(["ACTIVE", "FULLY_FUNDED", "TOKENIZING"])
					.optional()
					.describe("The public set only ever contains these three statuses."),
				asset_class: z
					.string()
					.optional()
					.describe(
						'Asset class code, e.g. "MULTIFAMILY", "HOSPITALITY". Exact, case-insensitive.'
					),
				state: z
					.string()
					.optional()
					.describe('US state code, e.g. "WA". Exact, case-insensitive.'),
				city: z
					.string()
					.optional()
					.describe(
						"City substring, case-insensitive — some listings name two towns."
					),
				exemption: z
					.string()
					.optional()
					.describe(
						'Exemption code, e.g. "RULE_506_B", "RULE_506_C", "REG_A". Exact, case-insensitive.'
					),
				sponsor: z
					.string()
					.optional()
					.describe(
						"Sponsor id (exact) or a case-insensitive substring of the sponsor name."
					),
				accepting_investment: z
					.boolean()
					.optional()
					.describe(
						"True selects only offerings open to new subscriptions (status ACTIVE)."
					),
				...rangeArgShape(),
				sort_by: z
					.string()
					.optional()
					.describe(
						`Numeric field to sort by. One of: ${numericFieldIds().join(", ")}. Offerings that do not disclose it sort LAST in both directions.`
					),
				order: z
					.enum(["asc", "desc"])
					.optional()
					.describe("Sort direction. Default desc."),
				limit: z
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.describe("Maximum offerings to return after filtering and sorting."),
			},
			outputSchema: {
				...envelopeShape,
				offerings: z.array(offeringSchema),
				count: z.number().describe("Offerings returned after every filter."),
				total_available: z
					.number()
					.describe("Size of the public set before any filter."),
				candidates: z
					.number()
					.describe("Survivors of the non-numeric filters, before range filters."),
				excluded_by_criteria: z
					.number()
					.describe("Dropped because a DISCLOSED value failed a range test."),
				excluded_not_disclosed: z
					.array(undisclosedExclusionSchema)
					.describe(
						"Dropped because a filtered field is undisclosed. Unknown, not non-matching — worth a look if the criteria matter."
					),
				field_coverage: z
					.array(fieldCoverageSchema)
					.describe("How many candidates disclose each numeric field at all."),
				unknown_fields: z
					.array(z.string())
					.describe(
						"Field names in sort_by that this server does not know. Reported, then ignored — never silently treated as a no-match."
					),
				sorted_by: z.string().nullable(),
				sort_order: z.enum(["asc", "desc"]),
				truncated: z.boolean().describe("True when `limit` cut the result short."),
				field_catalogue: z
					.array(
						z.object({
							field: z.string(),
							path: z.string(),
							unit: z.string(),
							kind: z.string(),
							note: z.string(),
						})
					)
					.describe(
						"Every numeric field, where it lives in an offering record, its unit and whether it is a disclosure, a derivation or a projection."
					),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async (args) => {
			const empty = {
				offerings: [],
				count: 0,
				total_available: 0,
				candidates: 0,
				excluded_by_criteria: 0,
				excluded_not_disclosed: [],
				field_coverage: fieldCoverage([]),
				unknown_fields: [],
				sorted_by: null,
				sort_order: "desc" as const,
				truncated: false,
				field_catalogue: fieldCatalogue(),
			};
			if (config.offeringsDisabled) return offeringGateClosed(empty);

			try {
				const { res, offerings } = await fetchOfferings();
				const { ranges } = rangesFrom(args as Record<string, unknown>);
				const result = screenOfferings(offerings, {
					query: args.query ?? null,
					status: args.status ?? null,
					asset_class: args.asset_class ?? null,
					state: args.state ?? null,
					city: args.city ?? null,
					exemption: args.exemption ?? null,
					sponsor: args.sponsor ?? null,
					accepting_investment: args.accepting_investment ?? null,
					ranges,
					sort_by: args.sort_by ?? null,
					order: args.order ?? "desc",
					limit: args.limit ?? null,
				});

				return ok(res, {
					offerings: result.matched,
					count: result.matched.length,
					total_available: result.total_available,
					candidates: result.candidates,
					excluded_by_criteria: result.excluded_by_criteria,
					excluded_not_disclosed: result.excluded_not_disclosed,
					field_coverage: result.field_coverage,
					unknown_fields: result.unknown_fields,
					sorted_by: result.sorted_by,
					sort_order: result.sort_order,
					truncated: result.truncated,
					field_catalogue: fieldCatalogue(),
				});
			} catch (err) {
				return fail(err, listingsUrl(), empty);
			}
		}
	);

	/* ---------------------------------------------------------- */
	/* compare_offerings                                           */
	/* ---------------------------------------------------------- */
	server.registerTool(
		"compare_offerings",
		{
			title: "Compare Commertize offerings side by side",
			description:
				"Align two to five public offerings field by field: asset class, geography, status, exemption, sponsor, tokenomics, derived offering size, SPV leverage and sponsor projections. Each row reports how many of the compared offerings disclose the field, whether they agree, and whether only some disclose it. Two nulls are reported as two absences, never as agreement. Ids come from list_offerings or search_offerings. Informational reference data — not an offer, solicitation, or recommendation.",
			inputSchema: {
				offering_ids: z
					.array(z.string().min(1))
					.min(2)
					.max(5)
					.describe(
						"Two to five offering UUIDs. Comparison rows follow this order."
					),
			},
			outputSchema: {
				...envelopeShape,
				offering_ids: z.array(z.string()),
				offering_names: z.array(z.string().nullable()),
				rows: z.array(comparisonRowSchema),
				undisclosed_by_all: z
					.array(z.string())
					.describe(
						"Fields NO compared offering discloses. The shape of the data gap, stated rather than left as a column of nulls."
					),
				differing_fields: z
					.array(z.string())
					.describe("Fields every offering discloses and on which they differ."),
				not_found: z
					.array(z.string())
					.describe(
						"Requested ids with no public offering. Present so a comparison of 4 is never silently a comparison of 3."
					),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ offering_ids }) => {
			const empty = {
				offering_ids: [],
				offering_names: [],
				rows: [],
				undisclosed_by_all: [],
				differing_fields: [],
				not_found: [],
			};
			if (config.offeringsDisabled) return offeringGateClosed(empty);

			try {
				const { res, offerings } = await fetchOfferings();
				const byId = new Map(
					offerings.filter((o) => o.id !== null).map((o) => [o.id as string, o])
				);
				const requested = [...new Set(offering_ids)];
				const found = requested
					.map((id) => byId.get(id))
					.filter((o): o is Offering => o !== undefined);
				const notFound = requested.filter((id) => !byId.has(id));

				/*
				 * Fewer than two resolvable ids is a refusal, not a degraded
				 * comparison. A one-column "comparison" invites a reader to treat a
				 * single offering's figures as though they had been contrasted with
				 * something, and the ids that failed are named in the message.
				 */
				if (found.length < 2) {
					return refuse(
						"NOT_FOUND",
						`A comparison needs at least two resolvable offerings; ${found.length} of ${requested.length} requested id(s) matched a public offering. Unmatched: ${
							notFound.length > 0 ? notFound.join(", ") : "(none)"
						}. Call list_offerings or search_offerings for current ids.`,
						res.sourceUrl,
						{ ...empty, not_found: notFound }
					);
				}

				const comparison = compareOfferings(found);
				return ok(res, { ...comparison, not_found: notFound });
			} catch (err) {
				return fail(err, listingsUrl(), empty);
			}
		}
	);

	/* ---------------------------------------------------------- */
	/* list_sponsors                                               */
	/* ---------------------------------------------------------- */
	server.registerTool(
		"list_sponsors",
		{
			title: "List sponsors on the Commertize marketplace",
			description:
				"Every sponsor with a public offering on Commertize, with what they have listed here: offering count, breakdown by status and asset class, states, and the summed target raise across only those offerings that disclose one. This is an INVENTORY OF PLATFORM LISTINGS, not a track record: no prior-deal, realized-return, AUM or principal data exists on any public Commertize endpoint, and every response names what is unavailable. Informational reference data — not an offer, solicitation, or recommendation.",
			inputSchema: {},
			outputSchema: {
				...envelopeShape,
				sponsors: z.array(sponsorSummarySchema),
				count: z.number(),
				unattributed_offerings: z
					.number()
					.describe(
						"Public offerings whose sponsor stub carries neither an id nor a name. Counted, never folded into a pseudo-sponsor."
					),
				basis: z.string(),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async () => {
			const empty = {
				sponsors: [],
				count: 0,
				unattributed_offerings: 0,
				basis: SPONSOR_BASIS,
			};
			if (config.offeringsDisabled) return offeringGateClosed(empty);

			try {
				const { res, offerings } = await fetchOfferings();
				const { sponsors, unattributed } = rollUpSponsors(offerings);
				return ok(res, {
					sponsors,
					count: sponsors.length,
					unattributed_offerings: unattributed,
					basis: SPONSOR_BASIS,
				});
			} catch (err) {
				return fail(err, listingsUrl(), empty);
			}
		}
	);

	/* ---------------------------------------------------------- */
	/* get_sponsor                                                 */
	/* ---------------------------------------------------------- */
	server.registerTool(
		"get_sponsor",
		{
			title: "Get one Commertize sponsor",
			description:
				"One sponsor's public record, by id or by name substring: which offerings they have listed on Commertize, broken down by status, asset class and geography. NOT A TRACK RECORD — Commertize's sponsor endpoint is authenticated, so no prior deals, realized returns, AUM, principals or verification status are available through this server, and the response names each of those absences explicitly rather than omitting them. Informational reference data — not an offer, solicitation, or recommendation.",
			inputSchema: {
				sponsor: z
					.string()
					.min(1)
					.describe(
						"Sponsor id (exact, as returned on an offering) or a case-insensitive substring of the sponsor's business name."
					),
			},
			outputSchema: {
				...envelopeShape,
				sponsor: sponsorSummarySchema.nullable(),
				/** Populated only when a name substring matched more than one sponsor. */
				ambiguous_matches: z.array(
					z.object({ id: z.string().nullable(), name: z.string().nullable() })
				),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ sponsor }) => {
			const empty = { sponsor: null, ambiguous_matches: [] };
			if (config.offeringsDisabled) return offeringGateClosed(empty);

			try {
				const { res, offerings } = await fetchOfferings();
				const lookup = findSponsor(offerings, sponsor);

				if (lookup.status === "not_found") {
					return refuse(
						"NOT_FOUND",
						`No sponsor matching "${sponsor}" has a public offering on Commertize. Sponsors with no publicly viewable listing are not visible through this server at all. Call list_sponsors for the current set.`,
						res.sourceUrl,
						empty
					);
				}
				if (lookup.status === "ambiguous") {
					return refuse(
						"AMBIGUOUS",
						`"${sponsor}" matches ${lookup.candidates.length} sponsors. Merging them would invent a sponsor that does not exist, so nothing is returned; pass an exact sponsor id instead.`,
						res.sourceUrl,
						{ ...empty, ambiguous_matches: lookup.candidates }
					);
				}
				return ok(res, { sponsor: lookup.sponsor, ambiguous_matches: [] });
			} catch (err) {
				return fail(err, listingsUrl(), empty);
			}
		}
	);
};
