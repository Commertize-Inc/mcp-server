/**
 * Wording guard (legal review of the agent-surface wording, 2026-10-16).
 *
 * Fails if "verified", "verify", "verification", "vetted" or "audited" appears
 * in any user-facing string: README, package.json description, the skill and
 * content markdown, and string literals in src/. Exempt per the cert: code
 * identifiers, protocol names and paths (verifyTypedData, POST /verify,
 * /api/agents/signing/verify), env var names, error codes
 * (verifier_unavailable, verifier_not_configured, verify_rate_limited), the
 * /health key verifier_configured, class names, comments and tests.
 * Inline code spans in markdown are identifiers and are exempt too.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BARRED = /\b(verif\w*|vetted|audited)\b/gi;
const EXEMPT = new Set([
	"verifytypeddata", "verifier_unavailable", "verifier_not_configured",
	"verify_rate_limited", "verifier_configured", "verifier", "verifyurl",
]);

let failed = 0;
const hits = [];
const scan = (file, text) => {
	for (const m of text.matchAll(BARRED)) {
		if (EXEMPT.has(m[1].toLowerCase())) continue;
		const ctx = text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, " ");
		hits.push(`${path.relative(ROOT, file)}: "${m[1]}" in …${ctx}…`);
	}
};

/** Markdown: drop fenced blocks, inline code spans and paths ending in /verify. */
const prose = (md) =>
	md.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ").replace(/\/verify\b/g, " ");

/** TS: drop comments, keep only string-literal contents. */
const literals = (ts) => {
	const noComments = ts.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
	const out = [];
	for (const m of noComments.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
		out.push((m[1] ?? m[2] ?? m[3] ?? "").replace(/\$\{[^}]*\}/g, " ").replace(/\/verify\b/g, " "));
	}
	return out.join("\n");
};

const walk = (dir, ext) =>
	readdirSync(dir).flatMap((n) => {
		const p = path.join(dir, n);
		return statSync(p).isDirectory() ? walk(p, ext) : p.endsWith(ext) ? [p] : [];
	});

scan("README.md", prose(readFileSync(path.join(ROOT, "README.md"), "utf8")));
scan("package.json", JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).description ?? "");
for (const d of ["commertize-skill", "content"]) for (const f of walk(path.join(ROOT, d), ".md")) scan(f, prose(readFileSync(f, "utf8")));
for (const f of walk(path.join(ROOT, "src"), ".ts")) scan(f, literals(readFileSync(f, "utf8")));

// Negative control: the guard must catch a planted barred word, or it is not a guard.
const before = hits.length;
scan("<control>", literals('const x = "open to verified investors";'));
const caught = hits.length === before + 1;
hits.length = before;

if (!caught) { console.log("FAIL guard did not catch the planted control string"); failed += 1; }
for (const h of hits) { console.log(`FAIL ${h}`); failed += 1; }
console.log(failed === 0 ? "PASS wording guard: no barred words in user-facing strings (control caught)" : `${failed} wording-guard failure(s)`);
process.exit(failed === 0 ? 0 : 1);
