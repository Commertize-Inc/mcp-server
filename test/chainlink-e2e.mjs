/**
 * Chainlink Data Feed tools: pure decoding/evaluation units, then a real stdio
 * client against a stub JSON-RPC upstream on loopback.
 *
 * Boundary values are tested on BOTH sides of every rule (heartbeat, grace
 * period), because a test at a value where the bug cannot manifest is not
 * coverage.
 */

import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { call, check, connect, section, summary, resetCounters } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const feeds = await import(path.resolve(HERE, "..", "dist", "chainlinkFeeds.js"));
const { HTTP_TOOL_ALLOWLIST } = await import(path.resolve(HERE, "..", "dist", "httpAllowlist.js"));

resetCounters();

const word = (v) => {
	let b = BigInt(v);
	if (b < 0n) b = (1n << 256n) + b;
	return b.toString(16).padStart(64, "0");
};
const roundHex = (r) =>
	"0x" + [r.roundId ?? 1n, r.answer, r.startedAt ?? 1n, r.updatedAt, r.roundId ?? 1n].map(word).join("");

/* ------------------------------------------------------------------ */
section("units: decoding");
{
	const r = feeds.decodeLatestRoundData(roundHex({ answer: 99985014n, updatedAt: 1792176721n }));
	check("positive int256 decodes", r.answer === 99985014n);
	check("updatedAt decodes", r.updatedAt === 1792176721n);
	const neg = feeds.decodeLatestRoundData(roundHex({ answer: -1n, updatedAt: 5n }));
	check("negative int256 decodes by two's complement", neg.answer === -1n);
	let threw = null;
	try {
		feeds.decodeLatestRoundData("0x1234");
	} catch (e) {
		threw = e.code;
	}
	check("short return data is BAD_RESPONSE", threw === "BAD_RESPONSE");
	check("formatFixed 8dp", feeds.formatFixed(99985014n, 8) === "0.99985014");
	check("formatFixed whole part", feeds.formatFixed(239520040586n, 8) === "2395.20040586");
	check("formatFixed negative", feeds.formatFixed(-1n, 8) === "-0.00000001");
	check("formatFixed 0 decimals", feeds.formatFixed(7n, 0) === "7");
}

section("units: evaluateFeed (heartbeat 255 s, both sides of the boundary)");
{
	const pin = feeds.findFeed("arbitrum-one", "usdc-usd");
	const now = 1_000_000n;
	const ev = (over, dec = 8n) =>
		feeds.evaluateFeed(pin, dec, { roundId: 1n, answer: 1n, startedAt: 1n, updatedAt: now - 10n, answeredInRound: 1n, ...over }, now).status;
	check("age == heartbeat is OK", ev({ updatedAt: now - 255n }) === "OK");
	check("age == heartbeat + 1 is STALE", ev({ updatedAt: now - 256n }) === "STALE");
	check("answer 0 is NON_POSITIVE_ANSWER", ev({ answer: 0n }) === "NON_POSITIVE_ANSWER");
	check("answer -1 is NON_POSITIVE_ANSWER", ev({ answer: -1n }) === "NON_POSITIVE_ANSWER");
	check("answer 1 is OK", ev({ answer: 1n }) === "OK");
	check("updatedAt 0 is INCOMPLETE_ROUND", ev({ updatedAt: 0n }) === "INCOMPLETE_ROUND");
	check("updatedAt now+1 is FUTURE_TIMESTAMP", ev({ updatedAt: now + 1n }) === "FUTURE_TIMESTAMP");
	check("updatedAt == now is OK", ev({ updatedAt: now }) === "OK");
	check("decimals 18 vs pin 8 is DECIMALS_MISMATCH", ev({}, 18n) === "DECIMALS_MISMATCH");
	check("decimals mismatch outranks stale", ev({ updatedAt: now - 99999n }, 18n) === "DECIMALS_MISMATCH");
}

section("units: evaluateSequencer (grace 3600 s, both sides)");
{
	const now = 1_000_000n;
	const sq = (answer, startedAt) =>
		feeds.evaluateSequencer({ roundId: 1n, answer, startedAt, updatedAt: startedAt, answeredInRound: 1n }, now).status;
	check("up for exactly 3600 s is UP", sq(0n, now - 3600n) === "UP");
	check("up for 3599 s is GRACE_PERIOD", sq(0n, now - 3599n) === "GRACE_PERIOD");
	check("answer 1 is DOWN", sq(1n, now - 99999n) === "DOWN");
	check("answer 2 is UNKNOWN", sq(2n, now - 99999n) === "UNKNOWN");
	check("startedAt 0 is UNKNOWN", sq(0n, 0n) === "UNKNOWN");
}

