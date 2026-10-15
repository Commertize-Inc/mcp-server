/**
 * `tokenizability_check`: Commertize's fixed asset scorecard as an MCP tool.
 *
 * Contract and every string: AXIOM ruling 2026-10-15 §4 (T1 CERTIFIED WITH 2
 * REDLINES + 4 CONDITIONS), on FORGE handoff
 * forge-axiom-agent-adoption-mcp-contracts-2026-10-15 §1.
 *
 * - The scorer is NOT here. The tool posts the answers to the backend's
 *   stateless `POST /scorecard/check` (commertize.com #700) and receives
 *   certified sentence ids only. The per-class ceiling table, bucket, legs
 *   and lifts never appear in this public repo, a response or the docs
 *   (C4-4; 10-08 G-3).
 * - Every user-visible byte (name, title, description, input descriptions,
 *   option titles, result sentences, errors, disclaimer) is a certified
 *   string from CERT below. Each entry is re-hashed at load; one mismatch and
 *   the tool refuses every call (fail closed). An id from the backend that is
 *   not in the result library fails the whole response closed.
 * - Inputs are closed choices only, no free text (C4-2). Answer values are
 *   never logged here, never sent to analytics, never stored (C4-1).
 * - The disclaimer is F-1 only (apx-ae7d0aacc7): D-1 and the directory text
 *   contain words the sponsor-facing S-2 list denies (AXIOM F-2). This tool is
 *   registered outside tools.ts's `register`, so withPublicDisclaimer never
 *   touches it.
 * - Default OFF (`config.scorecardDisabled`). Never on the keyed `/mcp`.
 */

import { createHash } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { config } from "./config.js";
import { disclaimerBlockFor, disclaimerBlockSchema } from "./disclaimerBlock.js";
import { ApiError, postPublicJson } from "./http.js";

export const SCORECARD_TOOL_NAME = "tokenizability_check";
export const SCORECARD_PATH = "/scorecard/check";
/** AXIOM §4 redline: no internal codename in the version value. */
export const SCORECARD_VERSION = "0.1";

/* ------------------------------------------------------------------ */
/* certified strings (apx- + sha1(UTF-8)[:10]); re-hashed at load      */
/* ------------------------------------------------------------------ */

