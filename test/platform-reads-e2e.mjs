/**
 * PLATFORM READ TOOLS: get_reference_index, get_intelligence_issue,
 * list_work_tasks.
 *
 * Against a local stub upstream. Asserts, in the order that matters:
 *  1. Gate closed (the default) = not listed, not in platform_info, not callable.
 *     The parse is fail-closed and DISABLE beats ENABLE.
 *  2. Gate open = listed, prose passes the banned-word scan, read_only stays
 *     true. (platform_info does not list them yet: a follow-up, see the PR.)
 *  3. A served route returns its content, the API's captions VERBATIM, and
 *     deployment "deployed".
 *  4. 404 is NOT_DEPLOYED (built is not deployed), 401/403 is RESTRICTED, and
 *     neither returns data. Other faults keep their upstream code.
 *  5. Shape guards: array body refused, missing tasks list is null (never an
 *     empty board), non-string captions dropped.
 *  6. No credential is sent upstream even when one is configured.
 *
 * Run directly: node test/platform-reads-e2e.mjs
 */

import { createServer } from "node:http";
import {
	call,
	check,
	checkEnvelope,
	connect,
	resetCounters,
	section,
	summary,
} from "./harness.mjs";

const TOOLS = [
	"get_reference_index",
	"get_intelligence_issue",
	"list_work_tasks",
];

const NUMBER_CAPTION = "Reference index caption, exact bytes: 1,000 base.";
const WORK_REF = "work-ruling-ref-2026-10";
const ARRAY_CAPTION = ["Line one of the caption.", "Line two."];

/** Per-route behaviour, changed between sections. */
const mode = {
	"/api/intelligence/number": "ok",
	"/api/intelligence/state-weekly": "404",
	"/api/work/v1/tasks": "ok",
};
const seenHeaders = [];

const BODIES = {
	"/api/intelligence/number": {
		number: { value: 1000, as_of: "2026-10-26" },
		disclosure: NUMBER_CAPTION,
		notice: { not: "a string" },
	},
	"/api/intelligence/state-weekly": {
		issue: { issueNumber: 5, title: "Issue 5" },
		captions: ARRAY_CAPTION,
	},
	"/api/work/v1/tasks": {
		schema: "commertize.work.v1",
		strings_ref: WORK_REF,
		tasks: [
			{
				task_id: "t1",
				status: "open",
				title_key: "work.task.t1",
				description: "third-party prose must not travel",
				acceptance: { method: "exact", note: "dropped" },
				deadline: "x".repeat(200),
				submissions_count: 3,
				task_version: "v1 injected line",
				task_class: "screen para",
				posted_at: "2026‮reversed",
				required_kya_tier: "t1\u0000",
				source: { dataset_key: "ds\tkey", snapshot_sha256: "abc" },
			},
		],
	},
};

