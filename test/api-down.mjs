/**
 * Degradation tests. No network required — every upstream is a local stub.
 *
 * Covers the four ways the API can let us down:
 *   1. refused connection      -> UPSTREAM_UNREACHABLE, retryable
 *   2. hangs past the timeout  -> UPSTREAM_TIMEOUT, retryable
 *   3. 500s                    -> UPSTREAM_ERROR, retryable
 *   4. dies after a good read  -> labelled stale cache, not silence
 *
 * The invariant under all four: no tool ever returns an empty success. An
 * agent must never be able to read "0 offerings" when the truth is "the API
 * is down".
 */

import { createServer } from "node:http";
import { call, check, checkEnvelope, connect, resetCounters, section, summary } from "./harness.mjs";

const listen = (handler) =>
	new Promise((resolve) => {
		const srv = createServer(handler);
		srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
	});

const close = (srv) => new Promise((r) => srv.close(() => r()));

resetCounters();

/* ---------------------------------------------------------------- */
section("1. upstream refuses connections");
{
	// Port 1 on loopback: nothing listens, connection is refused immediately.
	// ENABLE_OFFERINGS: the offering tools default OFF (offerings gate); this
	// suite tests degradation behaviour, so it opts in explicitly.
	const client = await connect({
		COMMERTIZE_API_BASE_URL: "http://127.0.0.1:1",
		COMMERTIZE_MCP_ENABLE_OFFERINGS: "1",
	});

	// The two offering tools consult the offering firewall FIRST, so with the
	// whole API unreachable the thing that failed is the gate, not the feed.
	// Both codes mean "we returned nothing"; they differ in WHY, and an agent
	// that retries on one should not conclude the marketplace is down.
	for (const [tool, args, emptyKey, code] of [
		["list_offerings", {}, "offerings", "FIREWALL_UNAVAILABLE"],
		["get_offering", { offering_id: "abc" }, "offering", "FIREWALL_UNAVAILABLE"],
		["get_news", {}, "articles", "UPSTREAM_UNREACHABLE"],
		["get_article", { slug: "abc" }, "article", "UPSTREAM_UNREACHABLE"],
	]) {
		const { result, payload } = await call(client, tool, args);
		checkEnvelope(`${tool}(down)`, payload);
		check(`${tool}(down): flagged isError`, result.isError === true);
		check(
			`${tool}(down): unreachable code`,
			payload.error?.code === code,
			payload.error?.code
		);
		check(`${tool}(down): marked retryable`, payload.error?.retryable === true);
		check(
			`${tool}(down): payload is empty/null, never fabricated`,
			payload[emptyKey] === null || (Array.isArray(payload[emptyKey]) && payload[emptyKey].length === 0)
		);
		check(
			`${tool}(down): message names the failure, not a stack trace`,
			typeof payload.error?.message === "string" && !payload.error.message.includes("at Object.")
		);
	}

	// The static tool must keep working when the API is unreachable.
	const { result, payload } = await call(client, "platform_info");
	check("platform_info(down): still succeeds", result.isError !== true && typeof payload.markdown === "string");

	await client.close();
}

/* ---------------------------------------------------------------- */
section("2. upstream hangs");
{
	const { srv, port } = await listen(() => {
		/* never respond */
	});
	const client = await connect({
		COMMERTIZE_API_BASE_URL: `http://127.0.0.1:${port}`,
		COMMERTIZE_REQUEST_TIMEOUT_MS: "400",
		COMMERTIZE_MCP_ENABLE_OFFERINGS: "1",
	});
	const started = Date.now();
	const { result, payload } = await call(client, "list_offerings");
	const elapsed = Date.now() - started;
	checkEnvelope("list_offerings(hang)", payload);
	check("hang: flagged isError", result.isError === true);
	// Same reason as section 1: the firewall call is the one that timed out.
	// `get_news` below keeps UPSTREAM_TIMEOUT, so the timeout path itself is
	// still covered by an ungated tool.
	check(
		"hang: FIREWALL_UNAVAILABLE",
		payload.error?.code === "FIREWALL_UNAVAILABLE",
		payload.error?.code
	);
	const news = await call(client, "get_news");
	check(
		"hang: an ungated tool still reports UPSTREAM_TIMEOUT",
		news.payload.error?.code === "UPSTREAM_TIMEOUT",
		news.payload.error?.code
	);
	check("hang: gave up near the configured timeout", elapsed < 4000, `${elapsed}ms`);
	check("hang: retryable", payload.error?.retryable === true);
	await client.close();
	await close(srv);
}

