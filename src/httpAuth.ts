/**
 * Bearer-key authentication for the HTTP transport.
 *
 * The key format mirrors the backend's agent-platform keys EXACTLY
 * (`apps/backend/src/agentPlatform/keys.ts`): `cfa_<16 hex>_<43 base64url>`.
 * The shape check is anchored and exact-length, so a string that is not a key
 * we minted is refused here and costs no upstream call.
 *
 * Whether a well-formed key is LIVE is not this server's knowledge. It has no
 * database; the backend does. So the verdict comes from an introspection
 * route on the API, with one rule: only a 200 whose body names the same key
 * id is a yes. 401/403 is a no. Anything else — a 5xx, a timeout, a non-JSON
 * body, a 200 for a different key — is "cannot verify", and the request is
 * refused with 503 rather than let through. A verifier that is down must
 * never look like a verifier that said yes.
 *
 * The introspection route is itself guarded by a service secret
 * (`x-commertize-introspect-secret`, env COMMERTIZE_MCP_INTROSPECT_SECRET).
 * Without it this server cannot ask, so it refuses every call with 503 and
 * makes NO upstream request. A 403 whose body says `caller_unauthorized` is
 * the route telling us OUR secret is wrong: that is a 503 to the client
 * ("cannot verify"), never "your key is bad".
 *
 * Caching, both directions, keyed by SHA-256 of the key (never the key):
 *   - positive verdicts for at most `MAX_POSITIVE_CACHE_MS` (15 s) — the
 *     option is clamped, an environment cannot raise it — and never past the
 *     `expires_at` the route reported. A revoked key therefore keeps working
 *     for at most 15 s;
 *   - negative verdicts (401/403) for `negativeCacheMs`, so a flood of the
 *     same bad key costs ONE upstream call per window, not one per request.
 *     A positive entry never outlives its TTL, so a revocation
 *     is honoured at the first re-check, at most 15 s away, and then cached
 *     negatively.
 *
 * The key never appears in a log line, an error message or a thrown error:
 * every message below carries the key id (the public half) at most.
 */

import { createHash } from "node:crypto";

/** Same regex as the backend's `parseAgentPlatformKeyId`. Keep them equal. */
export const AGENT_KEY_RX = /^cfa_([0-9a-f]{16})_[A-Za-z0-9_-]{43}$/;

/** Hard ceiling on how long a verified key is trusted without re-checking. */
export const MAX_POSITIVE_CACHE_MS = 15_000;

/** Header the introspection route expects the service secret on. */
export const INTROSPECT_SECRET_HEADER = "x-commertize-introspect-secret";

export const parseBearer = (header: string | undefined): string | null => {
	if (!header) return null;
	const m = /^Bearer[ \t]+([^\s]+)[ \t]*$/i.exec(header);
	return m?.[1] ?? null;
};

export const parseKeyId = (presented: string): string | null => {
	const m = AGENT_KEY_RX.exec(presented);
	return m?.[1] ?? null;
};

export type RefusalCode =
	| "missing_credential"
	| "malformed_credential"
	| "invalid_credential"
	| "verifier_unavailable"
	| "verifier_not_configured";

export type Verdict =
	| { ok: true; keyId: string; cached: boolean }
	| { ok: false; status: 401 | 503; code: RefusalCode; message: string; cached: boolean };

export interface KeyVerifierOptions {
	/** Absolute URL of the introspection route. */
	introspectUrl: string;
	/**
	 * Service secret for the route. `null` = not configured = every verify is
	 * a 503 with no upstream call.
	 */
	serviceSecret: string | null;
	/** Positive-verdict TTL; clamped to MAX_POSITIVE_CACHE_MS. */
	cacheMs: number;
	/** Negative-verdict (401/403) TTL. 0 disables the negative cache. */
	negativeCacheMs: number;
	timeoutMs: number;
	userAgent: string;
	/** Injected for tests; defaults to the global fetch. */
	fetchImpl?: typeof fetch;
	now?: () => number;
}

const REFUSALS: Record<RefusalCode, { status: 401 | 503; message: string }> = {
	missing_credential: {
		status: 401,
		message: "Send an agent key as `Authorization: Bearer <key>`.",
	},
	malformed_credential: {
		status: 401,
		message: "The credential is not a Commertize agent key.",
	},
	invalid_credential: {
		status: 401,
		message: "The agent key is not valid for this server.",
	},
	verifier_unavailable: {
		status: 503,
		message:
			"The key could not be verified right now. Nothing was done; retry later.",
	},
	verifier_not_configured: {
		status: 503,
		message:
			"This server cannot verify keys right now. Nothing was done; retry later.",
	},
};