export const CERT: Readonly<Record<string, string>> = {
	// T1 (AXIOM 2026-10-15 §4)
	"apx-887f96a180": "tokenizability_check",
	"apx-2869d443af": "Asset scorecard check",
	"apx-46f7925268":
		"Runs Commertize's fixed asset scorecard on eight multiple-choice answers about one asset and returns the scorecard's result sentences in order. The scorecard is a fixed set of rules: no model is used, the answers are not stored, and no person reviews them. The result reflects the answers as given. In the answer choices, \"we\", \"our\" and \"ourselves\" refer to the asset's owner.",
	"apx-faa0615547":
		"Optional, for the four commercial-property asset types only: whether each listed document is in hand. Do not send the documents.",
	"apx-7802b82794": "This tool lists documents for commercial-property asset types only.",
	"apx-e03c85072a": "One or more answers are not among the allowed choices. Nothing was scored.",
	"apx-3f25f6e06a":
		"Documents can be listed for commercial-property asset types only. Nothing was scored.",
	"apx-955c10dcd7":
		"The asset scorecard is not enabled on this server instance. This is a policy state, not an outage; retrying will not change it.",
	// S-1 questions (AXIOM 2026-10-14 S-1; placement on MCP certified §4)
	"apx-0e5412406d": "What kind of asset is it?",
	"apx-cafb1121e6": "Who holds title to the asset?",
	"apx-42bd751c57": "Where does the asset's cash flow come from today?",
	"apx-39096d175d": "How is the asset valued today?",
	"apx-38ce58f6ef": "Where is ownership of the asset recorded or held?",
	"apx-861deb578b": "Is there a lender or lien on the asset?",
	"apx-2d1d0eeb0b": "What evidence of the asset's income or condition exists?",
	"apx-57502c8645": "Approximate value of the asset",
	// S-1 option labels
	"apx-f8ec23577c": "Multifamily property",
	"apx-0fcfaccb4b": "Single-tenant industrial property",
	"apx-f84b4b2f26": "Net-lease property",
	"apx-dc3a66f4d8": "Private credit, existing fund",
	"apx-10119a892b": "Other commercial property",
	"apx-db959fc143": "Private company equity",
	"apx-67a99446d4": "Oil and gas royalties",
	"apx-f8fa324282": "Solar or battery storage",
	"apx-42b95f0a34": "Small hydro",
	"apx-99f9c713a1": "Data center",
	"apx-bde6b65f26": "GPU compute",
	"apx-71efc0ca53": "Farmland",
	"apx-be025bc085": "Sports receivables",
	"apx-e38b34cbf5": "Music or IP royalties",
	"apx-11ed5303d3": "Producing mine",
	"apx-b237e4122c": "Carbon credits",
	"apx-593ebdfc93": "Mitigation bank credits",
	"apx-ad26aa9c40": "Single collectible",
	"apx-fc0278f95e": "Pool of collectibles",
	"apx-92b65ae751": "Mining exploration project",
	"apx-9cdf42fba8": "Oil and gas development project",
	"apx-6e6a6f2086": "Other",
	"apx-eaf44855da": "One company that owns only this asset",
	"apx-d264b6fefe": "One company that also owns other assets",
	"apx-23382604a2": "Several owners under a signed agreement",
	"apx-96c0880f04": "One or more individuals, or a trust",
	"apx-20c47c9167": "Not sure",
	"apx-4b350c8c3d": "Signed leases or contracts with third parties",
	"apx-018f2ad03b": "Operations, with figures we report ourselves",
	"apx-077c5a1b5f": "No cash flow today",
	"apx-dd1fde4181": "Not yet operating, with no signed buyer for its output",
	"apx-2ec065b4e6": "An independent appraisal or a published index",
	"apx-792d376575": "A cash-flow model based on a signed contract",
	"apx-4f5dc2bb1f": "Our own projections",
	"apx-ebb3eea6ac": "No valuation yet",
	"apx-458aec37d7": "A public title record or registry",
	"apx-75e79c5110": "A named third-party custodian",
	"apx-a267107629": "Held by the operator",
	"apx-55108f1118": "None we can name yet",
	"apx-265dcc1081": "No lender or lien",
	"apx-99357dc24f": "Yes, and the lender has consented in writing",
	"apx-b9dc1682f2": "Yes, and the lender has not been asked",
	"apx-3380ae9f5b": "Yes, and the lender has said no",
	"apx-f81d909535": "Reports produced by third parties",
	"apx-b532fa50d9": "Audited or reviewed financial statements",
	"apx-33d7fc36a9": "Statements we prepared ourselves",
	"apx-80e9901fb4": "None yet",
	"apx-802bc4c730": "Under $1 million",
	"apx-a09109bf6c": "$1 million to $10 million",
	"apx-c2425cd56a": "$10 million to $500 million",
	"apx-b81508f179": "Over $500 million",
	// S-1 DOC rows (DOC.nonRE and DOC.note are form-only, F-4: never here)
	"apx-c6abde3660": "Recorded deed and a current preliminary title report",
	"apx-a8e9f6e36c": "Land title survey",
	"apx-2097f7a3b3": "Independent appraisal",
	"apx-239b0d88a4": "Loan documents for every lien",
	"apx-c7f79c2e1a": "Rent roll",
	"apx-45c6034dee": "Leases",
	"apx-092a161796": "Phase I environmental site assessment",
	"apx-5d691fa896": "Insurance certificates",
	"apx-cc8bdceab3": "Property tax bills for the last three years",
	"apx-5d98c5203b": "Operating statement for the last twelve months",
	"apx-e8a5d909aa": "Entity tax returns for the last three years",
	"apx-1693de0c13": "Ownership chart for every entity that holds the asset",
	"apx-3d91c18d32": "Have it",
	"apx-8de95fd5b4": "Not yet",
	"apx-67c4d0506a": "Not applicable",
	// 10-08 result library (CERT_atlas_scorecard_sentences_2026-10-08 §1)
	"apx-ac50a6dc09":
		"Every item this scorecard checks is met as described; no further items are listed.",
	"apx-b7d9de2717": "Fits the current process with the items listed below.",
	"apx-02fdeb9453": "Not ready for the current process; the blocking items are listed below.",
	"apx-64801be9cd": "Does not fit the current process as described.",
	"apx-67908e9f07": "More answers are needed before a result can be shown.",
	"apx-5db8382ce2":
		"The holding entity also owns other assets, so how this asset is separated from them is reviewed first.",
	"apx-ae2ff7f962":
		"Several owners hold the asset, so the owners' agreement and the consents it calls for are part of the process.",
	"apx-cdfab376fe":
		"Title is held by individuals or a trust, so which entity would issue is reviewed first.",
	"apx-5abd2c1dff":
		"Reported figures need an independent source (meter, registry, lender report or tax record) before they can be published.",
	"apx-6c17612e4b":
		"With no current cash flow, any description of the asset rests on its value, not on income.",
	"apx-55cba91bd0":
		"A value that traces only to the sponsor's own projections needs an independent appraisal or index.",
	"apx-e77c2069d2":
		"Operator-held assets need a named third-party custodian or a recorded title path.",
	"apx-3660e37e2f": "The lender's written acknowledgment is part of the process.",
	"apx-79204d0c8c":
		"No current cash flow and no contracted offtake: the process has no income to measure.",
	"apx-cf94ff0eb4": "No independent way to value the asset exists yet; that has to come first.",
	"apx-58720a47de":
		"No custodian or recorded title path can be named yet; that has to come first.",
	"apx-86d1fc7d5d": "The lender prohibits it today; that has to change first.",
	"apx-76837db548":
		"No evidence of the asset's income or condition exists in a form that can be published.",
	"apx-d29b96056c": "Who holds title, and whether it is the only asset in that entity.",
	"apx-2e1bfba44b": "Whether a lender holds a lien and what it requires.",
	"apx-ae7d0aacc7":
		"This result reflects the answers as given. It is not an offer or a recommendation, and it does not mean an issuance will occur.",
	"apx-09c32736e2":
		"Any issuance is subject to review, signed agreements and platform readiness on the network used.",
};