/* ---------------------------------------------------------------- */
section("3. upstream 500s");
{
	const { srv, port } = await listen((_req, res) => {
		res.writeHead(500, { "content-type": "application/json" });
		res.end('{"error":"Internal server error"}');
	});
	const client = await connect({
		COMMERTIZE_API_BASE_URL: `http://127.0.0.1:${port}`,
		COMMERTIZE_MCP_ENABLE_OFFERINGS: "1",
	});
	const { result, payload } = await call(client, "list_offerings");
	check("500: flagged isError", result.isError === true);
	// The OFFERING FIREWALL is consulted before the marketplace feed, and this
	// stub 500s on every path, so the thing that failed is the gate. Refusing
	// with FIREWALL_UNAVAILABLE rather than UPSTREAM_ERROR is the accurate
	// report: we did not fail to read offerings, we failed to establish which
	// offerings we may publish, and those are different facts to an agent.
	// The marketplace-500-with-a-working-gate case is section 3b below, which
	// is where UPSTREAM_ERROR still lives.
	check(
		"500: FIREWALL_UNAVAILABLE",
		payload.error?.code === "FIREWALL_UNAVAILABLE",
		payload.error?.code
	);
	check("500: retryable", payload.error?.retryable === true);
	check("500: offerings empty", payload.offerings.length === 0);
	await client.close();
	await close(srv);
}

/* ---------------------------------------------------------------- */
section("3b. the gate answers, the marketplace 500s");
{
	const { srv, port } = await listen((req, res) => {
		if (req.url?.startsWith("/api/venue/instruments")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ instruments: [{ id: "stub-1" }], withheld: 0 }));
			return;
		}
		res.writeHead(500, { "content-type": "application/json" });
		res.end('{"error":"Internal server error"}');
	});
	const client = await connect({
		COMMERTIZE_API_BASE_URL: `http://127.0.0.1:${port}`,
		COMMERTIZE_MCP_ENABLE_OFFERINGS: "1",
	});
	const { result, payload } = await call(client, "list_offerings");
	check("500(feed only): flagged isError", result.isError === true);
	check(
		"500(feed only): UPSTREAM_ERROR, not a firewall failure",
		payload.error?.code === "UPSTREAM_ERROR",
		payload.error?.code
	);
	check("500(feed only): offerings empty", payload.offerings.length === 0);
	await client.close();
	await close(srv);
}

/* ---------------------------------------------------------------- */
section("3c. the gate is unreadable, the marketplace is healthy");
{
	// The most important case in this file: the feed works perfectly and the
	// AUTHORITY does not. Serving the marketplace here would be the §5 exposure
	// the firewall exists to prevent, arriving as "the check errored so we
	// skipped it" — which is how every fail-open in this codebase was written.
	const { srv, port } = await listen((req, res) => {
		if (req.url?.startsWith("/api/venue/instruments")) {
			res.writeHead(200, { "content-type": "text/html" });
			res.end("<html>not the instrument book</html>");
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify([
				{ id: "stub-1", name: "Stub Asset", status: "ACTIVE", images: [] },
			])
		);
	});
	const client = await connect({
		COMMERTIZE_API_BASE_URL: `http://127.0.0.1:${port}`,
		COMMERTIZE_MCP_ENABLE_OFFERINGS: "1",
	});
	const { result, payload } = await call(client, "list_offerings");
	check("unreadable gate: flagged isError", result.isError === true);
	check(
		"unreadable gate: FIREWALL_UNAVAILABLE",
		payload.error?.code === "FIREWALL_UNAVAILABLE",
		payload.error?.code
	);
	check(
		"unreadable gate: serves NOTHING from the healthy feed",
		payload.offerings.length === 0,
		String(payload.offerings.length)
	);
	const one = await call(client, "get_offering", { offering_id: "stub-1" });
	check(
		"unreadable gate: get_offering refuses too",
		one.payload.error?.code === "FIREWALL_UNAVAILABLE" &&
			one.payload.offering === null,
		one.payload.error?.code
	);
	await client.close();
	await close(srv);
}