const refusal = (code: RefusalCode, cached = false): Verdict => ({
	ok: false,
	status: REFUSALS[code].status,
	code,
	message: REFUSALS[code].message,
	cached,
});

const digest = (s: string): string =>
	createHash("sha256").update(s, "utf8").digest("hex");

/** `expires_at` as epoch ms, or null when absent/unparsable. */
const expiryOf = (body: Record<string, unknown>): number | null => {
	const raw = body.expires_at;
	if (typeof raw !== "string") return null;
	const t = Date.parse(raw);
	return Number.isFinite(t) ? t : null;
};

export class KeyVerifier {
	private readonly positive = new Map<string, { keyId: string; until: number }>();
	private readonly negative = new Map<string, { until: number }>();
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;
	private readonly positiveMs: number;
	private readonly negativeMs: number;
	/** Counts, for the health endpoint and tests. Never key material. */
	readonly stats = { introspections: 0, cacheHits: 0, negativeHits: 0 };

	constructor(private readonly opts: KeyVerifierOptions) {
		this.fetchImpl = opts.fetchImpl ?? fetch;
		this.now = opts.now ?? Date.now;
		this.positiveMs = Math.max(0, Math.min(opts.cacheMs, MAX_POSITIVE_CACHE_MS));
		this.negativeMs = Math.max(0, opts.negativeCacheMs);
	}

	/** True when the route can be asked at all. Exposed on /health. */
	get configured(): boolean {
		return typeof this.opts.serviceSecret === "string" && this.opts.serviceSecret.length > 0;
	}

	/** Test seam: forget every cached verdict. */
	clear(): void {
		this.positive.clear();
		this.negative.clear();
	}

	/**
	 * Would `verify` answer from cache without an upstream call? The handler
	 * uses this to decide whether a request must pass the per-IP verification
	 * brake: cached answers cost nothing and are not braked.
	 */
	isCached(presented: string | null): boolean {
		if (!presented || !parseKeyId(presented)) return true; // refused locally
		const h = digest(presented);
		const t = this.now();
		const p = this.positive.get(h);
		if (p && p.until > t) return true;
		const n = this.negative.get(h);
		return !!n && n.until > t;
	}

	async verify(presented: string | null): Promise<Verdict> {
		if (!presented) return refusal("missing_credential");
		const keyId = parseKeyId(presented);
		if (!keyId) return refusal("malformed_credential");

		const h = digest(presented);
		const now = this.now();
		const hit = this.positive.get(h);
		if (hit && hit.until > now) {
			this.stats.cacheHits += 1;
			return { ok: true, keyId: hit.keyId, cached: true };
		}
		this.positive.delete(h);
		const miss = this.negative.get(h);
		if (miss && miss.until > now) {
			this.stats.negativeHits += 1;
			return refusal("invalid_credential", true);
		}
		this.negative.delete(h);

		if (!this.configured) return refusal("verifier_not_configured");

		this.stats.introspections += 1;
		let res: Response;
		try {
			res = await this.fetchImpl(this.opts.introspectUrl, {
				method: "GET",
				headers: {
					authorization: `Bearer ${presented}`,
					accept: "application/json",
					"user-agent": this.opts.userAgent,
					[INTROSPECT_SECRET_HEADER]: this.opts.serviceSecret as string,
				},
				signal: AbortSignal.timeout(this.opts.timeoutMs),
			});
		} catch {
			return refusal("verifier_unavailable");
		}

		if (res.status === 401 || res.status === 403) {
			// The route refusing US (wrong service secret) is not a verdict on
			// the key. Read the code; anything else is a no for the key.
			let code: unknown = null;
			try {
				const b: unknown = await res.json();
				code = b && typeof b === "object" && "code" in b ? (b as { code: unknown }).code : null;
			} catch {
				code = null;
			}
			if (code === "caller_unauthorized") return refusal("verifier_unavailable");
			if (this.negativeMs > 0) this.negative.set(h, { until: now + this.negativeMs });
			return refusal("invalid_credential");
		}
		if (res.status !== 200) return refusal("verifier_unavailable");

		let body: unknown = null;
		try {
			body = await res.json();
		} catch {
			return refusal("verifier_unavailable");
		}
		const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
		const answered = obj && "key_id" in obj ? obj.key_id : null;
		// A 200 that does not name THIS key is not a yes. It is the signature
		// of a misconfigured URL (a route that 200s for everyone), and the
		// only safe reading of it is "cannot verify".
		if (!obj || answered !== keyId) return refusal("verifier_unavailable");

		// Trust for the TTL, but never past the expiry the route reported.
		let until = now + this.positiveMs;
		const exp = expiryOf(obj);
		if (exp !== null) until = Math.min(until, exp);
		if (until > now) this.positive.set(h, { keyId, until });
		return { ok: true, keyId, cached: false };
	}
}
