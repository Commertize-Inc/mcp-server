/**
 * Fixed-window counter, per id, in memory.
 *
 * ── Scope, stated so nobody over-reads it ─────────────────────────────────
 * This limiter lives in ONE process. On a serverless platform every warm
 * instance keeps its own window, so the effective ceiling is `max` times the
 * number of instances that happen to serve a key. It is a per-key courtesy
 * ceiling and an abuse brake, not an accounting system. The limits that
 * actually bound cost sit upstream: the API's own per-IP limiter on
 * `/contact` (5 per hour) and on the public reads (120 per minute).
 *
 * The window is fixed, not sliding: `max` calls in a window, then 429 with a
 * `Retry-After` for the seconds left in it. Fixed windows admit up to `2*max`
 * across a boundary; that is accepted for the simplicity of one Map and no
 * timers.
 */

export interface LimitVerdict {
	allowed: boolean;
	remaining: number;
	retryAfterSeconds: number;
}

export class FixedWindowLimiter {
	private readonly hits = new Map<string, { count: number; start: number }>();
	private lastSweep = 0;

	constructor(
		readonly max: number,
		readonly windowMs: number,
		private readonly now: () => number = Date.now
	) {
		if (!(max > 0) || !(windowMs > 0)) {
			throw new Error("FixedWindowLimiter: max and windowMs must be positive");
		}
	}

	hit(id: string): LimitVerdict {
		const t = this.now();
		this.sweep(t);
		const cur = this.hits.get(id);
		if (!cur || t - cur.start >= this.windowMs) {
			this.hits.set(id, { count: 1, start: t });
			return { allowed: true, remaining: this.max - 1, retryAfterSeconds: 0 };
		}
		if (cur.count >= this.max) {
			const left = cur.start + this.windowMs - t;
			return {
				allowed: false,
				remaining: 0,
				retryAfterSeconds: Math.max(1, Math.ceil(left / 1000)),
			};
		}
		cur.count += 1;
		return {
			allowed: true,
			remaining: this.max - cur.count,
			retryAfterSeconds: 0,
		};
	}

	/** Drop expired windows, at most once per window, so the Map stays bounded. */
	private sweep(t: number): void {
		if (t - this.lastSweep < this.windowMs) return;
		this.lastSweep = t;
		for (const [id, w] of this.hits) {
			if (t - w.start >= this.windowMs) this.hits.delete(id);
		}
	}

	/** Test seam. */
	reset(): void {
		this.hits.clear();
		this.lastSweep = 0;
	}
}