const apx = (s: string): string =>
	"apx-" + createHash("sha1").update(s, "utf8").digest("hex").slice(0, 10);

/** Every entry re-hashed once. False = the tool refuses every call. */
export const CERT_INTEGRITY_OK: boolean = Object.entries(CERT).every(
	([id, text]) => apx(text) === id
);

const t = (id: string): string => CERT[id] ?? "";

export const F1_ID = "apx-ae7d0aacc7";
export const F2_ID = "apx-09c32736e2";

/** The 10-08 library: the only ids a backend answer may contain. */
export const RESULT_LIBRARY: ReadonlySet<string> = new Set([
	"apx-ac50a6dc09",
	"apx-b7d9de2717",
	"apx-02fdeb9453",
	"apx-64801be9cd",
	"apx-67908e9f07",
	"apx-5db8382ce2",
	"apx-ae2ff7f962",
	"apx-cdfab376fe",
	"apx-5abd2c1dff",
	"apx-6c17612e4b",
	"apx-55cba91bd0",
	"apx-e77c2069d2",
	"apx-3660e37e2f",
	"apx-79204d0c8c",
	"apx-cf94ff0eb4",
	"apx-58720a47de",
	"apx-86d1fc7d5d",
	"apx-76837db548",
	"apx-d29b96056c",
	"apx-2e1bfba44b",
	F2_ID,
	F1_ID,
]);

/* ------------------------------------------------------------------ */
/* questions: [answer key, label id, internal key if aliased]          */
/* ------------------------------------------------------------------ */

type Opt = readonly [key: string, labelId: string, internal?: string];