const server = createServer((req, res) => {
	seenHeaders.push(req.headers);
	const route = (req.url ?? "").split("?")[0];
	const m = mode[route];
	const json = (status, body) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};
	if (!m) return json(404, { error: "Not found" });
	if (m === "ok") return json(200, BODIES[route]);
	if (m === "404") {
		res.writeHead(404, { "content-type": "text/plain" });
		return res.end("404 Not Found");
	}
	if (m === "401") return json(401, { error: "Unauthorized" });
	if (m === "403") return json(403, { error: "Forbidden" });
	if (m === "500") return json(500, { error: "boom" });
	if (m === "array") return json(200, [1, 2]);
	if (m === "notasks") return json(200, { strings_ref: WORK_REF });
	return json(500, { error: "unknown mode" });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const COMMON = {
	COMMERTIZE_API_BASE_URL: BASE,
	COMMERTIZE_CACHE_TTL_MS: "1",
	COMMERTIZE_STALE_MAX_MS: "1",
};
const ON = {
	...COMMON,
	COMMERTIZE_MCP_ENABLE_PLATFORM_READS: "1",
	COMMERTIZE_MCP_DISABLE_PLATFORM_READS: "",
};

const info = async (client) => (await call(client, "platform_info")).payload;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

resetCounters();

section("1. gate closed: the tools do not exist");
for (const [label, env] of [
	["unset", { COMMERTIZE_MCP_ENABLE_PLATFORM_READS: "" }],
	["true", { COMMERTIZE_MCP_ENABLE_PLATFORM_READS: "true" }],
	["1 with space", { COMMERTIZE_MCP_ENABLE_PLATFORM_READS: "1 " }],
	[
		"DISABLE beats ENABLE",
		{
			COMMERTIZE_MCP_ENABLE_PLATFORM_READS: "1",
			COMMERTIZE_MCP_DISABLE_PLATFORM_READS: "1",
		},
	],
]) {
	const client = await connect({
		...COMMON,
		COMMERTIZE_MCP_DISABLE_PLATFORM_READS: "",
		...env,
	});
	const listed = (await client.listTools()).tools.map((t) => t.name);
	check(
		`${label}: none listed`,
		TOOLS.every((n) => !listed.includes(n)),
		listed.join(","),
	);
	const caps = (await info(client)).capabilities;
	check(
		`${label}: none in platform_info`,
		TOOLS.every((n) => !caps.tools.includes(n)),
	);
	let threw = false;
	try {
		const r = await client.callTool({ name: TOOLS[0], arguments: {} });
		threw = r.isError === true;
	} catch {
		threw = true;
	}
	check(`${label}: calling a closed tool fails`, threw);
	await client.close();
}

const client = await connect(ON);

section("2. gate open: listed, advertised, still read-only");
{
	const listed = (await client.listTools()).tools;
	const names = listed.map((t) => t.name);
	check(
		"all three listed",
		TOOLS.every((n) => names.includes(n)),
		names.join(","),
	);
	check(
		"all three carry readOnlyHint",
		listed
			.filter((t) => TOOLS.includes(t.name))
			.every((t) => t.annotations?.readOnlyHint === true),
	);
	// The repo's language suite scans only the gates it opens; these three are
	// scanned here against the same bans (language-check.mjs BANNED).
	const BANNED = [
		/\bAPYs?\b/i,
		/\byields?\b/i,
		/\bguarantee(s|d)?\b/i,
		/\brisk[- ]free\b/i,
		/\bpassive income\b/i,
		/\b(high|strong|attractive|expected|projected|target|annual|historical)\s+returns?\b/i,
		/\breturns? of \d/i,
		/\bwill (earn|pay|deliver|generate)\b/i,
		/\bsafe investment\b/i,
		/\bprofit(s|able)?\b/i,
	];
	for (const t of listed.filter((x) => TOOLS.includes(x.name))) {
		const text = `${t.title ?? ""} ${t.description ?? ""} ${JSON.stringify(t.outputSchema ?? {})}`;
		const hit = BANNED.find((re) => re.test(text));
		check(`${t.name}: prose passes the banned-word scan`, !hit, String(hit));
	}
	const caps = (await info(client)).capabilities;
	check(
		"none in write_tools",
		TOOLS.every((n) => !caps.write_tools.includes(n)),
	);
	check("read_only still true", caps.read_only === true);
}

section("3. served route: content, verbatim captions, deployed");
{
	const { result, payload } = await call(client, "get_reference_index");
	checkEnvelope("get_reference_index", payload);
	check("not an error", result.isError !== true && payload.error === null);
	check("data is the number object", payload.data?.value === 1000);
	check(
		"disclosure caption verbatim",
		payload.api_captions?.disclosure === NUMBER_CAPTION,
	);
	check(
		"non-string caption dropped",
		!("notice" in (payload.api_captions ?? {})),
	);
	check("deployment deployed", payload.deployment?.status === "deployed");
	check(
		"deployment route",
		payload.deployment?.route === "/api/intelligence/number",
	);
	check(
		"source_url is the upstream",
		payload.source_url === `${BASE}/api/intelligence/number`,
	);
}
{
	const { payload } = await call(client, "list_work_tasks");
	check(
		"work: allowlisted fields pass",
		payload.data?.[0]?.task_id === "t1" &&
			payload.data?.[0]?.title_key === "work.task.t1",
	);
	check(
		"work: unlisted free text dropped",
		!("description" in (payload.data?.[0] ?? {})),
	);
	check(
		"work: unlisted nested key dropped",
		payload.data?.[0]?.acceptance?.method === "exact" &&
			!("note" in (payload.data?.[0]?.acceptance ?? {})),
	);
	check(
		"work: overlong string dropped",
		!("deadline" in (payload.data?.[0] ?? {})),
	);
	for (const [label, key] of [
		["U+2028 line separator", "task_version"],
		["U+2029 paragraph separator", "task_class"],
		["U+202E bidi override", "posted_at"],
		["NUL control", "required_kya_tier"],
	])
		check(`work: ${label} dropped`, !(key in (payload.data?.[0] ?? {})));
	check(
		"work: tab in a nested value dropped, clean sibling kept",
		!("dataset_key" in (payload.data?.[0]?.source ?? {})) &&
			payload.data?.[0]?.source?.snapshot_sha256 === "abc",
	);
	check(
		"work: non-string value dropped",
		!("submissions_count" in (payload.data?.[0] ?? {})),
	);
	check(
		"work: strings_ref caption verbatim",
		payload.api_captions?.strings_ref === WORK_REF,
	);
	check("work: deployed", payload.deployment?.status === "deployed");
}

section("4. not deployed and restricted return no data");
{
	const { result, payload } = await call(client, "get_intelligence_issue");
	checkEnvelope("get_intelligence_issue 404", payload);
	check("404: isError", result.isError === true);
	check("404: NOT_DEPLOYED", payload.error?.code === "NOT_DEPLOYED");
	check("404: not retryable", payload.error?.retryable === false);
	check("404: data null", payload.data === null);
	check(
		"404: deployment not_deployed",
		payload.deployment?.status === "not_deployed",
	);
	check(
		"404: message says built is not deployed",
		/built is not deployed/.test(payload.error?.message ?? ""),
	);
}
{
	mode["/api/intelligence/state-weekly"] = "401";
	await sleep(5);
	const { result, payload } = await call(client, "get_intelligence_issue");
	check("401: isError", result.isError === true);
	check("401: RESTRICTED", payload.error?.code === "RESTRICTED");
	check("401: data null", payload.data === null);
	check(
		"401: deployment restricted",
		payload.deployment?.status === "restricted",
	);
}
{
	mode["/api/intelligence/state-weekly"] = "403";
	await sleep(5);
	const { payload } = await call(client, "get_intelligence_issue");
	check("403: RESTRICTED", payload.error?.code === "RESTRICTED");
}
{
	mode["/api/intelligence/state-weekly"] = "ok";
	await sleep(5);
	const { payload } = await call(client, "get_intelligence_issue");
	check("issue ok: data", payload.data?.issueNumber === 5);
	check(
		"issue ok: array caption joined verbatim",
		payload.api_captions?.captions === ARRAY_CAPTION.join("\n"),
	);
}
{
	mode["/api/intelligence/number"] = "500";
	await sleep(5);
	const { result, payload } = await call(client, "get_reference_index");
	check("500: isError", result.isError === true);
	check(
		"500: UPSTREAM_ERROR, not NOT_DEPLOYED",
		payload.error?.code === "UPSTREAM_ERROR",
	);
	check("500: retryable", payload.error?.retryable === true);
	check("500: data null", payload.data === null);
	check(
		"500: deployment unknown, not deployed",
		payload.deployment?.status === "unknown",
	);
}

section("5. shape guards");
{
	mode["/api/intelligence/number"] = "array";
	await sleep(5);
	const { payload } = await call(client, "get_reference_index");
	check(
		"array body: UPSTREAM_BAD_BODY",
		payload.error?.code === "UPSTREAM_BAD_BODY",
	);
	check("array body: data null", payload.data === null);
}
{
	mode["/api/work/v1/tasks"] = "notasks";
	await sleep(5);
	const { payload } = await call(client, "list_work_tasks");
	check("missing tasks: data null, not an empty board", payload.data === null);
	check(
		"missing tasks: caption still carried",
		payload.api_captions?.strings_ref === WORK_REF,
	);
}
await client.close();

section("6. no credential upstream");
{
	seenHeaders.length = 0;
	mode["/api/intelligence/number"] = "ok";
	const keyed = await connect({
		...ON,
		COMMERTIZE_AGENT_KEY: "ctz_test_should_not_travel",
	});
	for (const t of TOOLS) await call(keyed, t);
	check(
		"upstream was called",
		seenHeaders.length >= TOOLS.length,
		String(seenHeaders.length),
	);
	check(
		"no x-api-key or authorization header on any read",
		seenHeaders.every((h) => !h["x-api-key"] && !h.authorization),
	);
	await keyed.close();
}

server.close();
process.exit(summary("platform reads e2e") ? 1 : 0);
