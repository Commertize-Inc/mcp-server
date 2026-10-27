/**
 * The public README is directory copy: Glama and other registries republish it
 * as-is. This suite pins three things about it.
 *
 *   1. The tool table names exactly the tools a default build registers AND
 *      that return data today (no offering, sponsor, memo, inquiry, sandbox
 *      or x402 tool appears anywhere in the file).
 *   2. The title, description and disclaimer lines are byte-identical to the
 *      certified strings (sha1 prefix ids), so an edit cannot drift them.
 *   3. glama.json is valid JSON naming the schema and at least one maintainer.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { check, connect, resetCounters, section, summary } from "./harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apx = (s) => "apx-" + createHash("sha1").update(s, "utf8").digest("hex").slice(0, 10);

const README = await readFile(path.join(ROOT, "README.md"), "utf8");
const lines = README.split("\n");

resetCounters();

section("certified strings, byte-exact");
{
	check("title line is '# ' + apx-63c25d432e", lines[0].startsWith("# ") && apx(lines[0].slice(2)) === "apx-63c25d432e", lines[0]);
	check("description line is apx-2965904744", lines.some((l) => apx(l) === "apx-2965904744"));
	check("disclaimer line is apx-92c1f4514d", lines.some((l) => apx(l) === "apx-92c1f4514d"));
	const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
	check("package.json description is apx-2965904744", apx(pkg.description) === "apx-2965904744", pkg.description);
}

section("tool table = working default tools");
const WORKING = ["get_news", "get_article", "platform_info"];
{
	const start = lines.indexOf("## Tools");
	const table = [];
	for (let i = start + 1; i < lines.length && !lines[i].startsWith("## "); i++) {
		const m = /^\| `([a-z_0-9]+)` \|/.exec(lines[i]);
		if (m) table.push(m[1]);
	}
	check("README has a '## Tools' section", start >= 0);
	check("table lists exactly the working tools", JSON.stringify(table) === JSON.stringify(WORKING), table.join(","));

	const client = await connect();
	const { tools } = await client.listTools();
	await client.close();
	const registered = new Set(tools.map((t) => t.name));
	for (const name of table) {
		check(`${name} is registered by a default build`, registered.has(name));
	}

	// Every OTHER registered or gated tool name must be absent from the file,
	// so the README can never advertise a tool that refuses or is unregistered.
	const gatedClient = await connect({
		COMMERTIZE_MCP_ENABLE_OFFERINGS: "1",
		COMMERTIZE_MCP_ENABLE_SANDBOX: "1",
		COMMERTIZE_MCP_ENABLE_X402: "1",
		COMMERTIZE_MCP_ENABLE_MEMO: "1",
		COMMERTIZE_MCP_ENABLE_DISCLOSURE: "1",
		COMMERTIZE_MCP_ENABLE_INQUIRY: "1",
	});
	const all = (await gatedClient.listTools()).tools.map((t) => t.name);
	await gatedClient.close();
	check("positive control: the gated sweep sees more than the working set", all.length > WORKING.length + 10, String(all.length));
	const leaked = all.filter((n) => !WORKING.includes(n) && README.includes(n));
	check("no non-working tool name appears anywhere in README", leaked.length === 0, leaked.join(","));
}

section("README carries no dated route-verification claim and no single-class lead");
{
	check("no 'Verified against' route table", !/Verified against `?api\.commertize\.com/i.test(README));
	check("no 'real estate' in README", !/real[- ]estate/i.test(README));
}

// legal review RULING_verification_noun_2026-10-24 §1: no /verif/i in any form in
// copy a reader sees. The README, glama.json, package.json and the bundled
// skill/content files are republished by directories, so all of them count.
section("no 'verif' stem in any republished file");
{
	const { readdir } = await import("node:fs/promises");
	const walk = async (d) => {
		const out = [];
		for (const e of await readdir(path.join(ROOT, d), { withFileTypes: true })) {
			const rel = path.join(d, e.name);
			if (e.isDirectory()) out.push(...(await walk(rel)));
			else out.push(rel);
		}
		return out;
	};
	const files = ["README.md", "glama.json", "package.json", ...(await walk("commertize-skill")), ...(await walk("content"))];
	const hits = [];
	for (const f of files) {
		const text = f === "package.json" ? JSON.parse(await readFile(path.join(ROOT, f), "utf8")).description ?? "" : await readFile(path.join(ROOT, f), "utf8");
		if (/verif/i.test(text)) hits.push(f);
	}
	check("scanned the README, glama.json, package.json and both trees", files.length >= 5 && files.includes("content/platform-info.md"), files.join(","));
	check("no file carries the stem", hits.length === 0, hits.join(","));
	check("control: the scan catches the stem", /verif/i.test("Identity Verification"));
}

// Built is not deployed: until /mcp/public is live with its flag on, the
// README describes only the stdio install. listing review adds the remote section,
// through legal review, on deploy day, and this check changes in the same diff.
section("README names no remote endpoint before it is live");
{
	check("no /mcp/public and no agents.commertize.com URL in README", !/\/mcp\/public|agents\.commertize\.com/i.test(README));
}

// legal review RULING agent-adoption MCP contracts 2026-10-15, R3-a..R3-d + pin.
// The README names no parked surface (inquiries), no gated product area
// (x402, sandbox, screener), no link to the uncertified agent skill, and no
// key a reader cannot obtain. Each check is a whole-file count, case-blind.
section("legal review R3: no parked or gated surface, no key, no extra links");
{
	for (const word of ["inquir", "x402", "sandbox", "screener", "agent-skill", "Bearer"]) {
		const count = README.toLowerCase().split(word.toLowerCase()).length - 1;
		check(`'${word}' appears 0 times`, count === 0, String(count));
	}
	check("no 'anonymous mode' sentence (R3-a; false once /mcp/public exists)", !/anonymous mode/i.test(README));
	check("no Public API link line (R3-c)", !lines.some((l) => l.startsWith("- Public API:")));
	const testsText =
		"Runs the offline suites. The live-network suite is opt-in: `COMMERTIZE_MCP_LIVE_TESTS=1 npm test`, or\n`npm run test:live` on its own.";
	check("tests paragraph is apx-26d3e728af (R3-d)", apx(testsText) === "apx-26d3e728af" && README.includes(`\n${testsText}\n`));
	check("closing line is apx-c570061e40 (R3-e)", lines.some((l) => apx(l) === "apx-c570061e40"));
	check("License line is apx-9706e81edd", lines.some((l) => apx(l) === "apx-9706e81edd"));
	check("Privacy link is apx-e6bdd33092", lines.some((l) => apx(l) === "apx-e6bdd33092"));
}

section("glama.json");
{
	const g = JSON.parse(await readFile(path.join(ROOT, "glama.json"), "utf8"));
	check("schema is Glama's server schema", g.$schema === "https://glama.ai/mcp/schemas/server.json", g.$schema);
	check("at least one maintainer", Array.isArray(g.maintainers) && g.maintainers.length >= 1 && g.maintainers.every((m) => typeof m === "string" && m.length > 0));
}

process.exit(summary("readme profile") === 0 ? 0 : 1);
