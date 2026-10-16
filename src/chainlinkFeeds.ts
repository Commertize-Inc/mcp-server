/**
 * Read-only access to public Chainlink Data Feeds on Arbitrum One and Base.
 *
 * ── WHAT THIS MODULE CAN DO, STRUCTURALLY ─────────────────────────────────
 * It sends exactly three JSON-RPC methods: `eth_chainId`, `eth_getBlockByNumber`
 * and `eth_call`. There is no key, no signer, no `eth_sendRawTransaction`, and
 * no dependency that could hold one. `ALLOWED_RPC_METHODS` is the list, and
 * `rpc()` refuses anything else before a byte leaves the process; the e2e test
 * asserts the stub upstream saw nothing outside it.
 *
 * ── WHAT IT PINS, AND WHY PINS RATHER THAN A LOOKUP ───────────────────────
 * Proxy addresses, decimals and heartbeats are pinned here from Chainlink's
 * reference data directory (fetched 2026-10-16 19:38 UTC) and checked against
 * an on-chain `decimals()` / `latestRoundData()` read the same minute. A caller
 * cannot pass an address: a tool that reads "any aggregator you name" would
 * report an attacker's contract in the same shape as Chainlink's. Only the
 * standard paths are pinned. SVR variants exist for liquidation MEV recapture
 * and are not what a price check should read; Base's directory lists ETH/USD
 * only as SVR variants today, so ETH/USD is not pinned on Base.
 *
 * ── FAIL-CLOSED ───────────────────────────────────────────────────────────
 *  - The RPC's `eth_chainId` must equal the pinned chain id, or nothing is read.
 *  - The on-chain `decimals()` must equal the pin, or the feed reports
 *    DECIMALS_MISMATCH and `healthy: false`.
 *  - "Now" is the latest block's timestamp, not this machine's clock.
 *  - A price feed on an L2 is healthy only if the sequencer feed reports up
 *    and has been up for at least SEQUENCER_GRACE_SECONDS.
 *  - All arithmetic is bigint. No float touches an answer.
 */

export type ChainKey = "arbitrum-one" | "base";
export type FeedKey = "usdc-usd" | "eth-usd" | "link-usd";

export interface FeedPin {
	readonly feed: FeedKey;
	readonly description: string;
	readonly proxy: `0x${string}`;
	readonly decimals: number;
	/** Seconds, from the directory's `heartbeat` field. */
	readonly heartbeatSeconds: number;
}

export interface ChainPin {
	readonly chain: ChainKey;
	readonly chainId: bigint;
	readonly label: string;
	readonly defaultRpcUrl: string;
	readonly sequencerProxy: `0x${string}`;
	readonly feeds: readonly FeedPin[];
}

export const CHAIN_PINS: Readonly<Record<ChainKey, ChainPin>> = {
	"arbitrum-one": {
		chain: "arbitrum-one",
		chainId: 42161n,
		label: "Arbitrum One",
		defaultRpcUrl: "https://arb1.arbitrum.io/rpc",
		sequencerProxy: "0xFdB631F5EE196F0ed6FAa767959853A9F217697D",
		feeds: [
			{
				feed: "usdc-usd",
				description: "USDC / USD",
				proxy: "0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3",
				decimals: 8,
				heartbeatSeconds: 255,
			},
			{
				feed: "eth-usd",
				description: "ETH / USD",
				proxy: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
				decimals: 8,
				heartbeatSeconds: 1755,
			},
			{
				feed: "link-usd",
				description: "LINK / USD",
				proxy: "0x86E53CF1B870786351Da77A57575e79CB55812CB",
				decimals: 8,
				heartbeatSeconds: 1755,
			},
		],
	},
	base: {
		chain: "base",
		chainId: 8453n,
		label: "Base",
		defaultRpcUrl: "https://mainnet.base.org",
		sequencerProxy: "0xBCF85224fc0756B9Fa45aA7892530B47e10b6433",
		feeds: [
			{
				feed: "usdc-usd",
				description: "USDC / USD",
				proxy: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
				decimals: 8,
				heartbeatSeconds: 86400,
			},
			{
				feed: "link-usd",
				description: "LINK / USD",
				proxy: "0x17CAb8FE31E32f08326e5E27412894e49B0f9D65",
				decimals: 8,
				heartbeatSeconds: 86400,
			},
		],
	},
};

