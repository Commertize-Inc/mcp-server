/**
 * End-to-end stdio session against the LIVE public API at api.commertize.com.
 *
 * Exercises every tool, asserts the envelope invariants on every response,
 * and probes the edges that would otherwise be discovered in production:
 * unknown ids, unknown slugs, filters that match nothing, cache reuse.
 *
 * ── NOT PART OF `npm test` BY DEFAULT ─────────────────────────────────────
 *
 * THIS SUITE OPENS REAL CONNECTIONS TO api.commertize.com AND ASSERTS ON
 * WHATEVER PRODUCTION IS SERVING AT THE TIME. It fails offline, in a sandboxed
 * CI runner, and while production is mid-deploy — and none of those failures
 * says anything about the code under test. `run-all.mjs` therefore skips it
 * unless `COMMERTIZE_MCP_LIVE_TESTS=1`, and PRINTS the skip; a silent skip
 * would be worse than running it, because somebody would eventually read "ALL
 * SUITES PASSED" and believe the live surface had been checked. (security review
 * 2026-09-03, NOTE.)
 *
 * It also means this file's assertions describe the DEPLOYED surface, not the
 * working tree: the gated tools (sandbox, x402) are deployed nowhere, so
 * `EXPECTED_TOOLS` below deliberately does not name them.
 *
 * Requires network. Run directly: node test/stdio-e2e.mjs
 * Or through the runner: COMMERTIZE_MCP_LIVE_TESTS=1 npm test
 */

import { call, check, checkEnvelope, connect, resetCounters, section, summary } from "./harness.mjs";

const EXPECTED_TOOLS = [
	"list_offerings",
	"get_offering",
	"get_news",
	"get_article",
	"platform_info",
	// Screening tools. Their behaviour is covered by test/screener-e2e.mjs
	// against a stub upstream (the live public set discloses no numeric field,
	// so live data cannot exercise a range filter); this list is asserted as an
	// EXACT set, so they have to be named here or the set assertion fails.
	"search_offerings",
	"compare_offerings",
	"list_sponsors",
	"get_sponsor",
	// `request_memo` is NOT here, and that is the point of this suite.
	// Its upstream route, POST /api/agents/memo-request, is not mounted on
	// api.commertize.com — so it is behind a deployment gate and a default
	// server does not list it. See the "deployment gates" section at the end,
	// which probes the route directly and turns red the day it goes live.
];

/**
 * The tools that are NOT reads, as this server ships against PRODUCTION.
 *
 * Empty since 2026-09-10: the only write, `request_memo`, posts to a route
 * production does not mount, so a default server neither registers nor
 * advertises it. Named as a list rather than inferred, so restoring it is a
 * deliberate edit and not a quietly-passing loop.
 *
 * An empty list makes every loop over it vacuous, so the read-only claim is
 * asserted head-on below instead of by iterating this.
 */
const WRITE_TOOLS = [];

resetCounters();
// Offerings tools are gated and default OFF; this suite exercises
// them deliberately, so it opts in. The default-closed behaviour has its own
// section in api-down.mjs.
const client = await connect({ COMMERTIZE_MCP_ENABLE_OFFERINGS: "1" });

/* ---------------------------------------------------------------- */
section("tools/list");
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
check(
	"exposes exactly the expected tool set",
	JSON.stringify(names) === JSON.stringify([...EXPECTED_TOOLS].sort()),
	names.join(",")
);
for (const t of tools) {
	check(`${t.name}: has a description`, typeof t.description === "string" && t.description.length > 40);
	check(`${t.name}: declares an inputSchema`, !!t.inputSchema);
	check(`${t.name}: declares an outputSchema`, !!t.outputSchema);
	// CHANGED 2026-09-02, deliberately, not lost: this used to assert
	// readOnlyHint === true for EVERY tool. `request_memo` is a write and must
	// annotate itself as one, or a client that asks before writing never asks.
	// Every other tool is still held to read-only.
	const shouldBeReadOnly = !WRITE_TOOLS.includes(t.name);
	check(
		`${t.name}: annotated ${shouldBeReadOnly ? "read-only" : "as a write"}`,
		t.annotations?.readOnlyHint === shouldBeReadOnly,
		JSON.stringify(t.annotations)
	);
	if (!shouldBeReadOnly) {
		check(
			`${t.name}: annotated non-destructive and non-idempotent`,
			t.annotations?.destructiveHint === false &&
				t.annotations?.idempotentHint === false,
			JSON.stringify(t.annotations)
		);
	}
}

