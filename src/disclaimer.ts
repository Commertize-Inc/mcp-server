/**
 * The standing disclaimer carried by every tool response, success or error.
 *
 * One constant, one wording. If it needs to change it changes here, and the
 * language test asserts the four load-bearing clauses are still present.
 */
export const DISCLAIMER =
	"Informational only. Securities are offered under Regulation D to verified investors. " +
	"Nothing provided by this server is an offer to sell or a solicitation of an offer to buy " +
	"any security, and nothing here is investment, legal, or tax advice or a recommendation. " +
	"Agent access is informational; it confers no authority to transact. " +
	"Data is served as-is from Commertize's public API and may be incomplete or out of date.";

/**
 * Attached to any field a sponsor supplied as a forward-looking figure.
 * Projections are inputs to diligence, not statements of fact.
 */
export const PROJECTION_NOTE =
	"Sponsor-supplied projections. Projections are estimates, not statements of fact, " +
	"and may not be achieved. Verify against the offering documents.";

/**
 * Attached to Rule 506(b) offerings. 506(b) prohibits general solicitation;
 * an agent reading this data is doing research, not receiving an offer.
 */
export const RULE_506B_NOTE =
	"This offering is structured under Rule 506(b), which does not permit general solicitation. " +
	"This record is informational reference data, not an offer, and participation requires an " +
	"existing relationship plus investor verification.";