/* ---------------------------------------------------------------- */
section("3d. the gate answers with a SUBSET, and the subset is what ships");
{
	// The positive direction. Both endpoints are healthy; the marketplace feed
	// carries two rows and the firewall publishes one. Withheld and absent are
	// answered identically by `get_offering` on purpose: "that offering exists
	// but you may not read it" confirms a private placement to whoever guessed
	// the id.
	const { srv, port } = await listen((req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		if (req.url?.startsWith("/api/venue/instruments")) {
			res.end(
				JSON.stringify({ instruments: [{ id: "open-1" }], withheld: 1 })
			);
			return;
		}
		res.end(
			JSON.stringify([
				{
					id: "open-1",
					name: "Open Raise",
					city: "Yuma",
					state: "AZ",
					propertyType: "INDUSTRIAL",
					status: "ACTIVE",
					sponsor: { id: "s1", businessName: "Stub Sponsor" },
					images: [],
				},
				{
					id: "private-1",
					name: "Private Placement",
					city: "Reno",
					state: "NV",
					propertyType: "OFFICE",
					status: "ACTIVE",
					sponsor: { id: "s2", businessName: "Other Sponsor" },
					images: [],
				},
			])
		);
	});
	const client = await connect({
		COMMERTIZE_API_BASE_URL: `http://127.0.0.1:${port}`,
		COMMERTIZE_MCP_ENABLE_OFFERINGS: "1",
	});

	const { result, payload } = await call(client, "list_offerings");
	check("subset: not an error", result.isError !== true);
	check(
		"subset: only the published id is returned",
		payload.offerings.length === 1 && payload.offerings[0].id === "open-1",
		JSON.stringify(payload.offerings.map((o) => o.id))
	);
	check(
		"subset: nothing in the payload names the withheld offering",
		!JSON.stringify(payload).includes("Private Placement")
	);
	check(
		"subset: total_available is the publishable set, not the marketplace",
		payload.total_available === 1,
		String(payload.total_available)
	);
	check(
		"subset: the payload states the authority and the count it withheld",
		payload.firewall?.withheld === 1 &&
			typeof payload.firewall?.note === "string" &&
			payload.firewall.source_url.includes("/api/venue/instruments"),
		JSON.stringify(payload.firewall)
	);

	const allowed = await call(client, "get_offering", {
		offering_id: "open-1",
	});
	check(
		"subset: get_offering serves a published offering",
		allowed.payload.offering?.id === "open-1",
		JSON.stringify(allowed.payload.error)
	);

	const refused = await call(client, "get_offering", {
		offering_id: "private-1",
	});
	check(
		"subset: get_offering treats a withheld id as NOT_FOUND",
		refused.payload.error?.code === "NOT_FOUND" &&
			refused.payload.offering === null,
		refused.payload.error?.code
	);
	check(
		"subset: the refusal does not confirm the offering exists",
		!JSON.stringify(refused.payload).includes("Private Placement")
	);

	await client.close();
	await close(srv);
}

