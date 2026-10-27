/**
 * Canonical form of the get_news `since` input.
 *
 * `since` becomes part of the upstream URL, and that URL is the cache key. A
 * loose parse (anything Date.parse accepts) lets a caller create a fresh cache
 * key, and a fresh upstream call, per request by varying seconds, offsets or
 * spellings. So only ISO 8601 dates and minute-or-finer timestamps are
 * accepted, the instant must fall in a bounded range, and it is floored to
 * the minute and re-serialised. Every spelling of the same minute is then one
 * key.
 */

/** YYYY-MM-DD, or YYYY-MM-DDTHH:MM[:SS[.fff]] with Z or ±HH:MM. */
const ISO_SINCE =
	/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/** Earliest accepted instant: 2000-01-01T00:00Z. */
export const SINCE_MIN_MS = Date.UTC(2000, 0, 1);
/** Latest accepted instant: one day after now (clock skew allowance). */
export const SINCE_MAX_AHEAD_MS = 24 * 60 * 60 * 1000;

const MINUTE_MS = 60_000;

/**
 * Returns the canonical `YYYY-MM-DDTHH:MM:00.000Z` string, or null when the
 * input is not an accepted ISO form or falls outside the range.
 */
export const canonicalSince = (raw: string, now: number = Date.now()): string | null => {
	if (!ISO_SINCE.test(raw)) return null;
	const ms = Date.parse(raw);
	if (Number.isNaN(ms)) return null;
	if (ms < SINCE_MIN_MS || ms > now + SINCE_MAX_AHEAD_MS) return null;
	return new Date(Math.floor(ms / MINUTE_MS) * MINUTE_MS).toISOString();
};
