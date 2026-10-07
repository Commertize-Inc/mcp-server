/**
 * DEPLOYMENT GATES — `request_memo` and `get_disclosure_package`.
 *
 * Both post/get to routes that api.commertize.com does not mount (probed
 * 2026-09-10). `index.ts` already stated the rule for the sandbox and x402
 * groups — "registering tools that can only 404 would teach a machine reader
 * that the venue is broken rather than absent" — and these two were the
 * exception to it. This suite pins the fix.
 *
 * What it asserts, in the order that matters:
 *
 *  1. GATE CLOSED = NOT LISTED. Absent from `tools/list` AND absent from
 *     `platform_info`'s capability lists, because a manifest that names a tool
 *     the server did not register is the same lie in a different document.
 *  2. CALLING A CLOSED TOOL FAILS. Not "returns an empty envelope" — the tool
 *     does not exist, so the protocol itself refuses.
 *  3. THE REST OF THE SURFACE IS UNTOUCHED. A gate that took the other ten
 *     tools with it would pass every check in (1).
 *  4. GATE OPEN = LISTED AND CALLABLE, so the closed assertions are about the
 *     gate and not about a tool that is simply broken.
 *  5. THE PARSE IS FAIL-CLOSED. "true", "yes", "on", "1 " and an empty string
 *     are all OFF; only the exact string "1" opens it, and DISABLE beats
 *     ENABLE.
 *  6. `read_only` IS DERIVED. With the memo gate closed and no other write
 *     gate open, `platform_info.read_only` is true — and it flips with the
 *     gate rather than being hard-coded either way.
 *
 * Offline: no upstream is contacted, because nothing here calls a tool that
 * needs one. Run directly: node test/gates-e2e.mjs
 */

import { check, connect, resetCounters, section, summary } from "./harness.mjs";

/*
 * Three gated tools since the sponsor inquiry landed. `file_sponsor_inquiry`
 * posts to a route that IS mounted (`POST /contact`); its gate is on the
 * attribution contract being deployed, not on the route (config.ts). Same
 * parse, same default, same kill switch — so it is swept by every section.
 */
const GATED = ["request_memo", "get_disclosure_package", "file_sponsor_inquiry"];
const GATE_ENV = {
	request_memo: "MEMO",
	get_disclosure_package: "DISCLOSURE",
	file_sponsor_inquiry: "INQUIRY",
};
const allOff = (value = "") =>
	Object.fromEntries(
		Object.values(GATE_ENV).map((g) => [`COMMERTIZE_MCP_ENABLE_${g}`, value])
	);
const allOn = () =>
	Object.fromEntries(
		Object.values(GATE_ENV).flatMap((g) => [
			[`COMMERTIZE_MCP_ENABLE_${g}`, "1"],
			[`COMMERTIZE_MCP_DISABLE_${g}`, ""],
		])
	);

/** The surface a default, unconfigured server must show. Exact set. */
const DEFAULT_TOOLS = [
	"list_offerings",
	"get_offering",
	"get_news",
	"get_article",
	// get_platform_stats is REMOVED (2026-09-26): the backend now
	// requires a signed-in session, and the counts must not reach agents.
	"platform_info",
	"search_offerings",
	"compare_offerings",
	"list_sponsors",
	"get_sponsor",
];

const info = async (client) => {
	const res = await client.callTool({ name: "platform_info", arguments: {} });
	return res.structuredContent ?? JSON.parse(res.content[0].text);
};

resetCounters();

/* ------------------------------------------------------------------ */
section("1. default server: neither tool exists, in either document");
/* ------------------------------------------------------------------ */
{
	// No environment at all — the way a registry-installed client runs it.
	const client = await connect(allOff());
	const listed = (await client.listTools()).tools.map((t) => t.name);
	for (const name of GATED) {
		check(`${name} absent from tools/list`, !listed.includes(name));
	}

	const payload = await info(client);
	for (const name of GATED) {
		check(
			`${name} absent from platform_info.tools`,
			!(payload.capabilities?.tools ?? []).includes(name)
		);
	}
	check(
		"platform_info.write_tools is empty",
		Array.isArray(payload.capabilities?.write_tools) &&
			payload.capabilities.write_tools.length === 0,
		JSON.stringify(payload.capabilities?.write_tools)
	);
	// (6) Derived, not asserted. A hard-coded `false` survived here for eight
	// days after the write it described stopped being reachable.
	check(
		"platform_info.read_only is true when no write tool is registered",
		payload.capabilities?.read_only === true
	);

	/* (3) The gate must not take the rest of the server with it. This is the
	 * check that fails if someone "fixes" the manifest by not registering
	 * anything. */
	check(
		"the default surface is exactly the nine deployed tools",
		JSON.stringify([...listed].sort()) ===
			JSON.stringify([...DEFAULT_TOOLS].sort()),
		listed.join(",")
	);
	check(
		"platform_info.tools equals tools/list, exactly",
		JSON.stringify([...(payload.capabilities?.tools ?? [])].sort()) ===
			JSON.stringify([...listed].sort())
	);
	await client.close();
}