/** Chainlink's L2 sequencer guidance: distrust prices for a period after a restart. */
export const SEQUENCER_GRACE_SECONDS = 3600n;

export const ALLOWED_RPC_METHODS: ReadonlySet<string> = new Set([
	"eth_chainId",
	"eth_getBlockByNumber",
	"eth_call",
]);

/** `decimals()` and `latestRoundData()` selectors. */
export const SELECTOR_DECIMALS = "0x313ce567";
export const SELECTOR_LATEST_ROUND_DATA = "0xfeaf968c";

export const findFeed = (chain: ChainKey, feed: FeedKey): FeedPin | undefined =>
	CHAIN_PINS[chain].feeds.find((f) => f.feed === feed);

// ── Pure decoding ──────────────────────────────────────────────────────────

const WORD_HEX = 64;
const TWO_256 = 1n << 256n;
const TWO_255 = 1n << 255n;

const words = (hex: string, count: number): bigint[] => {
	const body = hex.startsWith("0x") ? hex.slice(2) : hex;
	if (!/^[0-9a-fA-F]*$/.test(body) || body.length < count * WORD_HEX) {
		throw new FeedReadError(
			"BAD_RESPONSE",
			`Expected ${count} ABI words, got ${body.length} hex characters.`
		);
	}
	const out: bigint[] = [];
	for (let i = 0; i < count; i++) {
		out.push(BigInt(`0x${body.slice(i * WORD_HEX, (i + 1) * WORD_HEX)}`));
	}
	return out;
};

export interface RoundData {
	roundId: bigint;
	/** int256, sign-decoded. */
	answer: bigint;
	startedAt: bigint;
	updatedAt: bigint;
	answeredInRound: bigint;
}

/** `words()` has already length-checked; this only satisfies the index type. */
const at = (w: bigint[], i: number): bigint => {
	const v = w[i];
	if (v === undefined) throw new FeedReadError("BAD_RESPONSE", `Missing ABI word ${i}.`);
	return v;
};

export const decodeLatestRoundData = (hex: string): RoundData => {
	const w = words(hex, 5);
	const rawAnswer = at(w, 1);
	const answer = rawAnswer >= TWO_255 ? rawAnswer - TWO_256 : rawAnswer;
	return {
		roundId: at(w, 0),
		answer,
		startedAt: at(w, 2),
		updatedAt: at(w, 3),
		answeredInRound: at(w, 4),
	};
};

export const decodeUint = (hex: string): bigint => at(words(hex, 1), 0);

/** Exact decimal rendering of `raw / 10^decimals`. Never a float. */
export const formatFixed = (raw: bigint, decimals: number): string => {
	const negative = raw < 0n;
	const abs = negative ? -raw : raw;
	if (decimals === 0) return `${negative ? "-" : ""}${abs}`;
	const s = abs.toString().padStart(decimals + 1, "0");
	const whole = s.slice(0, s.length - decimals);
	const frac = s.slice(s.length - decimals);
	return `${negative ? "-" : ""}${whole}.${frac}`;
};

// ── Pure evaluation ────────────────────────────────────────────────────────

export type FeedStatus =
	| "OK"
	| "STALE"
	| "NON_POSITIVE_ANSWER"
	| "INCOMPLETE_ROUND"
	| "FUTURE_TIMESTAMP"
	| "DECIMALS_MISMATCH";

/**
 * One status, first failing rule wins, in this order: decimals, incomplete,
 * non-positive, future, stale. A stale feed with a wrong decimals value reports
 * the decimals problem, because that one makes every number in the row wrong.
 */