/* ---------------------------------------------------------------- */
section("3e. a backend that PREDATES the firewall is not an authority");
{
	// security review R5p F-8. A pre-R5p backend serves the UNGATED instrument book in
	// the same shape, but with no `withheld` field. Accepting it published every
	// id in it. The field's presence, as a non-negative integer, is what proves
	// the answering backend is firewall-aware; anything else is
	// FIREWALL_UNAVAILABLE.
	for (const [label, book] of [
		["no withheld field", { instruments: [{ id: "b-506b" }] }],
		["withheld: null", { instruments: [{ id: "b-506b" }], withheld: null }],
		["withheld: \"0\"", { instruments: [{ id: "b-506b" }], withheld: "0" }],
		["withheld: -1", { instruments: [{ id: "b-506b" }], withheld: -1 }],
		["withheld: 1.5", { instruments: [{ id: "b-506b" }], withheld: 1.5 }],
	]) {
		const { srv, port } = await listen((req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			if (req.url?.startsWith("/api/venue/instruments")) {
				res.end(JSON.stringify(book));
				return;
			}
			res.end(
				JSON.stringify([
					{ id: "b-506b", name: "Private Placement", status: "ACTIVE", images: [] },
				])
			);
		});
		const client = await connect({
			COMMERTIZE_API_BASE_URL: `http://127.0.0.1:${port}`,
			COMMERTIZE_MCP_ENABLE_OFFERINGS: "1",
		});
		const { payload } = await call(client, "list_offerings");
		check(
			`pre-firewall (${label}): FIREWALL_UNAVAILABLE`,
			payload.error?.code === "FIREWALL_UNAVAILABLE",
			payload.error?.code
		);
		check(
			`pre-firewall (${label}): names nothing`,
			payload.offerings.length === 0 &&
				!JSON.stringify(payload).includes("Private Placement"),
			String(payload.offerings.length)
		);
		await client.close();
		await close(srv);
	}
}

/* ---------------------------------------------------------------- */
section("4. upstream dies after one good response (stale serve)");
{
	let serve = true;
	const { srv, port } = await listen((req, res) => {
		if (!serve) {
			res.socket?.destroy();
			return;
		}
		// Path-aware since the offering firewall landed: the authority and the
		// marketplace feed are two different documents, and a stub that answers
		// both with the same array makes the gate read an unrecognised shape and
		// refuse — correctly, but it would test the refusal rather than the
		// stale-serve behaviour these cases are about.
		if (req.url?.startsWith("/api/venue/instruments")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({ instruments: [{ id: "stub-1" }], withheld: 0 })
			);
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify([
				{
					id: "stub-1",
					name: "Stub Asset",
					city: "Yuma",
					state: "AZ",
					propertyType: "INDUSTRIAL",
					status: "ACTIVE",
					offeringType: "RULE_506_C",
					sponsor: { id: "s1", businessName: "Stub Sponsor" },
					tokenomics: { tokenPrice: 100, tokensForInvestors: 5000, minInvestmentTokens: 10 },
					financials: { purchasePrice: 1000000 },
					spvDebtAmount: 400000,
					images: [],
				},
			])
		);
	});

	// TTL of 1ms: the second call always tries the network again.
	const client = await connect({
		COMMERTIZE_API_BASE_URL: `http://127.0.0.1:${port}`,
		COMMERTIZE_CACHE_TTL_MS: "1",
		COMMERTIZE_MCP_ENABLE_OFFERINGS: "1",
	});

	const first = await call(client, "list_offerings");
	check("stale: first call succeeds", first.result.isError !== true);
	check("stale: first call is fresh", first.payload.cache.stale === false);
	// Same stub exercises the money-adjacent math with values actually present.
	const o = first.payload.offerings[0];
	check("derived target_raise = tokens x price", o.derived.target_raise === 500000, String(o.derived.target_raise));
	check("derived min_investment_amount = min tokens x price", o.derived.min_investment_amount === 1000);
	check("leverage ratio derived, not self-reported", o.spv_leverage?.ratio === 0.4, String(o.spv_leverage?.ratio));
	check("leverage basis is the purchase price", o.spv_leverage?.basis === "PURCHASE_PRICE");
	check("leverage display formatted", o.spv_leverage_display === "40.0%", o.spv_leverage_display);
	check("506(c) gets no 506(b) note", o.offering.note === null);
	check("ACTIVE listing accepts investment", o.status.accepting_investment === true);

	const firstAsOf = first.payload.as_of;
	serve = false;
	await new Promise((r) => setTimeout(r, 20));

	const second = await call(client, "list_offerings");
	check("stale: second call still returns data", second.payload.offerings.length === 1);
	check("stale: labelled stale", second.payload.cache.stale === true, JSON.stringify(second.payload.cache));
	check("stale: as_of is the ORIGINAL fetch time", second.payload.as_of === firstAsOf);
	check("stale: not reported as an error", second.result.isError !== true);
	check("stale: age is reported", second.payload.cache.age_seconds >= 0);

	await client.close();
	await close(srv);
}