/* ---------------------------------------------------------------- */
section("platform_info");
{
	const { result, payload } = await call(client, "platform_info");
	checkEnvelope("platform_info", payload);
	check("platform_info: not an error", result.isError !== true);
	check(
		"platform_info: markdown is the curated file",
		typeof payload.markdown === "string" &&
			payload.markdown.includes("Commertize is a digital capital markets platform")
	);
	// CHANGED 2026-09-02 to false (a write tool existed), and BACK to true on
	// 2026-09-10: that write's route is not mounted in production, so against
	// production this server really is read-only. The value is derived from the
	// write list rather than asserted, so the two cannot drift.
	check("platform_info: declares read_only against production", payload.capabilities?.read_only === true);
	check(
		"platform_info: names its write tools",
		JSON.stringify(payload.capabilities?.write_tools) === JSON.stringify(WRITE_TOOLS)
	);
	check("platform_info: declares can_transact false", payload.capabilities?.can_transact === false);
	check(
		"platform_info: capability tool list matches reality",
		JSON.stringify([...(payload.capabilities?.tools ?? [])].sort()) ===
			JSON.stringify([...EXPECTED_TOOLS].sort())
	);
	check(
		"platform_info: states agents cannot transact",
		(payload.markdown ?? "").includes(
			"No tool in this server can transact"
		)
	);
	// Positive control for the empty WRITE_TOOLS list: every tool this server
	// actually lists declares itself a read. Without this, "no writes" would be
	// a claim about a list rather than about the tools.
	check(
		"every listed tool declares readOnlyHint",
		(await client.listTools()).tools.every(
			(t) => t.annotations?.readOnlyHint === true
		)
	);
}

/* ---------------------------------------------------------------- */
section("list_offerings (live)");
let sampleId = null;
{
	const { result, payload } = await call(client, "list_offerings");
	checkEnvelope("list_offerings", payload);
	check("list_offerings: not an error", result.isError !== true, JSON.stringify(payload.error));
	check("list_offerings: returned offerings", Array.isArray(payload.offerings) && payload.offerings.length > 0, `count=${payload.count}`);
	check("list_offerings: count matches array length", payload.count === payload.offerings.length);
	check("list_offerings: total_available >= count", payload.total_available >= payload.count);
	check("list_offerings: fresh fetch not flagged stale", payload.cache.stale === false);

	const o = payload.offerings[0];
	sampleId = o?.id ?? null;
	console.log(`       sample: ${o?.name} — ${o?.status?.code} — ${o?.offering?.exemption_label}`);
	check("offering: has an id", typeof o?.id === "string" && o.id.length > 0);
	check("offering: has a name", typeof o?.name === "string");
	check("offering: status carries a label", typeof o?.status?.label === "string");
	check(
		"offering: accepting_investment is false for non-ACTIVE",
		payload.offerings.every(
			(x) => x.status.accepting_investment === (x.status.code === "ACTIVE")
		)
	);
	check(
		"offering: street address never present",
		payload.offerings.every((x) => x.location.street_address === null)
	);
	check(
		"offering: not_disclosed lists every null it should",
		payload.offerings.every(
			(x) =>
				Array.isArray(x.not_disclosed) &&
				(x.tokenomics.token_price === null) === x.not_disclosed.includes("tokenomics.token_price")
		)
	);
	check(
		"offering: undisclosed leverage renders 'Not disclosed', never 0%",
		payload.offerings.every(
			(x) =>
				(x.spv_leverage === null && x.spv_leverage_display === "Not disclosed") ||
				(x.spv_leverage !== null && x.spv_leverage_display.endsWith("%"))
		)
	);
	check(
		"offering: derived target_raise is null unless both inputs disclosed",
		payload.offerings.every((x) =>
			x.tokenomics.tokens_for_investors === null || x.tokenomics.token_price === null
				? x.derived.target_raise === null
				: typeof x.derived.target_raise === "number"
		)
	);
	check(
		"offering: 506(b) listings carry the solicitation note",
		payload.offerings.every((x) =>
			x.offering.exemption_code === "RULE_506_B"
				? typeof x.offering.note === "string" && x.offering.note.includes("506(b)")
				: true
		)
	);
	check(
		"offering: projections carry the projection note",
		payload.offerings.every((x) => (x.projections?.note ?? "").includes("not statements of fact"))
	);
	check(
		"offering: detail page is flagged as sign-in gated",
		payload.offerings.every((x) => x.links.detail_page_requires_sign_in === true)
	);
}