/** S-1 order (owner-approved), not the scorer's order. */
const Q1: readonly Opt[] = [
	["cre_multifamily", "apx-f8ec23577c"],
	["cre_industrial_single_tenant", "apx-0fcfaccb4b"],
	["cre_net_lease", "apx-f84b4b2f26"],
	["private_credit_existing_fund", "apx-dc3a66f4d8"],
	["cre_other", "apx-10119a892b"],
	["private_company_equity", "apx-db959fc143"],
	["og_royalty", "apx-67a99446d4"],
	["energy_solar_storage", "apx-f8fa324282"],
	["hydro_small_private", "apx-42b95f0a34"],
	["data_center", "apx-99f9c713a1"],
	["gpu_compute", "apx-bde6b65f26"],
	["farmland", "apx-71efc0ca53"],
	["sports_receivable", "apx-be025bc085"],
	["music_ip_royalty", "apx-e38b34cbf5"],
	["producing_mine", "apx-11ed5303d3"],
	["carbon", "apx-b237e4122c"],
	["mitigation_bank", "apx-593ebdfc93"],
	["collectible_title_token", "apx-ad26aa9c40"],
	["collectible_fractional_pool", "apx-fc0278f95e"],
	["exploration_mining", "apx-92b65ae751"],
	["og_development_standalone", "apx-9cdf42fba8"],
	["other", "apx-6e6a6f2086"],
];

export const QUESTION_DEFS: readonly (readonly [field: string, questionId: string, opts: readonly Opt[]])[] = [
	["q1_class", "apx-0e5412406d", Q1],
	[
		"q2_title",
		"apx-cafb1121e6",
		[
			["single_entity_this_asset", "apx-eaf44855da"],
			["entity_plus_other_assets", "apx-d264b6fefe"],
			["several_owners_signed_agreement", "apx-23382604a2"],
			["individuals_or_trust", "apx-96c0880f04"],
			["unsure", "apx-20c47c9167"],
		],
	],
	[
		"q3_cashflow",
		"apx-42bd751c57",
		[
			["contracted_third_party", "apx-4b350c8c3d"],
			["operating_sponsor_reported", "apx-018f2ad03b"],
			["value_only", "apx-077c5a1b5f"],
			["pre_operating_no_offtake", "apx-dd1fde4181"],
		],
	],
	[
		"q4_valuation",
		"apx-39096d175d",
		[
			["independent_appraisal_or_index", "apx-2ec065b4e6"],
			["dcf_signed_contract", "apx-792d376575"],
			["sponsor_pro_forma", "apx-4f5dc2bb1f"],
			["none", "apx-ebb3eea6ac"],
		],
	],
	[
		"q5_custody",
		"apx-38ce58f6ef",
		[
			["recorded_title_or_registry", "apx-458aec37d7"],
			["named_third_party_custodian", "apx-75e79c5110"],
			["held_by_operator", "apx-a267107629"],
			["none_nameable", "apx-55108f1118"],
		],
	],
	[
		"q6_encumbrance",
		"apx-861deb578b",
		[
			["none", "apx-265dcc1081"],
			// AXIOM §4 F-5: REQUIRED alias. The label says "consented in
			// writing"; the internal key also covers "expected", which an agent
			// would pick for a principal who only expects consent.
			["lender_consented_in_writing", "apx-99357dc24f", "lender_consent_in_hand_or_expected"],
			["lender_not_asked", "apx-b9dc1682f2"],
			["lender_prohibits", "apx-3380ae9f5b"],
			["unsure", "apx-20c47c9167"],
		],
	],
	[
		"q7_evidence",
		"apx-2d1d0eeb0b",
		[
			["third_party_generated", "apx-f81d909535"],
			["audited_or_reviewed", "apx-b532fa50d9"],
			["sponsor_prepared_only", "apx-33d7fc36a9"],
			["none", "apx-80e9901fb4"],
		],
	],
	[
		"q8_band",
		"apx-57502c8645",
		[
			["under_1m", "apx-802bc4c730"],
			["1m_to_10m", "apx-a09109bf6c"],
			["10m_to_500m", "apx-c2425cd56a"],
			["over_500m", "apx-b81508f179"],
		],
	],
];

/** The 12 sponsor-facing RE document rows, S-1 order. */
export const DOC_DEFS: readonly (readonly [doc: string, labelId: string])[] = [
	["RE-01", "apx-c6abde3660"],
	["RE-06", "apx-a8e9f6e36c"],
	["RE-09", "apx-2097f7a3b3"],
	["RE-12", "apx-239b0d88a4"],
	["RE-19", "apx-c7f79c2e1a"],
	["RE-20", "apx-45c6034dee"],
	["RE-24", "apx-092a161796"],
	["RE-27", "apx-5d691fa896"],
	["RE-29", "apx-cc8bdceab3"],
	["RE-31", "apx-5d98c5203b"],
	["RE-35", "apx-e8a5d909aa"],
	["RE-36", "apx-1693de0c13"],
];