section("units: rpc refuses write methods before sending");
{
	let code = null;
	try {
		await feeds.rpc({ url: "http://127.0.0.1:1", timeoutMs: 100 }, "eth_sendRawTransaction", ["0x"]);
	} catch (e) {
		code = e.code;
	}
	check("eth_sendRawTransaction is METHOD_REFUSED", code === "METHOD_REFUSED");
	check("allowlist is exactly three methods", feeds.ALLOWED_RPC_METHODS.size === 3);
	check("pins: ETH/USD not pinned on Base", feeds.findFeed("base", "eth-usd") === undefined);
	check("HTTP allowlist carries neither tool",
		!HTTP_TOOL_ALLOWLIST.has("get_chainlink_feed") && !HTTP_TOOL_ALLOWLIST.has("get_chainlink_feed_health"));
}

/* ------------------------------------------------------------------ */
/* Stub upstream: scenario = first path segment.                       */
const NOW = 1_800_000_000n;
const seen = [];
const scenario = (name) => {
	const s = {
		chainId: "0xa4b1",
		seq: { answer: 0n, startedAt: NOW - 100_000n, updatedAt: NOW - 100_000n },
		feed: { answer: 99985014n, updatedAt: NOW - 10n },
		decimals: 8n,
		status: 200,
	};
	if (name === "base") s.chainId = "0x2105";
	if (name === "wrongchain") s.chainId = "0x1";
	if (name === "stale") s.feed.updatedAt = NOW - 256n;
	if (name === "seqdown") s.seq.answer = 1n;
	if (name === "seqgrace") s.seq.startedAt = NOW - 3599n;
	if (name === "badecimals") s.decimals = 18n;
	if (name === "http500") s.status = 500;
	return s;
};
const server = http.createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		const name = (req.url ?? "/").split("/")[1];
		const s = scenario(name);
		const msg = JSON.parse(body);
		seen.push({ name, method: msg.method, params: msg.params });
		if (s.status !== 200) {
			res.writeHead(s.status);
			return res.end("nope");
		}
		let result;
		if (msg.method === "eth_chainId") result = s.chainId;
		else if (msg.method === "eth_getBlockByNumber") result = { number: "0x10", timestamp: "0x" + NOW.toString(16) };
		else if (msg.method === "eth_call") {
			const { to, data } = msg.params[0];
			const isSeq = [feeds.CHAIN_PINS["arbitrum-one"].sequencerProxy, feeds.CHAIN_PINS.base.sequencerProxy]
				.map((a) => a.toLowerCase()).includes(to.toLowerCase());
			if (data === feeds.SELECTOR_DECIMALS) result = "0x" + word(isSeq ? 0n : s.decimals);
			else result = roundHex(isSeq ? s.seq : s.feed);
		} else {
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { message: "method not stubbed" } }));
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
	});
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const once = async (e, n, a) => { const c = await connect(e); try { return await call(c, n, a); } finally { await c.close(); } };
const url = (name) => `http://127.0.0.1:${PORT}/${name}`;

const listNames = async (env) => {
	const c = await connect(env);
	const names = (await c.listTools()).tools.map((t) => t.name);
	await c.close();
	return names;
};

section("gate: fail-closed registration");
{
	const off = await listNames({ COMMERTIZE_MCP_ENABLE_CHAINLINK_FEEDS: "" });
	check("unset: not registered", !off.includes("get_chainlink_feed") && !off.includes("get_chainlink_feed_health"));
	const truthy = await listNames({ COMMERTIZE_MCP_ENABLE_CHAINLINK_FEEDS: "true" });
	check('"true": not registered', !truthy.includes("get_chainlink_feed"));
	const on = await listNames({ COMMERTIZE_MCP_ENABLE_CHAINLINK_FEEDS: "1" });
	check('"1": both registered', on.includes("get_chainlink_feed") && on.includes("get_chainlink_feed_health"));
	const killed = await listNames({ COMMERTIZE_MCP_ENABLE_CHAINLINK_FEEDS: "1", COMMERTIZE_MCP_DISABLE_CHAINLINK_FEEDS: "1" });
	check("kill switch wins", !killed.includes("get_chainlink_feed"));
}

const env = (name, baseName = "base") => ({
	COMMERTIZE_MCP_ENABLE_CHAINLINK_FEEDS: "1",
	COMMERTIZE_MCP_ARBITRUM_RPC_URL: url(name),
	COMMERTIZE_MCP_BASE_RPC_URL: url(baseName),
});