/* ---------------------------------------------------------------- */
section("list_offerings filters + cache");
{
	const { payload: second } = await call(client, "list_offerings");
	check("list_offerings: second call served from cache", second.cache.hit === true, JSON.stringify(second.cache));
	check("list_offerings: cached call is not stale", second.cache.stale === false);
	check(
		"list_offerings: as_of is the fetch time, not the call time",
		Date.parse(second.as_of) <= Date.now()
	);

	const { payload: hosp } = await call(client, "list_offerings", { asset_class: "hospitality" });
	check(
		"filter asset_class: case-insensitive and correct",
		hosp.offerings.every((o) => o.asset_class.code === "HOSPITALITY") && hosp.count > 0,
		`count=${hosp.count}`
	);
	check("filter asset_class: total_available still reports the full set", hosp.total_available >= hosp.count);

	const { payload: none } = await call(client, "list_offerings", { asset_class: "NOT_A_CLASS" });
	check("filter with no matches: empty list, no error", none.count === 0 && none.error === null);

	const { payload: limited } = await call(client, "list_offerings", { limit: 2 });
	check("limit: honoured", limited.count <= 2 && limited.offerings.length === limited.count);

	const { payload: active } = await call(client, "list_offerings", { status: "ACTIVE" });
	check(
		"filter status: only ACTIVE returned",
		active.offerings.every((o) => o.status.code === "ACTIVE"),
		`count=${active.count}`
	);
}

/* ---------------------------------------------------------------- */
section("get_offering");
{
	const { result, payload } = await call(client, "get_offering", { offering_id: sampleId });
	checkEnvelope("get_offering", payload);
	check("get_offering: not an error", result.isError !== true);
	check("get_offering: returns the requested offering", payload.offering?.id === sampleId);
	check("get_offering: flags public-fields-only", payload.public_fields_only === true);

	const bogus = await call(client, "get_offering", { offering_id: "00000000-0000-0000-0000-000000000000" });
	checkEnvelope("get_offering(unknown)", bogus.payload);
	check("get_offering(unknown): flagged isError", bogus.result.isError === true);
	check("get_offering(unknown): NOT_FOUND code", bogus.payload.error?.code === "NOT_FOUND");
	check("get_offering(unknown): offering is null, not fabricated", bogus.payload.offering === null);
	check("get_offering(unknown): not marked retryable", bogus.payload.error?.retryable === false);

	// Empty id must never reach the handler (it would match nothing and could
	// read as "no such offering" rather than "you sent a bad argument").
	// The SDK rejects it at the protocol layer, before our envelope exists.
	const emptyId = await client.callTool({
		name: "get_offering",
		arguments: { offering_id: "" },
	});
	check("get_offering(''): rejected by input schema", emptyId.isError === true);
	check(
		"get_offering(''): rejection names the offending field",
		(emptyId.content?.[0]?.text ?? "").includes("offering_id"),
		emptyId.content?.[0]?.text
	);
}