const DOC_OPTS: readonly Opt[] = [
	["have", "apx-3d91c18d32"],
	["not_yet", "apx-8de95fd5b4"],
	["na", "apx-67c4d0506a"],
];

/** The four commercial-property classes (S-1: the DOC list applies to them only). */
const isCommercialProperty = (q1: string): boolean => q1.startsWith("cre_");

/* ------------------------------------------------------------------ */
/* schemas                                                             */
/* ------------------------------------------------------------------ */

/** A closed choice: one literal per option, titled with its S-1 label. */
const choice = (opts: readonly Opt[]) =>
	z.union(
		opts.map(([key, labelId]) => z.literal(key).meta({ title: t(labelId) })) as unknown as [
			z.ZodLiteral<string>,
			z.ZodLiteral<string>,
			...z.ZodLiteral<string>[],
		]
	);

const inputShape: Record<string, z.ZodTypeAny> = Object.fromEntries(
	QUESTION_DEFS.map(([field, qId, opts]) => [field, choice(opts).describe(t(qId))])
);
inputShape.docs = z
	.object(
		Object.fromEntries(
			DOC_DEFS.map(([doc, labelId]) => [doc, choice(DOC_OPTS).describe(t(labelId)).optional()])
		)
	)
	.strict()
	.optional()
	.describe(t("apx-faa0615547"));

const sentence = z.object({ id: z.string(), text: z.string() });
const outputShape = {
	result: z.array(sentence),
	documents_marked_not_yet: z
		.array(z.object({ doc: z.string(), id: z.string(), text: z.string() }))
		.nullable(),
	documents_note: sentence.nullable(),
	scorecard_version: z.string(),
	as_of: z.string(),
	source_url: z.string(),
	disclaimer: z.string(),
	disclaimer_block: disclaimerBlockSchema,
	error: z
		.object({ code: z.string(), message: z.string().nullable(), retryable: z.boolean() })
		.nullable(),
};

/* ------------------------------------------------------------------ */
/* responses                                                           */
/* ------------------------------------------------------------------ */

const render = (structured: Record<string, unknown>, isError: boolean): CallToolResult => ({
	content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
	structuredContent: structured,
	...(isError ? { isError: true } : {}),
});

/**
 * `source_url` is the site root until the scorecard form is live at
 * /tokenize on production (AXIOM §4), then `${siteUrl}/tokenize`.
 */
const sourceUrl = (): string => config.siteUrl;

const envelope = (
	payload: {
		result: { id: string; text: string }[];
		documents_marked_not_yet: { doc: string; id: string; text: string }[] | null;
		documents_note: { id: string; text: string } | null;
	},
	error: { code: string; message: string | null; retryable: boolean } | null
): CallToolResult =>
	render(
		{
			result: payload.result,
			documents_marked_not_yet: payload.documents_marked_not_yet,
			documents_note: payload.documents_note,
			scorecard_version: SCORECARD_VERSION,
			as_of: new Date().toISOString(),
			source_url: sourceUrl(),
			disclaimer: t(F1_ID),
			disclaimer_block: disclaimerBlockFor(F1_ID),
			error,
		},
		error !== null
	);

/**
 * A refusal. `message` is a certified sentence or null: where no certified
 * sentence fits (an outage, a rate limit, a fault) the machine code speaks
 * alone rather than uncertified prose.
 */
export const scorecardRefusal = (
	code: string,
	messageId: string | null,
	retryable: boolean
): CallToolResult =>
	envelope(
		{ result: [], documents_marked_not_yet: null, documents_note: null },
		{ code, message: messageId ? t(messageId) : null, retryable }
	);

/* ------------------------------------------------------------------ */
/* registration                                                        */
/* ------------------------------------------------------------------ */

type Args = { [field: string]: unknown; docs?: Record<string, string | undefined> };

const internalKey = (field: string, key: string): string => {
	const def = QUESTION_DEFS.find(([f]) => f === field);
	const opt = def?.[2].find(([k]) => k === key);
	return opt?.[2] ?? key;
};