export const evaluateFeed = (
	pin: FeedPin,
	onChainDecimals: bigint,
	round: RoundData,
	nowSeconds: bigint
): { status: FeedStatus; ageSeconds: bigint | null } => {
	if (onChainDecimals !== BigInt(pin.decimals)) {
		return { status: "DECIMALS_MISMATCH", ageSeconds: null };
	}
	if (round.updatedAt === 0n) return { status: "INCOMPLETE_ROUND", ageSeconds: null };
	if (round.answer <= 0n) {
		return { status: "NON_POSITIVE_ANSWER", ageSeconds: nowSeconds - round.updatedAt };
	}
	if (round.updatedAt > nowSeconds) {
		return { status: "FUTURE_TIMESTAMP", ageSeconds: nowSeconds - round.updatedAt };
	}
	const age = nowSeconds - round.updatedAt;
	if (age > BigInt(pin.heartbeatSeconds)) return { status: "STALE", ageSeconds: age };
	return { status: "OK", ageSeconds: age };
};

export type SequencerStatus = "UP" | "DOWN" | "GRACE_PERIOD" | "UNKNOWN";

/**
 * answer 0 = up, 1 = down; `startedAt` is when that status began. A startedAt
 * of 0 is an uninitialised round (Chainlink's L2 sequencer guidance) and reads
 * UNKNOWN, as does any answer other than 0 or 1. Only UP is healthy.
 */
export const evaluateSequencer = (
	round: RoundData,
	nowSeconds: bigint
): { status: SequencerStatus; sinceSeconds: bigint | null } => {
	if (round.startedAt === 0n) return { status: "UNKNOWN", sinceSeconds: null };
	const since = nowSeconds - round.startedAt;
	if (round.answer === 1n) return { status: "DOWN", sinceSeconds: since };
	if (round.answer !== 0n) return { status: "UNKNOWN", sinceSeconds: since };
	if (since < SEQUENCER_GRACE_SECONDS) return { status: "GRACE_PERIOD", sinceSeconds: since };
	return { status: "UP", sinceSeconds: since };
};

// ── RPC ────────────────────────────────────────────────────────────────────

export type FeedErrorCode =
	| "RPC_UNREACHABLE"
	| "RPC_ERROR"
	| "CHAIN_MISMATCH"
	| "BAD_RESPONSE"
	| "METHOD_REFUSED";

export class FeedReadError extends Error {
	constructor(
		readonly code: FeedErrorCode,
		message: string
	) {
		super(message);
	}
}

export interface RpcOptions {
	url: string;
	timeoutMs: number;
}

let rpcId = 0;

export const rpc = async (
	opts: RpcOptions,
	method: string,
	params: unknown[]
): Promise<unknown> => {
	if (!ALLOWED_RPC_METHODS.has(method)) {
		throw new FeedReadError("METHOD_REFUSED", `RPC method ${method} is not allowed.`);
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
	let res: Response;
	try {
		res = await fetch(opts.url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
			signal: controller.signal,
		});
	} catch (err) {
		throw new FeedReadError(
			"RPC_UNREACHABLE",
			`Could not reach the RPC endpoint: ${err instanceof Error ? err.message : String(err)}`
		);
	} finally {
		clearTimeout(timer);
	}
	if (!res.ok) throw new FeedReadError("RPC_ERROR", `RPC answered HTTP ${res.status}.`);
	let body: { result?: unknown; error?: { message?: string } };
	try {
		body = (await res.json()) as typeof body;
	} catch {
		throw new FeedReadError("BAD_RESPONSE", "RPC answered with a body that is not JSON.");
	}
	if (body.error) {
		throw new FeedReadError("RPC_ERROR", `RPC error: ${body.error.message ?? "unknown"}`);
	}
	if (body.result === undefined) {
		throw new FeedReadError("BAD_RESPONSE", "RPC answered with no result.");
	}
	return body.result;
};

const asHex = (v: unknown, what: string): string => {
	if (typeof v !== "string" || !/^0x[0-9a-fA-F]*$/.test(v)) {
		throw new FeedReadError("BAD_RESPONSE", `${what} is not a hex string.`);
	}
	return v;
};

