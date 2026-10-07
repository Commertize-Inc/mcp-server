/**
 * HTTP layer: one GET helper with a short TTL cache, single-flight
 * de-duplication, a hard timeout, and typed failures.
 *
 * Design constraints:
 * - Rate-limit friendly. The upstream public routes allow 120 reads/min
 *   (listings, news) and 30/min (stats). A cache hit inside the TTL makes
 *   zero upstream calls, and concurrent callers of the same path share one
 *   in-flight request.
 * - Never invent data on failure. A failure either serves a *labelled* stale
 *   cache entry or raises a typed error; it never returns an empty list that
 *   a caller could read as "no offerings exist".
 */

import { config } from "./config.js";

export type ApiErrorCode =
	| "UPSTREAM_TIMEOUT"
	| "UPSTREAM_UNREACHABLE"
	| "UPSTREAM_ERROR"
	| "UPSTREAM_BAD_BODY";

export class ApiError extends Error {
	readonly code: ApiErrorCode;
	readonly retryable: boolean;
	readonly status: number | null;
	readonly sourceUrl: string;

	constructor(args: {
		code: ApiErrorCode;
		message: string;
		retryable: boolean;
		status?: number | null;
		sourceUrl: string;
	}) {
		super(args.message);
		this.name = "ApiError";
		this.code = args.code;
		this.retryable = args.retryable;
		this.status = args.status ?? null;
		this.sourceUrl = args.sourceUrl;
	}
}

export interface CacheMeta {
	hit: boolean;
	age_seconds: number;
	stale: boolean;
}

export interface ApiResult<T> {
	body: T;
	/** When the body was actually fetched from the API, not when it was served. */
	fetchedAt: Date;
	cache: CacheMeta;
	sourceUrl: string;
}

interface CacheEntry {
	body: unknown;
	fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CacheEntry>>();

/** Test seam: drop all cached bodies. */
export const clearCache = (): void => {
	cache.clear();
	inFlight.clear();
};

const ageSeconds = (fetchedAt: number): number =>
	Math.max(0, Math.round((Date.now() - fetchedAt) / 1000));

const fetchFresh = async (url: string): Promise<CacheEntry> => {
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		config.requestTimeoutMs
	);

	try {
		const res = await fetch(url, {
			signal: controller.signal,
			headers: { accept: "application/json", "user-agent": config.userAgent },
		});

		if (!res.ok) {
			throw new ApiError({
				code: "UPSTREAM_ERROR",
				message: `Commertize API returned HTTP ${res.status} for ${url}`,
				// 5xx and 429 are worth retrying; a 4xx is a bad request on our side.
				retryable: res.status >= 500 || res.status === 429,
				status: res.status,
				sourceUrl: url,
			});
		}

		let body: unknown;
		try {
			body = await res.json();
		} catch {
			throw new ApiError({
				code: "UPSTREAM_BAD_BODY",
				message: `Commertize API returned a body that is not valid JSON for ${url}`,
				retryable: true,
				status: res.status,
				sourceUrl: url,
			});
		}

		return { body, fetchedAt: Date.now() };
	} catch (err) {
		if (err instanceof ApiError) throw err;
		const aborted =
			err instanceof Error &&
			(err.name === "AbortError" || err.name === "TimeoutError");
		throw new ApiError({
			code: aborted ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNREACHABLE",
			message: aborted
				? `Commertize API did not respond within ${config.requestTimeoutMs}ms (${url})`
				: `Commertize API is unreachable (${url}): ${
						err instanceof Error ? err.message : String(err)
					}`,
			retryable: true,
			sourceUrl: url,
		});
	} finally {
		clearTimeout(timer);
	}
};

/**
 * GET a JSON path from the public API.
 *
 * @param path Absolute path beginning with "/", e.g. "/api/listings".
 */