export const registerScorecardTool = (server: McpServer): void => {
	if (config.scorecardDisabled) return;

	server.registerTool(
		SCORECARD_TOOL_NAME,
		{
			title: t("apx-2869d443af"),
			description: t("apx-46f7925268"),
			// Strict: an unknown field (free text) is refused, not stripped (C4-2).
			inputSchema: z.object(inputShape).strict(),
			outputSchema: outputShape,
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async (raw: unknown) => {
			if (!CERT_INTEGRITY_OK) return scorecardRefusal("INTERNAL_ERROR", null, false);
			const args = raw as Args;
			const re = isCommercialProperty(String(args.q1_class));
			if (args.docs !== undefined && !re) {
				return scorecardRefusal("INVALID_ARGUMENT", "apx-3f25f6e06a", false);
			}

			const answers = Object.fromEntries(
				QUESTION_DEFS.map(([field]) => [field, internalKey(field, String(args[field]))])
			);
			const body: Record<string, unknown> = { v: 1, answers };
			if (re && args.docs !== undefined) {
				body.docs = Object.fromEntries(DOC_DEFS.map(([doc]) => [doc, args.docs?.[doc] ?? null]));
			}

			let ids: unknown;
			let rubric: unknown;
			try {
				const res = await postPublicJson<{ rubric?: unknown; sentence_ids?: unknown }>(
					SCORECARD_PATH,
					body
				);
				ids = res.body?.sentence_ids;
				rubric = res.body?.rubric;
			} catch (err) {
				const status = err instanceof ApiError ? err.status : null;
				if (status === 404) return scorecardRefusal("TOOL_DISABLED", "apx-955c10dcd7", false);
				if (status === 400) return scorecardRefusal("INVALID_ARGUMENT", "apx-e03c85072a", false);
				if (status === 429) return scorecardRefusal("RATE_LIMITED", null, true);
				return scorecardRefusal("UPSTREAM_UNAVAILABLE", null, true);
			}

			// Fail closed: the version, every id, and F-1 last must all hold.
			if (
				rubric !== SCORECARD_VERSION ||
				!Array.isArray(ids) ||
				ids.length < 2 ||
				!ids.every((id) => typeof id === "string" && RESULT_LIBRARY.has(id)) ||
				ids[ids.length - 1] !== F1_ID ||
				ids.indexOf(F1_ID) !== ids.length - 1
			) {
				return scorecardRefusal("INTERNAL_ERROR", null, false);
			}

			// F-1 is the disclaimer, so the result is everything before it: the
			// lead sentence at [0], its items in order, F-2 last (none on
			// INCOMPLETE). AXIOM §4: "below" reads as array order.
			const result = (ids as string[]).slice(0, -1).map((id) => ({ id, text: t(id) }));
			const documents_marked_not_yet = re
				? DOC_DEFS.filter(([doc]) => args.docs?.[doc] === "not_yet").map(([doc, labelId]) => ({
						doc,
						id: labelId,
						text: t(labelId),
					}))
				: null;
			const documents_note = re ? null : { id: "apx-7802b82794", text: t("apx-7802b82794") };
			return envelope({ result, documents_marked_not_yet, documents_note }, null);
		}
	);
};

/**
 * SDK-built argument errors for this tool (an answer outside the choices)
 * carry T1-S6, F-1 and its block, on every surface it is registered on. The
 * SDK names the tool in the message ("Invalid arguments for tool <name>:");
 * other tools' errors pass to the previous handler unchanged. Installed after
 * any surface-wide override so this tool is matched first.
 */
const T1_SDK_ERROR = new RegExp(`\\bfor tool ${SCORECARD_TOOL_NAME}:`);
export const envelopeScorecardSdkErrors = (server: McpServer): void => {
	if (config.scorecardDisabled) return;
	const s = server as unknown as { createToolError: (m: string) => CallToolResult };
	const prev = s.createToolError.bind(server);
	s.createToolError = (message: string) =>
		T1_SDK_ERROR.test(message)
			? scorecardRefusal("INVALID_ARGUMENT", "apx-e03c85072a", false)
			: prev(message);
};
