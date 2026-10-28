// Package identity for npm (runbook OWNER_npm_publish_agent_kit_2026-10-28 O4):
// scoped name @commertize/mcp-server, publishable, tarball limited to the built
// server + README + LICENSE, lockfile in step, and the user-facing bin names
// unchanged so existing MCP client configs keep working. Offline, no deps.
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
let n = 0;
let failed = 0;
const check = (name, fn) => {
	try {
		fn();
		n++;
		console.log(`ok - ${name}`);
	} catch (e) {
		failed++;
		console.log(`not ok - ${name}: ${e.message.split("\n")[0]}`);
	}
};

check("scoped name", () => assert.equal(pkg.name, "@commertize/mcp-server"));
check("publishable (not private), public access, provenance", () => {
	assert.notEqual(pkg.private, true);
	assert.equal(pkg.publishConfig?.access, "public");
	assert.equal(pkg.publishConfig?.provenance, true);
});
check("files allowlist: dist, content (read at runtime by tools.ts:55), README.md, LICENSE", () => assert.deepEqual(pkg.files, ["dist", "content", "README.md", "LICENSE"]));
check("bin names unchanged", () => assert.deepEqual(Object.keys(pkg.bin).sort(), ["commertize-mcp-http", "commertize-mcp-server"]));
check("lockfile name in step", () => {
	assert.equal(lock.name, pkg.name);
	assert.equal(lock.packages[""].name, pkg.name);
});
console.log(`package-name: ${n}/${n + failed} ok`);
process.exitCode = failed ? 1 : 0;
