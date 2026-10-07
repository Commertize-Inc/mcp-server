/**
 * SPV leverage disclosure — a local mirror of
 * `packages/data/src/utils/spvLeverage.ts` in the Commertize monorepo
 * (kept in step with the platform implementation).
 *
 * Kept byte-for-byte equivalent in behaviour so this server can never render
 * a different leverage number than the platform does:
 * - the ratio is always derived, never read from a self-reported percentage;
 * - the denominator precedence is appraisal -> purchase price -> acquisition
 *   cost, matching `Listing.effectiveAppraisalValue`;
 * - an undisclosed listing returns null and must render "Not disclosed"; it
 *   is NOT an unlevered listing;
 * - a disclosed 0 is a disclosure and returns a ratio of 0.
 *
 * NOTE: as of 2026-08-13 the public list endpoint does not carry
 * `spvDebtAmount` or `currentAppraisalValue`, so this returns null for every
 * live listing. It is here so the tool is correct on the day the field ships
 * publicly rather than silently wrong.
 */

export type SpvLeverageBasis =
	| "APPRAISAL"
	| "PURCHASE_PRICE"
	| "ACQUISITION_COST";

export interface SpvLeverageInput {
	spvDebtAmount?: number | string | null;
	currentAppraisalValue?: number | string | null;
	financials?: {
		purchasePrice?: number | string | null;
		acquisitionCost?: number | string | null;
	} | null;
}

export interface SpvLeverage {
	debtAmount: number;
	assetValue: number;
	basis: SpvLeverageBasis;
	ratio: number;
}

const toAmount = (value: number | string | null | undefined): number | null => {
	if (value === null || value === undefined || value === "") return null;
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n) || n < 0) return null;
	return n;
};

const resolveAssetValue = (
	input: SpvLeverageInput
): { value: number; basis: SpvLeverageBasis } | null => {
	const appraisal = toAmount(input.currentAppraisalValue);
	if (appraisal !== null && appraisal > 0) {
		return { value: appraisal, basis: "APPRAISAL" };
	}
	const purchasePrice = toAmount(input.financials?.purchasePrice);
	if (purchasePrice !== null && purchasePrice > 0) {
		return { value: purchasePrice, basis: "PURCHASE_PRICE" };
	}
	const acquisitionCost = toAmount(input.financials?.acquisitionCost);
	if (acquisitionCost !== null && acquisitionCost > 0) {
		return { value: acquisitionCost, basis: "ACQUISITION_COST" };
	}
	return null;
};

export const computeSpvLeverage = (
	input: SpvLeverageInput | null | undefined
): SpvLeverage | null => {
	if (!input) return null;
	const debtAmount = toAmount(input.spvDebtAmount);
	if (debtAmount === null) return null;
	const assetValue = resolveAssetValue(input);
	if (!assetValue) return null;
	return {
		debtAmount,
		assetValue: assetValue.value,
		basis: assetValue.basis,
		ratio: debtAmount / assetValue.value,
	};
};

export const SPV_LEVERAGE_BASIS_LABELS: Record<SpvLeverageBasis, string> = {
	APPRAISAL: "current appraised value",
	PURCHASE_PRICE: "purchase price",
	ACQUISITION_COST: "acquisition cost",
};

/** null in, "Not disclosed" out. The single place that mapping is made. */
export const formatSpvLeverage = (leverage: SpvLeverage | null): string =>
	leverage ? `${(leverage.ratio * 100).toFixed(1)}%` : "Not disclosed";
