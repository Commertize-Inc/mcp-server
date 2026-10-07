/**
 * THE OFFERING FIREWALL, ON THE CLIENT SIDE OF THE MCP TOOLS.
 *
 * Rule 506(b) does not permit general solicitation, and a machine-readable
 * offering feed is designed to be redistributed. So every offering tool serves
 * only offerings that the platform marks as publishable to a machine, and the
 * check fails closed on a missing or unknown answer.
 *
 * ## Why this is not a filter on the listing payload
 *
 * `list_offerings` and `get_offering` read `GET /api/listings`. That payload
 * does not carry `offeringType`, so there is nothing in it to filter ON. A
 * filter written against a field the response does not carry would pass
 * everything and look like a gate.
 *
 * The authority is therefore a different endpoint: `GET /api/venue/
 * instruments`, the instrument book, which IS behind the firewall server-side
 * (`utils/offeringVisibility.ts#isAgentReadableOffering`) and names only rows
 * that may be published to a machine. This module fetches it and returns the
 * id set. The tools serve the intersection and nothing else.
 *
 * ## Fail-closed means the failure of the AUTHORITY refuses, not proceeds
 *
 * If the instrument book is unreachable, returns a non-array, or returns a
 * shape we do not recognise, this returns `null` and the caller must REFUSE.
 * Serving the unfiltered marketplace because the gate was unavailable is the
 * exact failure this module exists to prevent, and "the check errored so we skipped it"
 * is how every fail-open in this codebase has been written.
 *
 * An EMPTY id set is not a failure. It is a venue with no 506(c) offering, and
 * the honest answer is zero offerings — never "the gate returned nothing, so
 * show everything".
 */

import { getJson } from "./http.js";

/** Path of the gated authority. Exported so the tools can cite it. */
export const FIREWALL_SOURCE_PATH = "/api/venue/instruments";

export interface FirewallVerdict {
	/** Ids the backend published to a machine reader. Possibly empty. */
	ids: Set<string>;
	/** How many rows the backend itself withheld. Required (security review R5p F-8). */
	withheld: number;
	/** When the authority was fetched. */
	fetchedAt: Date;
}

interface InstrumentBook {
	instruments?: unknown;
	withheld?: unknown;
}

/**
 * The ids an agent may be told about, or `null` when the gate could not be
 * consulted. `null` is a refusal, never an empty allowance.
 */
export const publishableOfferingIds =
	async (): Promise<FirewallVerdict | null> => {
		try {
			const res = await getJson<InstrumentBook>(FIREWALL_SOURCE_PATH);
			const body = res.body;
			if (!body || typeof body !== "object") return null;
			const rows = (body as InstrumentBook).instruments;
			// A missing or non-array `instruments` is an UNRECOGNISED shape, not an
			// empty book. An older backend that 404s, or an HTML error page parsed
			// as JSON, must refuse rather than read as "no offerings".
			if (!Array.isArray(rows)) return null;
			const ids = new Set<string>();
			for (const row of rows) {
				const id = (row as { id?: unknown } | null)?.id;
				if (typeof id === "string" && id !== "") ids.add(id);
			}
			// security review R5p F-8: `withheld` is REQUIRED. A backend that predates the
			// firewall serves the ungated book in the same shape, minus this
			// field; its presence as a non-negative integer is what proves the
			// answering backend is firewall-aware. Absent, null, a string, a
			// negative or a fraction all refuse.
			const rawWithheld = (body as InstrumentBook).withheld;
			if (
				typeof rawWithheld !== "number" ||
				!Number.isSafeInteger(rawWithheld) ||
				rawWithheld < 0
			) {
				return null;
			}
			return { ids, withheld: rawWithheld, fetchedAt: res.fetchedAt };
		} catch {
			return null;
		}
	};

/** The message a refusing tool returns. One sentence, one place. */
export const FIREWALL_UNAVAILABLE_MESSAGE =
	"The offering firewall could not be consulted, so no offering data is returned. Which offerings may be published to a machine reader is decided by the Commertize backend at GET /api/venue/instruments; when that answer is unavailable this server withholds everything rather than serving the ungated marketplace feed. Retry shortly.";

/** Stated in every gated payload, so a reader knows the set is a subset. */
export const FIREWALL_NOTE =
	"Only offerings the Commertize backend publishes to machine readers appear here — an offering made under Rule 506(c) with no not-an-offering designation. Offerings outside that set are withheld, not absent.";