export const getJson = async <T>(path: string): Promise<ApiResult<T>> => {
	const url = `${config.apiBaseUrl}${path}`;
	const cached = cache.get(url);

	if (cached && Date.now() - cached.fetchedAt < config.cacheTtlMs) {
		return {
			body: cached.body as T,
			fetchedAt: new Date(cached.fetchedAt),
			cache: { hit: true, age_seconds: ageSeconds(cached.fetchedAt), stale: false },
			sourceUrl: url,
		};
	}

	let pending = inFlight.get(url);
	if (!pending) {
		pending = fetchFresh(url);
		inFlight.set(url, pending);
		// Detach cleanup from the caller's error path so a rejection here is
		// never an unhandled rejection.
		pending.finally(() => inFlight.delete(url)).catch(() => {});
	}

	try {
		const entry = await pending;
		cache.set(url, entry);
		return {
			body: entry.body as T,
			fetchedAt: new Date(entry.fetchedAt),
			cache: { hit: false, age_seconds: 0, stale: false },
			sourceUrl: url,
		};
	} catch (err) {
		// API is down. A stale-but-labelled body beats nothing, up to a bound.
		if (cached && Date.now() - cached.fetchedAt < config.staleMaxMs) {
			return {
				body: cached.body as T,
				fetchedAt: new Date(cached.fetchedAt),
				cache: {
					hit: true,
					age_seconds: ageSeconds(cached.fetchedAt),
					stale: true,
				},
				sourceUrl: url,
			};
		}
		throw err;
	}
};

/**
 * POST a JSON body to the public API with the agent credential.
 *
 * NOT cached, not de-duplicated and not retried: this is the only write in the
 * server, and every one of those behaviours would either hide a failure or file
 * a request twice. A `2xx` returns the parsed body; anything else raises the
 * same typed `ApiError` the reads use, so the caller's error handling is one
 * shape.
 */
/**
 * A GET that carries a credential, and therefore MUST NOT be cached.
 *
 * ── THE REASON, STATED BECAUSE IT IS THE WHOLE POINT ──────────────────────
 *
 * `getJson`'s cache and its in-flight de-duplication map are keyed on the URL
 * ALONE. That is correct for public, unauthenticated reads, where every caller
 * gets the same bytes. It is a cross-credential data leak for anything else:
 * two agents reading `/api/agents/sandbox/account` request the same URL and
 * would be served each other's ledger, and the second one would not even reach
 * the network to find out.
 *
 * So this is a separate function rather than a `credential` parameter on
 * `getJson`. A parameter would put a caching decision one argument away from a
 * mistake; a separate function has no cache to reach.
 *
 * Also not retried and not de-duplicated, for the same reasons as `postJson`.
 */
