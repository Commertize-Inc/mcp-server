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

section("glama.json");
{
	const g = JSON.parse(await readFile(path.join(ROOT, "glama.json"), "utf8"));
	check("schema is Glama's server schema", g.$schema === "https://glama.ai/mcp/schemas/server.json", g.$schema);
	check("at least one maintainer", Array.isArray(g.maintainers) && g.maintainers.length >= 1 && g.maintainers.every((m) => typeof m === "string" && m.length > 0));
}

process.exit(summary("readme profile") === 0 ? 0 : 1);
