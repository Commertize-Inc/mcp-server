/**
 * Runs every suite in sequence and reports a single verdict.
 * Usage: npm test   (builds first)   |   node test/run-all.mjs
 *
 * ── `npm test` IS HERMETIC BY DEFAULT ─────────────────────────────────────
 *
 * Every suite below runs offline, against a local stub upstream or no upstream
 * at all — EXCEPT `stdio-e2e.mjs`, which opens real connections to
 * api.commertize.com and asserts on whatever production is serving that
 * minute. That is a genuinely useful suite and a terrible default: it fails on
 * a plane, it fails in a sandboxed CI runner, it fails when production is
 * mid-deploy, and none of those failures says anything about the code being
 * tested. A test suite that is red for reasons unrelated to the diff is a test
 * suite people learn to ignore.
 *
 * So it is OPT-IN: `COMMERTIZE_MCP_LIVE_TESTS=1 npm test` runs it, and without
 * that it is SKIPPED and the skip is PRINTED. A silent skip would be worse than
 * running it — somebody would eventually read "ALL SUITES PASSED" and believe
 * the live surface had been checked. (security review 2026-09-03, NOTE.)
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Only the exact string "1", the same fail-closed parse as the tool gates. */
const LIVE = process.env.COMMERTIZE_MCP_LIVE_TESTS === "1";

const SUITES = [
	["degradation (offline)", "api-down.mjs", { live: false }],
	["live stdio e2e (network)", "stdio-e2e.mjs", { live: true }],
	["screener unit (offline)", "screener-unit.mjs", { live: false }],
	["screener e2e (stub upstream)", "screener-e2e.mjs", { live: false }],
	["sandbox e2e (stub upstream)", "sandbox-e2e.mjs", { live: false }],
	["x402 e2e (stub upstream)", "x402-e2e.mjs", { live: false }],
	["disclosure e2e (stub upstream)", "disclosure-e2e.mjs", { live: false }],
	["deployment gates (offline)", "gates-e2e.mjs", { live: false }],
	["streamable http e2e (stub upstream)", "http-e2e.mjs", { live: false }],
	["client ip /64 bucketing (offline)", "client-ip.mjs", { live: false }],
	["language", "language-check.mjs", { live: false }],
];

const run = (file) =>
	new Promise((resolve) => {
		const child = spawn(process.execPath, [path.join(HERE, file)], {
			stdio: ["ignore", "inherit", "inherit"],
		});
		child.on("exit", (code) => resolve(code ?? 1));
	});

let failed = 0;
let skipped = 0;
let ran = 0;
for (const [label, file, opts] of SUITES) {
	if (opts.live && !LIVE) {
		console.log(`\n=== ${label} =====================================`);
		console.log(
			"SKIPPED — needs the network and a healthy api.commertize.com. " +
				"Run it with COMMERTIZE_MCP_LIVE_TESTS=1.",
		);
		skipped += 1;
		continue;
	}
	console.log(`\n=== ${label} =====================================`);
	const code = await run(file);
	ran += 1;
	if (code !== 0) failed += 1;
}

// The skip count is on the SAME line as the verdict, so nobody reads "ALL
// SUITES PASSED" and concludes the live surface was checked when it was not.
const verdict =
	failed === 0
		? `ALL ${ran} SUITES PASSED`
		: `${failed} of ${ran} SUITES FAILED`;
console.log(
	skipped === 0
		? `\n${verdict}`
		: `\n${verdict} — ${skipped} SKIPPED (set COMMERTIZE_MCP_LIVE_TESTS=1 to include the live suite)`,
);
process.exit(failed === 0 ? 0 : 1);