export const getJsonAs = async <T>(
	path: string,
	agentKey: string
): Promise<ApiResult<T>> => {
	const url = `${config.apiBaseUrl}${path}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);

	try {
		const res = await fetch(url, {
			signal: controller.signal,
			headers: {
				accept: "application/json",
				"user-agent": config.userAgent,
				"x-agent-key": agentKey,
			},
		});

		let parsed: unknown = null;
		try {
			parsed = await res.json();
		} catch {
			parsed = null;
		}

		if (!res.ok) {
			const detail =
				parsed && typeof parsed === "object" && "error" in parsed
					? String((parsed as { error: unknown }).error)
					: `HTTP ${res.status}`;
			throw new ApiError({
				code: "UPSTREAM_ERROR",
				message: `Commertize API refused the request: ${detail}`,
				retryable: res.status >= 500 || res.status === 429,
				status: res.status,
				sourceUrl: url,
			});
		}
		if (parsed === null) {
			throw new ApiError({
				code: "UPSTREAM_BAD_BODY",
				message: `Commertize API returned a body that is not valid JSON for ${url}`,
				retryable: true,
				status: res.status,
				sourceUrl: url,
			});
		}

		return {
			body: parsed as T,
			fetchedAt: new Date(),
			// Never cached, so this is not a claim that could be wrong.
			cache: { hit: false, age_seconds: 0, stale: false },
			sourceUrl: url,
		};
	} catch (err) {
		if (err instanceof ApiError) throw err;
		const aborted =
			err instanceof Error &&
			(err.name === "AbortError" || err.name === "TimeoutError");
		throw new ApiError({
			code: aborted ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNREACHABLE",
			message: aborted
				? `Commertize API did not respond within ${config.requestTimeoutMs}ms (${url})`
				: `Commertize API is unreachable (${url}): ${
						err instanceof Error ? err.message : String(err)
					}`,
			retryable: true,
			sourceUrl: url,
		});
	} finally {
		clearTimeout(timer);
	}
};

/**
 * An uncached GET that returns the RESPONSE rather than throwing on it.
 *
 * ── WHY A NON-THROWING VARIANT EXISTS ─────────────────────────────────────
 *
 * On the x402 rail the interesting responses are the ones `getJson` would turn
 * into an `ApiError`: a 402 carries the payment requirements a caller needs in
 * order to pay, a 403 carries a screening refusal, a 409 says a settlement has
 * already been spent. Those are ANSWERS, not failures, and converting them to
 * exceptions would throw away the body that is the whole point of the call.
 *
 * Uncached for the same reason as `getJsonAs`: a payment-bearing request is
 * unique to its payer, and the shared cache is keyed on URL alone.
 *
 * Transport failures still raise `ApiError`, so a caller's handling of "the API
 * is unreachable" stays one shape.
 */
export const getRaw = async (
	path: string,
	headers: Record<string, string> = {}
): Promise<{
	status: number;
	body: unknown;
	text: string;
	contentType: string;
	sourceUrl: string;
}> => {
	const url = `${config.apiBaseUrl}${path}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);

	try {
		const res = await fetch(url, {
			signal: controller.signal,
			headers: {
				accept: "application/json, text/plain",
				"user-agent": config.userAgent,
				...headers,
			},
		});
		const text = await res.text();
		let body: unknown = null;
		try {
			body = JSON.parse(text);
		} catch {
			body = null;
		}
		return {
			status: res.status,
			body,
			text,
			contentType: res.headers.get("content-type") ?? "",
			sourceUrl: url,
		};
	} catch (err) {
		const aborted =
			err instanceof Error &&
			(err.name === "AbortError" || err.name === "TimeoutError");
		throw new ApiError({
			code: aborted ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNREACHABLE",
			message: aborted
				? `Commertize API did not respond within ${config.requestTimeoutMs}ms (${url})`
				: `Commertize API is unreachable (${url}): ${
						err instanceof Error ? err.message : String(err)
					}`,
			retryable: true,
			sourceUrl: url,
		});
	} finally {
		clearTimeout(timer);
	}
};

/**
 * POST to a PUBLIC route: no credential header at all.
 *
 * A separate function rather than an optional `agentKey` on `postJson`, for
 * the same reason `getJsonAs` is separate from `getJson`: a parameter that
 * can be omitted is a credential that can be omitted by mistake, and the two
 * routes this server writes to have opposite requirements (the memo route
 * demands a key; `/contact` must never be sent one). Same error mapping as
 * `postJson`; a 4xx body's `details` (the API's field-level validation
 * output) is carried into the message, bounded, so a client can see WHICH
 * field was refused without this server guessing.
 */