/* ------------------------------------------------------------------ */
section("2. a closed tool cannot be called at all");
/* ------------------------------------------------------------------ */
{
	const client = await connect(allOff());
	for (const name of GATED) {
		/*
		 * The SDK surfaces an unregistered tool as an isError RESULT carrying
		 * JSON-RPC -32602, not as a thrown exception — checked against the live
		 * SDK rather than assumed, because "it throws" would have made the
		 * assertion below vacuous in a try/catch.
		 *
		 * The property that matters is the SHAPE: no envelope. A gated tool
		 * that had run and relayed the upstream 404 would return
		 * `structuredContent` with a disclaimer and an `error.code`, and a
		 * client would read that as "the platform is down" rather than "this
		 * capability is not offered".
		 */
		const res = await client.callTool({ name, arguments: {} });
		check(`calling ${name} while gated is refused`, res.isError === true);
		check(
			`${name}'s refusal is a protocol error, not a relayed upstream 404`,
			res.structuredContent === undefined &&
				/-32602|not found/i.test(res.content?.[0]?.text ?? ""),
			JSON.stringify(res).slice(0, 200)
		);
	}
	await client.close();
}

/* ------------------------------------------------------------------ */
section("3. gate open: all three tools return");
/* ------------------------------------------------------------------ */
{
	const client = await connect(allOn());
	const listed = (await client.listTools()).tools.map((t) => t.name);
	for (const name of GATED) {
		check(`${name} present in tools/list when enabled`, listed.includes(name));
	}
	check(
		"the open surface is the default nine plus exactly these three",
		listed.length === DEFAULT_TOOLS.length + GATED.length,
		String(listed.length)
	);

	const payload = await info(client);
	for (const name of GATED) {
		check(
			`${name} present in platform_info.tools when enabled`,
			(payload.capabilities?.tools ?? []).includes(name)
		);
	}
	check(
		"platform_info.write_tools names the two writes when enabled",
		JSON.stringify([...(payload.capabilities?.write_tools ?? [])].sort()) ===
			JSON.stringify(["file_sponsor_inquiry", "request_memo"]),
		JSON.stringify(payload.capabilities?.write_tools)
	);
	check(
		"platform_info.read_only flips to false with a write registered",
		payload.capabilities?.read_only === false
	);
	await client.close();
}

/* ------------------------------------------------------------------ */
section("4. the two gates are independent");
/* ------------------------------------------------------------------ */
{
	// One flag must not open the other. They are routes on two different
	// unmerged branches and will not land on the same day.
	const client = await connect({
		...allOff(),
		COMMERTIZE_MCP_ENABLE_MEMO: "1",
		COMMERTIZE_MCP_DISABLE_MEMO: "",
	});
	const listed = (await client.listTools()).tools.map((t) => t.name);
	check("memo open => request_memo listed", listed.includes("request_memo"));
	check(
		"memo open does NOT open disclosure",
		!listed.includes("get_disclosure_package")
	);
	check(
		"memo open does NOT open the inquiry",
		!listed.includes("file_sponsor_inquiry")
	);
	await client.close();

	// And the newest gate opens nothing but itself.
	const inq = await connect({
		...allOff(),
		COMMERTIZE_MCP_ENABLE_INQUIRY: "1",
		COMMERTIZE_MCP_DISABLE_INQUIRY: "",
	});
	const listedInq = (await inq.listTools()).tools.map((t) => t.name);
	check(
		"inquiry open => only file_sponsor_inquiry joins the default set",
		JSON.stringify([...listedInq].sort()) ===
			JSON.stringify([...DEFAULT_TOOLS, "file_sponsor_inquiry"].sort()),
		listedInq.join(",")
	);
	await inq.close();
}

/* ------------------------------------------------------------------ */
section("5. the parse is fail-closed");
/* ------------------------------------------------------------------ */
{
	/*
	 * Every value here is one an operator plausibly types meaning "on". None of
	 * them may open the gate: a truthiness check would pass all six, and the
	 * whole point of a deployment gate is that a fat-fingered environment does
	 * not start advertising a 404.
	 */
	for (const value of ["true", "yes", "on", "TRUE", "1 ", " 1", "01", ""]) {
		const client = await connect(allOff(value));
		const listed = (await client.listTools()).tools.map((t) => t.name);
		check(
			`ENABLE=${JSON.stringify(value)} does not open any gate`,
			GATED.every((n) => !listed.includes(n)),
			listed.join(",")
		);
		await client.close();
	}

	// DISABLE beats ENABLE — the kill switch has to win, or it is not one.
	const killed = await connect(
		Object.fromEntries(
			Object.values(GATE_ENV).flatMap((g) => [
				[`COMMERTIZE_MCP_ENABLE_${g}`, "1"],
				[`COMMERTIZE_MCP_DISABLE_${g}`, "1"],
			])
		)
	);
	const listedKilled = (await killed.listTools()).tools.map((t) => t.name);
	check(
		"DISABLE=1 beats ENABLE=1 on every gate",
		GATED.every((n) => !listedKilled.includes(n)),
		listedKilled.join(",")
	);
	// Positive control for the whole section: the sweeps above read real tool
	// lists. Without this, a server that failed to start would score eight
	// clean passes.
	check(
		"control: the ungated tools were listed throughout",
		DEFAULT_TOOLS.every((n) => listedKilled.includes(n))
	);
	await killed.close();
}

process.exit(summary("gates e2e") === 0 ? 0 : 1);