const ethCall = async (opts: RpcOptions, to: string, data: string, block: string) =>
	asHex(await rpc(opts, "eth_call", [{ to, data }, block]), "eth_call result");

export interface FeedReading {
	feed: FeedKey;
	description: string;
	proxy: string;
	status: FeedStatus;
	answer_raw: string;
	answer: string;
	decimals: number;
	round_id: string;
	updated_at: string | null;
	age_seconds: number | null;
	heartbeat_seconds: number;
}

export interface SequencerReading {
	proxy: string;
	status: SequencerStatus;
	status_since: string | null;
	seconds_in_status: number | null;
	grace_period_seconds: number;
}

export interface ChainSnapshot {
	chain: ChainKey;
	chain_id: number;
	block_number: string;
	block_timestamp: string;
	sequencer: SequencerReading;
	feeds: Array<FeedReading & { healthy: boolean }>;
}

const iso = (seconds: bigint): string | null =>
	seconds > 0n ? new Date(Number(seconds) * 1000).toISOString() : null;

/**
 * One consistent read: chain id check, then every call pinned to the same block
 * number, so the sequencer status and the prices describe the same moment.
 */
export const readChain = async (
	chain: ChainKey,
	feeds: readonly FeedPin[],
	opts: RpcOptions
): Promise<ChainSnapshot> => {
	const pin = CHAIN_PINS[chain];
	const gotChainId = BigInt(asHex(await rpc(opts, "eth_chainId", []), "eth_chainId"));
	if (gotChainId !== pin.chainId) {
		throw new FeedReadError(
			"CHAIN_MISMATCH",
			`The RPC endpoint reports chain id ${gotChainId}; ${pin.label} is ${pin.chainId}. Nothing was read.`
		);
	}
	const block = (await rpc(opts, "eth_getBlockByNumber", ["latest", false])) as {
		number?: unknown;
		timestamp?: unknown;
	} | null;
	if (!block || typeof block !== "object") {
		throw new FeedReadError("BAD_RESPONSE", "RPC returned no latest block.");
	}
	const blockTag = asHex(block.number, "block number");
	const now = BigInt(asHex(block.timestamp, "block timestamp"));

	const seqRound = decodeLatestRoundData(
		await ethCall(opts, pin.sequencerProxy, SELECTOR_LATEST_ROUND_DATA, blockTag)
	);
	const seq = evaluateSequencer(seqRound, now);

	const readings: ChainSnapshot["feeds"] = [];
	for (const f of feeds) {
		const dec = decodeUint(await ethCall(opts, f.proxy, SELECTOR_DECIMALS, blockTag));
		const round = decodeLatestRoundData(
			await ethCall(opts, f.proxy, SELECTOR_LATEST_ROUND_DATA, blockTag)
		);
		const ev = evaluateFeed(f, dec, round, now);
		const answerDecimals = ev.status === "DECIMALS_MISMATCH" ? Number(dec) : f.decimals;
		readings.push({
			feed: f.feed,
			description: f.description,
			proxy: f.proxy,
			status: ev.status,
			answer_raw: round.answer.toString(),
			answer: formatFixed(round.answer, answerDecimals),
			decimals: answerDecimals,
			round_id: round.roundId.toString(),
			updated_at: iso(round.updatedAt),
			age_seconds: ev.ageSeconds === null ? null : Number(ev.ageSeconds),
			heartbeat_seconds: f.heartbeatSeconds,
			healthy: ev.status === "OK" && seq.status === "UP",
		});
	}

	return {
		chain,
		chain_id: Number(pin.chainId),
		block_number: BigInt(blockTag).toString(),
		block_timestamp: iso(now) ?? "",
		sequencer: {
			proxy: pin.sequencerProxy,
			status: seq.status,
			status_since: iso(seqRound.startedAt),
			seconds_in_status: seq.sinceSeconds === null ? null : Number(seq.sinceSeconds),
			grace_period_seconds: Number(SEQUENCER_GRACE_SECONDS),
		},
		feeds: readings,
	};
};