/**
 * A per-section stub upstream that serves `GET /api/news` and records every
 * path it is asked for. Sections 5 and 6 used to leave
 * COMMERTIZE_API_BASE_URL unset, so their "news unaffected" checks reached the
 * DEFAULT upstream over the network and passed or failed with it (126/128 in
 * run-all, 128/128 alone). Each section now owns its upstream and closes it.
 */
const newsStub = async () => {
	const paths = [];
	const { srv, port } = await listen((req, res) => {
		const url = new URL(req.url, "http://stub");
		paths.push(url.pathname);
		if (url.pathname === "/api/news") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					data: [
						{
							slug: "stub-article",
							title: "Stub article",
							summary: "A summary.",
							category: "Tokenization",
							publishedAt: "2026-10-01T00:00:00.000Z",
							readTime: 3,
							imageUrl: null,
							content: "<p>Body.</p>",
						},
					],
				})
			);
			return;
		}
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "not found" }));
	});
	return { srv, paths, base: `http://127.0.0.1:${port}` };
};

/* ---------------------------------------------------------------- */
section("5. offerings kill switch overrides the enable flag");
{
	// Both flags set: the emergency DISABLE must beat the ENABLE opt-in.
	const stub = await newsStub();
	const client = await connect({
		COMMERTIZE_API_BASE_URL: stub.base,
		COMMERTIZE_MCP_ENABLE_OFFERINGS: "1",
		COMMERTIZE_MCP_DISABLE_OFFERINGS: "1",
	});
	const { result, payload } = await call(client, "list_offerings");
	check("kill switch: list_offerings disabled", result.isError === true && payload.error?.code === "TOOL_DISABLED");
	check("kill switch: no offerings returned", payload.offerings.length === 0);
	const detail = await call(client, "get_offering", { offering_id: "anything" });
	check("kill switch: get_offering disabled", detail.result.isError === true && detail.payload.error?.code === "TOOL_DISABLED");
	const news = await call(client, "get_news", { limit: 1 });
	check("kill switch: news unaffected", news.result.isError !== true, JSON.stringify(news.payload?.error ?? null));
	check("kill switch: news came from this section's own stub", stub.paths.includes("/api/news"), stub.paths.join(","));
	check(
		"kill switch: no listings request reached the upstream",
		!stub.paths.some((p) => p.startsWith("/api/listings")),
		stub.paths.join(",")
	);
	await client.close();
	await close(stub.srv);
}

/* ---------------------------------------------------------------- */
section("6. offerings default CLOSED (offerings gate)");
{
	// No opt-in: the offering tools must be disabled. The env is pinned to
	// empty (not merely absent) so an ENABLE flag in the ambient shell
	// cannot make this test observe the wrong state. The upstream is this
	// section's own stub, never the default API.
	const stub = await newsStub();
	const client = await connect({
		COMMERTIZE_API_BASE_URL: stub.base,
		COMMERTIZE_MCP_ENABLE_OFFERINGS: "",
		COMMERTIZE_MCP_DISABLE_OFFERINGS: "",
	});
	const list = await call(client, "list_offerings");
	check(
		"default: list_offerings disabled with no env",
		list.result.isError === true && list.payload.error?.code === "TOOL_DISABLED",
		list.payload.error?.code
	);
	check("default: no offerings returned", list.payload.offerings.length === 0);
	const detail = await call(client, "get_offering", { offering_id: "anything" });
	check(
		"default: get_offering disabled with no env",
		detail.result.isError === true && detail.payload.error?.code === "TOOL_DISABLED"
	);
	const news = await call(client, "get_news", { limit: 1 });
	check("default: news unaffected", news.result.isError !== true, JSON.stringify(news.payload?.error ?? null));
	check("default: news came from this section's own stub", stub.paths.includes("/api/news"), stub.paths.join(","));
	const info = await call(client, "platform_info");
	check("default: platform_info unaffected", info.result.isError !== true);
	await client.close();

	// Only the exact string "1" opens the gate; truthy-looking values do not.
	for (const junk of ["true", "yes", "on", "1 ", "0"]) {
		const c = await connect({
			COMMERTIZE_API_BASE_URL: stub.base,
			COMMERTIZE_MCP_ENABLE_OFFERINGS: junk,
			COMMERTIZE_MCP_DISABLE_OFFERINGS: "",
		});
		const r = await call(c, "list_offerings");
		check(
			`default: ENABLE=${JSON.stringify(junk)} does not open the gate`,
			r.result.isError === true && r.payload.error?.code === "TOOL_DISABLED",
			r.payload.error?.code
		);
		await c.close();
	}
	check(
		"default: no listings request reached the upstream",
		!stub.paths.some((p) => p.startsWith("/api/listings")),
		stub.paths.join(",")
	);
	await close(stub.srv);
}

