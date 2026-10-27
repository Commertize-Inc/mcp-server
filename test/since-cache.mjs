/**
 * get_news `since` canonicalisation and the response-cache bound.
 *
 *  1. canonicalSince accepts ISO dates and zoned timestamps in range, floors
 *     to the minute, and refuses loose or out-of-range input.
 *  2. 300 distinct `since` spellings spread over 5 minutes cost at most 5
 *     upstream calls (one per minute bucket), not 300.
 *  3. The positive cache never holds more than COMMERTIZE_CACHE_MAX_ENTRIES
 *     bodies, however many distinct URLs are fetched.
 *
 * Run directly: node test/since-cache.mjs (after npm run build)
 */

import { createServer } from "node:http";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { call, check, connect, resetCounters, section, summary } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOOPBACK = [127, 0, 0, 1].join(".");
const dist = (f) => pathToFileURL(path.resolve(HERE, "..", "dist", f)).href;

resetCounters();

const newsCalls = [];
const srv = createServer((req, res) => {
	const url = new URL(req.url, "http://stub");
	if (url.pathname === "/api/news") newsCalls.push(url.searchParams.get("since"));
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify({ data: [] }));
});
await new Promise((r) => srv.listen(0, LOOPBACK, r));
const BASE = `http://${LOOPBACK}:${srv.address().port}`;

section("1. canonicalSince");
{
	const { canonicalSince } = await import(dist("since.js"));
	const NOW = Date.UTC(2026, 9, 27, 12, 0);
	const ok = [
		["2026-10-01", "2026-10-01T00:00:00.000Z"],
		["2026-10-01T10:15Z", "2026-10-01T10:15:00.000Z"],
		["2026-10-01T10:15:59Z", "2026-10-01T10:15:00.000Z"],
		["2026-10-01T10:15:59.999Z", "2026-10-01T10:15:00.000Z"],
		["2026-10-01T12:15:30+02:00", "2026-10-01T10:15:00.000Z"],
	];
	for (const [raw, want] of ok) check(`accepts ${raw} as ${want}`, canonicalSince(raw, NOW) === want, String(canonicalSince(raw, NOW)));
	const bad = [
		"October 1, 2026",
		"2026-10-01T10:15:00",
		"1999-12-31",
		"2026-10-30",
		"9999-01-01",
		"2026-13-45",
		"1759312800000",
		"",
	];
	for (const raw of bad) check(`refuses ${JSON.stringify(raw)}`, canonicalSince(raw, NOW) === null, String(canonicalSince(raw, NOW)));
}

section("2. 300 spellings in 5 minutes cost at most 5 upstream calls");
{
	const client = await connect({ COMMERTIZE_API_BASE_URL: BASE, COMMERTIZE_CACHE_TTL_MS: "60000" });
	newsCalls.length = 0;
	let refused = 0;
	for (let i = 0; i < 300; i++) {
		const minute = i % 5;
		const second = String(Math.floor(i / 5) % 60).padStart(2, "0");
		const zone = i % 2 === 0 ? "Z" : "+00:00";
		const since = `2026-10-01T00:0${minute}:${second}${zone}`;
		const { result } = await call(client, "get_news", { since, limit: 5 });
		if (result.isError) refused += 1;
	}
	check("no call refused", refused === 0, String(refused));
	check("upstream calls <= 5 minute buckets", newsCalls.length <= 5, String(newsCalls.length));
	check("every upstream since is a canonical minute", newsCalls.every((s) => /^2026-10-01T00:0[0-4]:00\.000Z$/.test(s ?? "")), JSON.stringify(newsCalls));
	const bad = await call(client, "get_news", { since: "October 1, 2026" });
	check("loose since is refused before any upstream call", bad.result.isError === true && newsCalls.length <= 5);
	await client.close();
}

section("3. the response cache is bounded");
{
	process.env.COMMERTIZE_API_BASE_URL = BASE;
	process.env.COMMERTIZE_CACHE_MAX_ENTRIES = "50";
	const http = await import(dist("http.js"));
	http.clearCache();
	const heapBefore = process.memoryUsage().heapUsed;
	let maxSeen = 0;
	for (let i = 0; i < 300; i++) {
		await http.getJson(`/api/news?limit=5&since=k${i}`);
		maxSeen = Math.max(maxSeen, http.cacheSize());
	}
	check("cache never exceeds 50 entries over 300 distinct URLs", maxSeen <= 50, String(maxSeen));
	check("cache holds exactly the cap after overflow", http.cacheSize() === 50, String(http.cacheSize()));
	const again = await http.getJson(`/api/news?limit=5&since=k299`);
	check("the most recent key is still cached (LRU keeps the newest)", again.cache.hit === true);
	const evicted = await http.getJson(`/api/news?limit=5&since=k0`);
	check("the oldest key was evicted", evicted.cache.hit === false);
	const heapGrowthMb = (process.memoryUsage().heapUsed - heapBefore) / 1e6;
	check("heap growth over 300 URLs stays small (< 20 MB)", heapGrowthMb < 20, heapGrowthMb.toFixed(2));
}

srv.close();
process.exit(summary("since and cache bound") ? 1 : 0);
