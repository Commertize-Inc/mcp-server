/**
 * Read-only Chainlink Data Feed tools.
 *
 *   get_chainlink_feed          one pinned feed on one network, plus the sequencer
 *   get_chainlink_feed_health   every pinned feed on one network, plus the sequencer
 *
 * NOT REGISTERED unless `COMMERTIZE_MCP_ENABLE_CHAINLINK_FEEDS=1` (exact
 * string), and never over the HTTP surface (not in `HTTP_TOOL_ALLOWLIST`).
 * The default is closed because the public strings below are awaiting the
 * certified wording, not because the reads carry risk: they touch public
 * contracts only, through public RPCs, with no key and no transaction.
 *
 * Every public string a client can see lives in `CHAINLINK_STRINGS`, so the
 * certification handoff, the language test and the code read one table.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
	CHAIN_PINS,
	type ChainKey,
	type FeedKey,
	FeedReadError,
	findFeed,
	readChain,
} from "./chainlinkFeeds.js";
import { config } from "./config.js";
import { refuse, toResult } from "./envelope.js";
import { DISCLAIMER } from "./disclaimer.js";
import { envelopeShape } from "./schemas.js";

export const CHAINLINK_TOOL_NAMES = [
	"get_chainlink_feed",
	"get_chainlink_feed_health",
] as const;

/** Pending certification. Change a string here and the handoff id changes. */
export const CHAINLINK_STRINGS = {
	feedTitle: "Read one public Chainlink Data Feed",
	feedDescription:
		"Read the latest round of one public Chainlink Data Feed (USDC/USD, ETH/USD or LINK/USD) on Arbitrum One or Base, directly from the chain through a public RPC endpoint. Read-only: no key, no signature, no transaction. Returns the raw answer, its decimals, the update time, a freshness check against the feed's published heartbeat, and the network's L2 sequencer status. ETH/USD is available on Arbitrum One only.",
	healthTitle: "Check every pinned Chainlink Data Feed on one network",
	healthDescription:
		"Check each pinned public Chainlink Data Feed on Arbitrum One or Base in one read: freshness against the published heartbeat, a zero or negative answer, decimals against the pinned value, and the L2 sequencer uptime feed with a one-hour grace period after a restart. Read-only: no key, no signature, no transaction. Reports what the chain returned at one block; it is not a price quote or a recommendation.",
	feedNote:
		"These are Chainlink's public Data Feeds. Commertize does not operate or publish them, and this reading says nothing about any Commertize offering.",
} as const;

const chainEnum = z.enum(["arbitrum-one", "base"]);
const feedEnum = z.enum(["usdc-usd", "eth-usd", "link-usd"]);

const feedReadingShape = z.object({
	feed: z.string(),
	description: z.string(),
	proxy: z.string(),
	status: z.string().describe(
		"OK, STALE, NON_POSITIVE_ANSWER, INCOMPLETE_ROUND, FUTURE_TIMESTAMP or DECIMALS_MISMATCH."
	),
	answer_raw: z.string().describe("The integer answer exactly as returned on chain."),
	answer: z.string().describe("answer_raw scaled by decimals, as an exact decimal string."),
	decimals: z.number(),
	round_id: z.string(),
	updated_at: z.string().nullable(),
	age_seconds: z.number().nullable().describe("Block timestamp minus updated_at."),
	heartbeat_seconds: z.number(),
	healthy: z
		.boolean()
		.describe("True only when status is OK and the sequencer status is UP."),
});

const sequencerShape = z.object({
	proxy: z.string(),
	status: z.string().describe("UP, DOWN, GRACE_PERIOD or UNKNOWN."),
	status_since: z.string().nullable(),
	seconds_in_status: z.number().nullable(),
	grace_period_seconds: z.number(),
});

const outputShape = {
	...envelopeShape,
	chain: z.string().nullable(),
	chain_id: z.number().nullable(),
	block_number: z.string().nullable(),
	block_timestamp: z.string().nullable(),
	sequencer: sequencerShape.nullable(),
	feeds: z.array(feedReadingShape),
	feed_note: z.string(),
};

const empty = {
	chain: null,
	chain_id: null,
	block_number: null,
	block_timestamp: null,
	sequencer: null,
	feeds: [],
	feed_note: CHAINLINK_STRINGS.feedNote,
};

const NO_FETCH_CACHE = { hit: false, age_seconds: 0, stale: false } as const;

const rpcFor = (chain: ChainKey) => ({
	url: chain === "base" ? config.baseRpcUrl : config.arbitrumRpcUrl,
	timeoutMs: config.requestTimeoutMs,
});

const run = async (chain: ChainKey, feeds: FeedKey[] | "all") => {
	const opts = rpcFor(chain);
	const pins =
		feeds === "all"
			? CHAIN_PINS[chain].feeds
			: feeds.map((f) => findFeed(chain, f)!).filter(Boolean);
	try {
		const snap = await readChain(chain, pins, opts);
		return toResult({
			...snap,
			feed_note: CHAINLINK_STRINGS.feedNote,
			as_of: new Date().toISOString(),
			source_url: opts.url,
			cache: NO_FETCH_CACHE,
			disclaimer: DISCLAIMER,
			error: null,
		});
	} catch (err) {
		const fe = err instanceof FeedReadError ? err : null;
		return toResult(
			{
				...empty,
				as_of: new Date().toISOString(),
				source_url: opts.url,
				cache: NO_FETCH_CACHE,
				disclaimer: DISCLAIMER,
				error: {
					code: fe?.code ?? "INTERNAL_ERROR",
					message: fe
						? fe.message
						: `Unexpected failure: ${err instanceof Error ? err.message : String(err)}`,
					retryable: fe ? fe.code === "RPC_UNREACHABLE" || fe.code === "RPC_ERROR" : false,
				},
			},
			true
		);
	}
};

export const registerChainlinkTools = (server: McpServer): void => {
	if (config.chainlinkFeedsDisabled) return;

	server.registerTool(
		"get_chainlink_feed",
		{
			title: CHAINLINK_STRINGS.feedTitle,
			description: CHAINLINK_STRINGS.feedDescription,
			inputSchema: { chain: chainEnum, feed: feedEnum },
			outputSchema: outputShape,
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ chain, feed }) => {
			if (!findFeed(chain, feed)) {
				return refuse(
					"INVALID_ARGUMENT",
					`${feed} is not pinned on ${CHAIN_PINS[chain].label}.`,
					rpcFor(chain).url,
					empty
				);
			}
			return run(chain, [feed]);
		}
	);

	server.registerTool(
		"get_chainlink_feed_health",
		{
			title: CHAINLINK_STRINGS.healthTitle,
			description: CHAINLINK_STRINGS.healthDescription,
			inputSchema: { chain: chainEnum },
			outputSchema: outputShape,
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ chain }) => run(chain, "all")
	);
};