section("e2e: healthy read on Arbitrum One");
{
	const c = await connect(env("ok"));
	const { result, payload } = await call(c, "get_chainlink_feed", { chain: "arbitrum-one", feed: "usdc-usd" });
	check("no error flag", !result.isError);
	check("one feed returned", payload.feeds.length === 1);
	const f = payload.feeds[0];
	check("answer exact decimal string", f.answer === "0.99985014", f.answer);
	check("status OK and healthy", f.status === "OK" && f.healthy === true);
	check("age measured from block timestamp", f.age_seconds === 10);
	check("sequencer UP", payload.sequencer.status === "UP");
	check("feed_note present", typeof payload.feed_note === "string" && payload.feed_note.includes("does not operate"));
	check("disclaimer present", typeof payload.disclaimer === "string");
	const info = await call(c, "platform_info", {});
	check("platform_info lists the tools when on", info.payload.capabilities.tools.includes("get_chainlink_feed_health"));
	check("still read_only", info.payload.capabilities.read_only === true);
	await c.close();
}

section("e2e: every call pinned to one block, only allowed methods");
{
	seen.length = 0;
	const c = await connect(env("ok"));
	const { payload } = await call(c, "get_chainlink_feed_health", { chain: "arbitrum-one" });
	await c.close();
	check("three feeds on Arbitrum One", payload.feeds.length === 3);
	const methods = new Set(seen.map((s) => s.method));
	check("only allowed methods reached the RPC", [...methods].every((m) => feeds.ALLOWED_RPC_METHODS.has(m)), [...methods].join(","));
	const tags = new Set(seen.filter((s) => s.method === "eth_call").map((s) => s.params[1]));
	check("all eth_calls at the same block tag", tags.size === 1 && tags.has("0x10"), [...tags].join(","));
}

section("e2e: refusals");
{
	seen.length = 0;
	const c = await connect(env("wrongchain"));
	const { result, payload } = await call(c, "get_chainlink_feed_health", { chain: "arbitrum-one" });
	check("chain mismatch is an error", result.isError === true && payload.error.code === "CHAIN_MISMATCH");
	check("chain mismatch: no eth_call sent", !seen.some((s) => s.method === "eth_call"));
	check("chain mismatch: no feeds reported", payload.feeds.length === 0);

	const stale = await once(env("stale"), "get_chainlink_feed", { chain: "arbitrum-one", feed: "usdc-usd" });
	check("stale feed: STALE and not healthy", stale.payload.feeds[0].status === "STALE" && stale.payload.feeds[0].healthy === false);

	const down = await once(env("seqdown"), "get_chainlink_feed", { chain: "arbitrum-one", feed: "eth-usd" });
	check("sequencer down: feed OK but not healthy", down.payload.feeds[0].status === "OK" && down.payload.feeds[0].healthy === false);

	const grace = await once(env("seqgrace"), "get_chainlink_feed", { chain: "arbitrum-one", feed: "eth-usd" });
	check("sequencer grace: GRACE_PERIOD, not healthy", grace.payload.sequencer.status === "GRACE_PERIOD" && grace.payload.feeds[0].healthy === false);

	const dec = await once(env("badecimals"), "get_chainlink_feed", { chain: "arbitrum-one", feed: "link-usd" });
	check("decimals mismatch reported and not healthy", dec.payload.feeds[0].status === "DECIMALS_MISMATCH" && !dec.payload.feeds[0].healthy);

	const e500 = await once(env("http500"), "get_chainlink_feed_health", { chain: "arbitrum-one" });
	check("HTTP 500 is RPC_ERROR, retryable", e500.payload.error?.code === "RPC_ERROR" && e500.payload.error.retryable === true);

	const unreach = await once(
		{ COMMERTIZE_MCP_ENABLE_CHAINLINK_FEEDS: "1", COMMERTIZE_MCP_ARBITRUM_RPC_URL: "http://127.0.0.1:1/x" },
		"get_chainlink_feed_health",
		{ chain: "arbitrum-one" }
	);
	check("unreachable RPC is RPC_UNREACHABLE", unreach.payload.error?.code === "RPC_UNREACHABLE");

	seen.length = 0;
	const be = await call(c, "get_chainlink_feed", { chain: "base", feed: "eth-usd" });
	check("ETH/USD on Base refused as INVALID_ARGUMENT", be.payload.error?.code === "INVALID_ARGUMENT");
	check("refusal sent no RPC call", seen.length === 0);

	const bad = await c.callTool({ name: "get_chainlink_feed", arguments: { chain: "ethereum", feed: "usdc-usd" } });
	check("unknown chain rejected by schema", bad.isError === true);
	await c.close();
}

section("e2e: Base");
{
	const c = await connect(env("ok", "base"));
	const { payload } = await call(c, "get_chainlink_feed_health", { chain: "base" });
	check("two feeds on Base", payload.feeds.length === 2);
	check("chain_id 8453", payload.chain_id === 8453);
	await c.close();
}

server.close();
const failures = summary("chainlink feeds");
process.exit(failures ? 1 : 0);
