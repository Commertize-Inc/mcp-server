/**
 * Raw public-API payloads -> typed, honest tool output.
 *
 * Rules this file exists to enforce:
 * 1. A missing value is `null` plus an entry in `not_disclosed`. It is never
 *    zero, never "", never an omitted key. An undisclosed figure and a
 *    disclosed zero must be distinguishable by a reader.
 * 2. Derived numbers are labelled as derived and the formula is documented,
 *    so nobody mistakes an arithmetic product for a sponsor disclosure.
 * 3. Forward-looking sponsor figures live under `projections` with a note.
 */

import { config } from "./config.js";
import { PROJECTION_NOTE, RULE_506B_NOTE } from "./disclaimer.js";
import {
	computeSpvLeverage,
	formatSpvLeverage,
	SPV_LEVERAGE_BASIS_LABELS,
	type SpvLeverageInput,
} from "./spvLeverage.js";

/* ------------------------------------------------------------------ */
/* primitives                                                          */
/* ------------------------------------------------------------------ */

/** Numeric columns can arrive as strings over JSON. Anything unusable -> null. */
export const num = (v: unknown): number | null => {
	if (v === null || v === undefined || v === "") return null;
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) ? n : null;
};

const str = (v: unknown): string | null =>
	typeof v === "string" && v.trim() !== "" ? v : null;

/** Multiply two possibly-null numbers; null unless both are present. */
const product = (a: number | null, b: number | null): number | null =>
	a === null || b === null ? null : a * b;

const titleCase = (code: string): string =>
	code
		.toLowerCase()
		.split("_")
		.map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
		.join(" ");

/* ------------------------------------------------------------------ */
/* label maps (mirror packages/data/src/enums/entities.ts)             */
/* ------------------------------------------------------------------ */

const OFFERING_LABELS: Record<string, string> = {
	RULE_506_B: "Regulation D, Rule 506(b)",
	RULE_506_C: "Regulation D, Rule 506(c)",
	REG_A: "Regulation A",
	REG_CF: "Regulation Crowdfunding",
	REG_S: "Regulation S",
};

const STATUS_LABELS: Record<string, string> = {
	PENDING_REVIEW: "Pending review",
	TOKENIZING: "Tokenizing — structuring and minting in progress",
	ACTIVE: "Active — open for subscription by verified investors",
	FULLY_FUNDED: "Fully funded — closed to new subscriptions",
	DISTRIBUTED: "Distributed — escrow released and tokens distributed",
	REFUNDED: "Refunded — escrow returned to subscribers",
	REJECTED: "Rejected",
	WITHDRAWN: "Withdrawn by sponsor",
	FROZEN: "Frozen",
};

/** Only ACTIVE takes new subscriptions. Everything else is a hard no. */
const ACCEPTING = new Set(["ACTIVE"]);

const ASSET_CLASS_LABELS: Record<string, string> = {
	MULTIFAMILY: "Multifamily",
	OFFICE: "Office",
	RETAIL: "Retail",
	INDUSTRIAL: "Industrial",
	MIXED_USE: "Mixed use",
	HOSPITALITY: "Hospitality",
	DATA_CENTERS: "Data centers",
	SELF_STORAGE: "Self storage",
	HEALTHCARE: "Healthcare",
	STUDENT_HOUSING: "Student housing",
	SENIOR_LIVING: "Senior living",
	AGRICULTURAL: "Agricultural",
	PARKING: "Parking",
	OTHER: "Other",
};

/* ------------------------------------------------------------------ */
/* offerings                                                           */
/* ------------------------------------------------------------------ */

export interface RawListing {
	id?: string;
	name?: string;
	city?: string;
	state?: string;
	propertyType?: string;
	status?: string;
	offeringType?: string;
	images?: unknown;
	financials?: Record<string, unknown> | null;
	tokenomics?: Record<string, unknown> | null;
	sponsor?: { id?: string; businessName?: string } | null;
	derivedCapRate?: unknown;
	year1CashOnCash?: unknown;
	effectiveAppraisalValue?: unknown;
	impliedEquityValuation?: unknown;
	[k: string]: unknown;
}