/* ---------------------------------------------------------------- */
section("request_memo without a credential");
{
	/**
	 * The one WRITE tool, fail-closed.
	 *
	 * The failure this guards is the ugly one: a tool that accepts the call,
	 * returns something that looks like success, and files nothing — the agent
	 * tells its principal the memo is coming and no memo is coming. So the
	 * refusal has to be an ERROR, has to name the missing configuration, and has
	 * to say that nothing was filed.
	 *
	 * No network is involved: the credential is checked before any request is
	 * built, which is also why this belongs in the offline suite.
	 */
	// The gate is a DEPLOYMENT gate, not part of what this section tests:
	// open it so the no-credential refusal is still exercised.
	const client = await connect({
		COMMERTIZE_AGENT_KEY: "",
		COMMERTIZE_MCP_ENABLE_MEMO: "1",
		COMMERTIZE_MCP_DISABLE_MEMO: "",
	});
	// No `principal_email`: removed 2026-09-02 (security review delta). The destination is
	// the address the credential proved, and the tool no longer accepts one.
	const { result, payload } = await call(client, "request_memo", {
		asset_class: "industrial",
		size_band: "10m_to_50m",
		doc_link: "https://app.box.com/s/abc123",
	});
	check(
		"request_memo: refuses with no credential",
		result.isError === true && payload.error?.code === "NO_CREDENTIAL",
		payload.error?.code
	);
	check(
		"request_memo: says nothing was filed",
		(payload.error?.message ?? "").includes("Nothing was filed")
	);
	check(
		"request_memo: names the variable to set",
		(payload.error?.message ?? "").includes("COMMERTIZE_AGENT_KEY")
	);
	check(
		"request_memo: not retryable — retrying without a key files nothing",
		payload.error?.retryable === false
	);
	check("request_memo: payload key present on the failure", "request" in payload);

	// security review delta 2026-09-02: the memo's destination is the address the
	// credential proved, so the tool must not offer a way to name another one.
	const { tools } = await client.listTools();
	const memo = tools.find((t) => t.name === "request_memo");
	check(
		"request_memo: accepts no caller-supplied recipient address",
		memo != null &&
			!Object.keys(memo.inputSchema?.properties ?? {}).some((k) =>
				/email|recipient|to\b/i.test(k)
			),
		JSON.stringify(Object.keys(memo?.inputSchema?.properties ?? {}))
	);
	check(
		"request_memo: says where the memo goes, in the description",
		/registered to/i.test(memo?.description ?? "")
	);
	check(
		"request_memo: makes no turnaround promise",
		!/\b48\b|hours?\b|within \d+/i.test(memo?.description ?? "") &&
			/no committed turnaround/i.test(memo?.description ?? "")
	);
	check("request_memo: no request object invented", payload.request === null);
	checkEnvelope("request_memo", payload);
	await client.close();
}

process.exit(summary("degradation") === 0 ? 0 : 1);