export const postPublicJson = async <T>(
	path: string,
	body: unknown
): Promise<{ body: T; sentAt: Date; sourceUrl: string }> => {
	const url = `${config.apiBaseUrl}${path}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);

	try {
		const res = await fetch(url, {
			method: "POST",
			signal: controller.signal,
			headers: {
				accept: "application/json",
				"content-type": "application/json",
				"user-agent": config.userAgent,
			},
			body: JSON.stringify(body),
		});

		let parsed: unknown = null;
		try {
			parsed = await res.json();
		} catch {
			parsed = null;
		}

		if (!res.ok) {
			const obj =
				parsed && typeof parsed === "object"
					? (parsed as { error?: unknown; details?: unknown })
					: null;
			const detail = obj && "error" in obj ? String(obj.error) : `HTTP ${res.status}`;
			const fields =
				obj && obj.details !== undefined
					? ` Details: ${JSON.stringify(obj.details).slice(0, 500)}`
					: "";
			const retryAfter = res.headers.get("retry-after");
			throw new ApiError({
				code: "UPSTREAM_ERROR",
				message: `Commertize API refused the request: ${detail}.${fields}${
					res.status === 429 && retryAfter ? ` Retry after ${retryAfter}s.` : ""
				}`,
				retryable: res.status >= 500 || res.status === 429,
				status: res.status,
				sourceUrl: url,
			});
		}

		if (parsed === null) {
			throw new ApiError({
				code: "UPSTREAM_BAD_BODY",
				message: `Commertize API returned a body that is not valid JSON for ${url}`,
				retryable: true,
				status: res.status,
				sourceUrl: url,
			});
		}

		return { body: parsed as T, sentAt: new Date(), sourceUrl: url };
	} catch (err) {
		if (err instanceof ApiError) throw err;
		const aborted =
			err instanceof Error &&
			(err.name === "AbortError" || err.name === "TimeoutError");
		throw new ApiError({
			code: aborted ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNREACHABLE",
			message: aborted
				? `Commertize API did not respond within ${config.requestTimeoutMs}ms (${url})`
				: `Commertize API is unreachable (${url}): ${
						err instanceof Error ? err.message : String(err)
					}`,
			retryable: true,
			sourceUrl: url,
		});
	} finally {
		clearTimeout(timer);
	}
};

export const postJson = async <T>(
	path: string,
	body: unknown,
	agentKey: string
): Promise<{ body: T; sentAt: Date; sourceUrl: string }> => {
	const url = `${config.apiBaseUrl}${path}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);

	try {
		const res = await fetch(url, {
			method: "POST",
			signal: controller.signal,
			headers: {
				accept: "application/json",
				"content-type": "application/json",
				"user-agent": config.userAgent,
				"x-agent-key": agentKey,
			},
			body: JSON.stringify(body),
		});

		let parsed: unknown = null;
		try {
			parsed = await res.json();
		} catch {
			parsed = null;
		}

		if (!res.ok) {
			const detail =
				parsed && typeof parsed === "object" && "error" in parsed
					? String((parsed as { error: unknown }).error)
					: `HTTP ${res.status}`;
			throw new ApiError({
				code: "UPSTREAM_ERROR",
				message: `Commertize API refused the request: ${detail}`,
				// A 4xx is our request being wrong; retrying it unchanged files
				// nothing. 429 is the exception — the call was fine, the timing
				// was not.
				retryable: res.status >= 500 || res.status === 429,
				status: res.status,
				sourceUrl: url,
			});
		}

		if (parsed === null) {
			throw new ApiError({
				code: "UPSTREAM_BAD_BODY",
				message: `Commertize API returned a body that is not valid JSON for ${url}`,
				retryable: true,
				status: res.status,
				sourceUrl: url,
			});
		}

		return { body: parsed as T, sentAt: new Date(), sourceUrl: url };
	} catch (err) {
		if (err instanceof ApiError) throw err;
		const aborted =
			err instanceof Error &&
			(err.name === "AbortError" || err.name === "TimeoutError");
		throw new ApiError({
			code: aborted ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNREACHABLE",
			message: aborted
				? `Commertize API did not respond within ${config.requestTimeoutMs}ms (${url})`
				: `Commertize API is unreachable (${url}): ${
						err instanceof Error ? err.message : String(err)
					}`,
			retryable: true,
			sourceUrl: url,
		});
	} finally {
		clearTimeout(timer);
	}
};
