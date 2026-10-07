/**
 * Client-address bucketing for the verification brake.
 *
 * The brake in front of key verification is keyed by the client's address.
 * A full IPv6 address is not a stable identity (one host owns at least a
 * /64), so the key collapses IPv6 to its /64, exactly as the backend's
 * `toBucketKey` does. Two layers are held here:
 *
 *  1. `toBucketKey` / `clientIpOf` on a table of shapes: IPv4, IPv4-mapped,
 *     full and compressed IPv6, zone ids, header precedence, the socket
 *     fallback and the "unknown" bucket.
 *  2. The real handler (`createHttpHandler`) behind a real HTTP server: N
 *     misses from N different addresses in ONE /64 exhaust that /64's brake
 *     (the (N+1)th is 429 before any verifier call); another /64 is
 *     unaffected; IPv4 is unchanged.
 *
 * Offline: no upstream, the verifier is a counting stand-in that always says
 * "unknown key". Run directly: node test/client-ip.mjs
 */

import { createServer as createNodeServer } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { check, section, summary } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dist = (f) => path.resolve(HERE, "..", "dist", f);
const { toBucketKey, clientIpOf, createHttpHandler } = await import(dist("httpServer.js"));
const { FixedWindowLimiter } = await import(dist("httpRateLimit.js"));

/* ------------------------------------------------------------------ */
section("1. toBucketKey: IPv6 collapses to /64, IPv4 passes through");
/* ------------------------------------------------------------------ */
{
	const cases = [
		["203.0.113.9", "203.0.113.9"],
		["::ffff:203.0.113.5", "::ffff:203.0.113.5"],
		["2001:db8:abcd:12:1:2:3:4", "2001:db8:abcd:12::/64"],
		["2001:db8:abcd:12::1", "2001:db8:abcd:12::/64"],
		["2001:db8:abcd:12:ffff:ffff:ffff:ffff", "2001:db8:abcd:12::/64"],
		["2001:db8::1", "2001:db8:0:0::/64"],
		["2001:db8:abcd:12::1%eth0", "2001:db8:abcd:12::/64"],
		["::1", "0:0:0:0::/64"],
		["fe80::", "fe80:0:0:0::/64"],
	];
	for (const [input, want] of cases) {
		const got = toBucketKey(input);
		check(`${input} -> ${want}`, got === want, got);
	}
	check(
		"two hosts in one /64 share a bucket",
		toBucketKey("2001:db8:abcd:12::1") === toBucketKey("2001:db8:abcd:12:dead:beef:0:7")
	);
	check(
		"neighbouring /64s do not",
		toBucketKey("2001:db8:abcd:12::1") !== toBucketKey("2001:db8:abcd:13::1")
	);
}

/* ------------------------------------------------------------------ */
section("2. clientIpOf: header precedence, socket fallback, unknown");
/* ------------------------------------------------------------------ */
{
	const req = (headers = {}, remoteAddress) => ({ headers, socket: { remoteAddress } });
	check(
		"x-vercel-forwarded-for (first hop) wins and is bucketed",
		clientIpOf(req({ "x-vercel-forwarded-for": "2001:db8:1:2::9, 198.51.100.1", "x-real-ip": "203.0.113.1" })) ===
			"2001:db8:1:2::/64"
	);
	check(
		"x-real-ip is next and is bucketed",
		clientIpOf(req({ "x-real-ip": "2001:db8:1:3:4:5:6:7" })) === "2001:db8:1:3::/64"
	);
	check(
		"the socket address is the local fallback and is bucketed",
		clientIpOf(req({}, "2001:db8:1:4::1")) === "2001:db8:1:4::/64"
	);
	check(
		"a caller-set x-forwarded-for is never consulted",
		clientIpOf(req({ "x-forwarded-for": "2001:db8:9:9::1" }, "203.0.113.7")) === "203.0.113.7"
	);
	check("no address at all is the shared 'unknown' bucket", clientIpOf(req({}, undefined)) === "unknown");
}

/* ------------------------------------------------------------------ */
section("3. the real handler: one /64 is one brake bucket");
/* ------------------------------------------------------------------ */
let verifyCalls = 0;
const verifier = {
	configured: true,
	isCached: () => false,
	verify: async () => {
		verifyCalls += 1;
		return { ok: false, status: 401, code: "invalid_key", message: "The agent key is not valid." };
	},
};
const PER_IP = 3;
const verifyLimiter = new FixedWindowLimiter(PER_IP, 60_000);
const handler = createHttpHandler({
	verifier,
	requestLimiter: new FixedWindowLimiter(1000, 60_000),
	inquiryLimiter: new FixedWindowLimiter(1000, 60_000),
	verifyLimiter,
	createServer: () => {
		throw new Error("not reached: every key is refused");
	},
	log: () => {},
	maxBodyBytes: 4096,
	version: "test",
});
const server = createNodeServer((req, res) => {
	handler(req, res).catch(() => {
		if (!res.headersSent) res.writeHead(500).end();
	});
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const MCP = `http://127.0.0.1:${server.address().port}/mcp`;
const key = (i) => `cfa_${i.toString(16).padStart(16, "0")}_${"D".repeat(43)}`;
const post = (i, ip) =>
	fetch(MCP, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			authorization: `Bearer ${key(i)}`,
			"x-vercel-forwarded-for": ip,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
	});
try {
	const statuses = [];
	for (let i = 1; i <= PER_IP; i += 1) statuses.push((await post(i, `2001:db8:77:1::${i.toString(16)}`)).status);
	check(
		`${PER_IP} misses from ${PER_IP} different addresses in one /64 are verified`,
		statuses.every((s) => s === 401) && verifyCalls === PER_IP,
		`${statuses.join(",")} / ${verifyCalls}`
	);
	const rotated = await post(PER_IP + 1, "2001:db8:77:1:ffff:ffff:ffff:fffe");
	check(
		"a fresh address in the SAME /64 is braked (429) before any verifier call",
		rotated.status === 429 && verifyCalls === PER_IP,
		`${rotated.status} / ${verifyCalls}`
	);
	const neighbour = await post(PER_IP + 2, "2001:db8:77:2::1");
	check("the neighbouring /64 keeps its own brake", neighbour.status === 401, String(neighbour.status));
	verifyLimiter.reset();
	verifyCalls = 0;
	for (let i = 1; i <= PER_IP; i += 1) await post(100 + i, "198.51.100.20");
	const v4 = await post(200, "198.51.100.21");
	check("IPv4 is unchanged: a different address is a different bucket", v4.status === 401, String(v4.status));
	const v4again = await post(201, "198.51.100.20");
	check("IPv4 is unchanged: the same address is braked", v4again.status === 429, String(v4again.status));
} finally {
	await new Promise((r) => server.close(r));
}

process.exit(summary("client ip bucketing") ? 1 : 0);