export const normalizeOffering = (raw: RawListing) => {
	const missing: string[] = [];
	/** Record a null as an explicit non-disclosure. */
	const track = <T>(field: string, value: T | null): T | null => {
		if (value === null) missing.push(field);
		return value;
	};

	const tok = (raw.tokenomics ?? {}) as Record<string, unknown>;
	const fin = (raw.financials ?? {}) as Record<string, unknown>;

	const tokenPrice = track("tokenomics.token_price", num(tok.tokenPrice));
	const tokensForInvestors = track(
		"tokenomics.tokens_for_investors",
		num(tok.tokensForInvestors)
	);
	const totalSupply = track(
		"tokenomics.total_token_supply",
		num(tok.totalTokenSupply)
	);
	const minTokens = track(
		"tokenomics.min_investment_tokens",
		num(tok.minInvestmentTokens)
	);

	// Mirrors the platform: targetRaise = tokensForInvestors x tokenPrice.
	const targetRaise = track(
		"target_raise",
		product(tokensForInvestors, tokenPrice)
	);
	const minInvestmentAmount = track(
		"min_investment_amount",
		product(minTokens, tokenPrice)
	);

	const statusCode = str(raw.status);
	const offeringCode = str(raw.offeringType);
	const assetCode = str(raw.propertyType);

	const leverage = computeSpvLeverage(raw as SpvLeverageInput);
	if (!leverage) missing.push("spv_leverage");

	const city = str(raw.city);
	const state = str(raw.state);
	if (!city) missing.push("location.city");
	if (!state) missing.push("location.state");

	const id = str(raw.id);

	return {
		id,
		name: str(raw.name),

		asset_class: {
			code: assetCode,
			label: assetCode
				? (ASSET_CLASS_LABELS[assetCode] ?? titleCase(assetCode))
				: null,
		},

		// Street address is deliberately not public; city/state is the
		// granularity the public marketplace renders.
		location: { city, state, street_address: null },

		status: {
			code: statusCode,
			label: statusCode ? (STATUS_LABELS[statusCode] ?? statusCode) : null,
			accepting_investment: statusCode ? ACCEPTING.has(statusCode) : false,
		},

		offering: {
			exemption_code: offeringCode,
			exemption_label: offeringCode
				? (OFFERING_LABELS[offeringCode] ?? offeringCode)
				: null,
			note: offeringCode === "RULE_506_B" ? RULE_506B_NOTE : null,
		},

		sponsor: {
			id: str(raw.sponsor?.id),
			name: str(raw.sponsor?.businessName),
		},

		tokenomics: {
			token_price: tokenPrice,
			total_token_supply: totalSupply,
			tokens_for_investors: tokensForInvestors,
			tokens_for_sponsor: num(tok.tokensForSponsor),
			tokens_for_treasury: num(tok.tokensForTreasury),
			min_investment_tokens: minTokens,
			max_investment_tokens: num(tok.maxInvestmentTokens),
			lockup_months: num(tok.lockupMonths),
		},

		/** Derived here, not disclosed by the sponsor. Formulae in the schema. */
		derived: {
			target_raise: targetRaise,
			min_investment_amount: minInvestmentAmount,
			implied_equity_valuation: num(raw.impliedEquityValuation),
			effective_appraisal_value: num(raw.effectiveAppraisalValue),
			cap_rate: num(raw.derivedCapRate),
		},

		spv_leverage: leverage
			? {
					ratio: leverage.ratio,
					ratio_display: formatSpvLeverage(leverage),
					debt_amount: leverage.debtAmount,
					asset_value: leverage.assetValue,
					basis: leverage.basis,
					basis_label: SPV_LEVERAGE_BASIS_LABELS[leverage.basis],
				}
			: null,
		spv_leverage_display: formatSpvLeverage(leverage),

		projections: {
			note: PROJECTION_NOTE,
			year_1_cash_on_cash: num(raw.year1CashOnCash),
			target_irr: num(fin.targetIRR),
			target_equity_multiple: num(fin.targetEquityMultiple),
			preferred_rate: num(fin.preferredReturn),
			hold_period_years: num(fin.holdPeriodYears),
			distribution_frequency: str(fin.distributionFrequency),
		},

		images: Array.isArray(raw.images) ? raw.images.filter((i): i is string => typeof i === "string") : [],

		links: {
			api_url: `${config.apiBaseUrl}/api/listings`,
			detail_page: id ? `${config.appUrl}/listing/${id}` : null,
			detail_page_requires_sign_in: true,
		},

		/** Every field above that came back null, named. */
		not_disclosed: missing,
	};
};

export type Offering = ReturnType<typeof normalizeOffering>;

/* ------------------------------------------------------------------ */
/* news                                                                */
/* ------------------------------------------------------------------ */

export interface RawArticle {
	id?: string;
	slug?: string;
	title?: string;
	summary?: string;
	content?: string;
	category?: string;
	tags?: unknown;
	imageUrl?: string;
	readTime?: unknown;
	publishedAt?: string;
	[k: string]: unknown;
}

/**
 * HTML -> readable text. Drops script/style blocks first (articles embed
 * JSON-LD in a <script> tag; leaving it in would feed an agent a duplicate
 * copy of the metadata as if it were prose).
 */
export const htmlToText = (html: string): string =>
	html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

export const normalizeArticleSummary = (raw: RawArticle) => {
	const slug = str(raw.slug);
	return {
		slug,
		title: str(raw.title),
		summary: str(raw.summary),
		category: str(raw.category),
		tags: Array.isArray(raw.tags)
			? raw.tags.filter((t): t is string => typeof t === "string")
			: [],
		published_at: str(raw.publishedAt),
		read_time_minutes: num(raw.readTime),
		image_url: str(raw.imageUrl),
		url: slug ? `${config.siteUrl}/news/${slug}` : null,
	};
};

export const normalizeArticleFull = (raw: RawArticle) => {
	const html = str(raw.content);
	return {
		...normalizeArticleSummary(raw),
		content_text: html ? htmlToText(html) : null,
	};
};