/* ---------------------------------------------------------------- */
section("get_news / get_article");
let sampleSlug = null;
{
	const { result, payload } = await call(client, "get_news", { limit: 3 });
	checkEnvelope("get_news", payload);
	check("get_news: not an error", result.isError !== true);
	check("get_news: respected limit", payload.count <= 3 && payload.count > 0, `count=${payload.count}`);
	const a = payload.articles[0];
	sampleSlug = a?.slug ?? null;
	console.log(`       sample: ${a?.title}`);
	check("article: has slug/title/published_at", !!a?.slug && !!a?.title && !!a?.published_at);
	check("article: url points at the public site", (a?.url ?? "").startsWith("https://commertize.com/news/"));
	check("article: summary present", typeof a?.summary === "string");
	check(
		"get_news: summaries carry no article body",
		payload.articles.every((x) => !("content_text" in x))
	);

	const { payload: q } = await call(client, "get_news", { limit: 20, query: "tokeniz" });
	check(
		"get_news: query filters title/summary",
		q.articles.every((x) => `${x.title} ${x.summary}`.toLowerCase().includes("tokeniz")),
		`count=${q.count}`
	);

	const { payload: noMatch } = await call(client, "get_news", { query: "zzzz-no-such-topic" });
	check("get_news: no matches is an empty list, not an error", noMatch.count === 0 && noMatch.error === null);
}
{
	const { result, payload } = await call(client, "get_article", { slug: sampleSlug });
	checkEnvelope("get_article", payload);
	check("get_article: not an error", result.isError !== true, JSON.stringify(payload.error));
	check("get_article: slug round-trips", payload.article?.slug === sampleSlug);
	check("get_article: body text present", (payload.article?.content_text ?? "").length > 500);
	check("get_article: markup stripped", !/[<][a-z/]/i.test(payload.article?.content_text ?? ""));
	check(
		"get_article: embedded JSON-LD stripped",
		!(payload.article?.content_text ?? "").includes("@context")
	);

	const bogus = await call(client, "get_article", { slug: "no-such-article-xyz" });
	checkEnvelope("get_article(unknown)", bogus.payload);
	check("get_article(unknown): flagged isError", bogus.result.isError === true);
	check("get_article(unknown): NOT_FOUND code", bogus.payload.error?.code === "NOT_FOUND", JSON.stringify(bogus.payload.error));
	check("get_article(unknown): article is null", bogus.payload.article === null);
}

/* ---------------------------------------------------------------- */
section("cross-cutting");
{
	const { payload } = await call(client, "list_offerings");
	const asJson = JSON.stringify(payload);
	check(
		"no privy/user identifiers leak into offering output",
		!/privy|kyb|kycData|ssn|beneficialOwner|email/i.test(asJson)
	);
	check("source_url points at the public API", payload.source_url.includes("/api/listings"));
}

/* ---------------------------------------------------------------- */
/*
 * DEPLOYMENT GATES — the expiry on the two gates added 2026-09-10.
 *
 * A gate with no expiry is a gate nobody reopens. These two checks probe the
 * routes directly against the same host the tools would call, and they FAIL
 * the day the routes start answering — which is the signal to set
 * COMMERTIZE_MCP_ENABLE_MEMO=1 / COMMERTIZE_MCP_ENABLE_DISCLOSURE=1, restore
 * the names above, and only then submit the registry listings.
 *
 * The assertion is on the STATUS, not the body: a 404 here is the whole claim,
 * and a mounted route answers 400/401/200 to these requests (verified against
 * /api/contact, which returns 400 to an empty POST body and 401 to a GET).
 */
section("deployment gates (the expiry on the manifest gates)");
{
	const base = process.env.COMMERTIZE_API_BASE_URL ?? "https://api.commertize.com";
	const memo = await fetch(`${base}/api/agents/memo-request`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		// Deliberately invalid: this must never file a real request. An
		// unmounted route 404s before any body is read; a mounted one rejects
		// it as a bad request.
		body: "{}",
	});
	check(
		"POST /api/agents/memo-request is STILL unmounted (404) — flip COMMERTIZE_MCP_ENABLE_MEMO when this fails",
		memo.status === 404,
		`got ${memo.status}`
	);
	const disc = await fetch(
		`${base}/api/offerings/v1/00000000-0000-0000-0000-000000000000/disclosure`
	);
	check(
		"GET /api/offerings/v1/{id}/disclosure is STILL unmounted (404) — flip COMMERTIZE_MCP_ENABLE_DISCLOSURE when this fails",
		disc.status === 404,
		`got ${disc.status}`
	);
	// Positive control: the probe reached a real API, so the two 404s above are
	// a fact about those routes and not about the network being down.
	// (/api/stats/platform is no longer public, so /api/listings is the control.)
	const control = await fetch(`${base}/api/listings`);
	check("control: /api/listings answers 200", control.status === 200, `got ${control.status}`);
}

await client.close();
process.exit(summary("live stdio e2e") === 0 ? 0 : 1);
