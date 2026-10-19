/**
 * The standing disclaimer carried by every tool response, success or error,
 * on every surface (stdio, keyed HTTP, public HTTP).
 *
 * AXIOM-certified D-1 (ruling 2026-10-15 §3), byte-exact. Id = apx- +
 * sha1(UTF-8 bytes)[:10]. One constant, one wording: if it needs to change it
 * changes here, under a new certification, and the language test asserts the
 * id and the four load-bearing clauses.
 */
export const DISCLAIMER =
	"Reference information only. Nothing provided by this server is an offer to sell or a " +
	"solicitation of an offer to buy any security. Nothing here is investment, legal or tax " +
	"advice or a recommendation. Agent access confers no authority to transact. Data may be " +
	"incomplete or out of date.";
export const DISCLAIMER_ID = "apx-b88a8f669d";

/**
 * Attached to any field a sponsor supplied as a forward-looking figure.
 * Projections are inputs to diligence, not statements of fact.
 */
export const PROJECTION_NOTE =
	"Sponsor-supplied projections. Projections are estimates, not statements of fact, " +
	"and may not be achieved. Check them against the offering documents.";

/**
 * Attached to Rule 506(b) offerings. 506(b) prohibits general solicitation;
 * an agent reading this data is doing research, not receiving an offer.
 */
export const RULE_506B_NOTE =
	"This offering is structured under Rule 506(b), which does not permit general solicitation. " +
	"This record is informational reference data, not an offer, and participation requires an " +
	"existing relationship plus completion of the platform's investor onboarding checks.";
