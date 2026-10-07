/**
 * Banned-language check.
 *
 * House rule: no performance promises in anything we publish. This scans the
 * prose that actually reaches a reader — the curated platform text, the
 * README, the skill draft, the disclaimer, and the tool titles/descriptions
 * and server instructions as the protocol reports them (not as they appear in
 * source, so a rename can't sneak past).
 *
 * HARD failures are unambiguous promotional finance terms. WARN terms are
 * words with legitimate technical uses ("the tool returns X"); they are
 * printed for a human to eyeball rather than failed automatically, because a
 * check that cries wolf gets disabled.
 */

import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { check, connect, resetCounters, section, summary } from "./harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
];

const WARN = [/\breturns?\b/i, /\bprofit(s|able)?\b/i];

/**
 * Phrases that are the OPPOSITE of the thing a ban exists to catch.
 *
 * The `guarantee` ban is there to stop us PROMISING something. the legal review's ratified
 * memo disclaimer (2026-09-02) says "The turnaround is a target, not a
 * guarantee" — a disclaimer, which the ban was flagging as promotional. Rather
 * than reword ratified disclaimer text or exempt a whole file, the negated forms
 * are removed before the scan runs, and the bans then apply to everything left.
 *
 * Deliberately narrow: only the explicit negations, only for `guarantee`. A
 * bare "guaranteed 8%" still trips, and `language-check` asserts that below so
 * this allowance cannot quietly become a hole.
 */
const NEGATED_ALLOWANCES = [
	/\bnot a guarantee\b/gi,
	/\bno guarantee(s)?\b/gi,
	/\b(is|are) not guaranteed\b/gi,
	/\b(cannot|can't|does not|do not|doesn't|don't) guarantee\b/gi,
];

/** Strip the negated forms so a ban cannot read a disclaimer as a promise. */
const stripNegations = (text) =>
	NEGATED_ALLOWANCES.reduce((acc, re) => acc.replace(re, " "), text);

const scan = (label, text) => {
	const scanned = stripNegations(text);
	const hits = [];
	for (const re of BANNED) {
		const m = scanned.match(new RegExp(re.source, "gi"));
		if (m) hits.push(...m);
	}
	check(`${label}: no banned language`, hits.length === 0, hits.join(", "));

	const warns = [];
	for (const re of WARN) {
		const m = scanned.match(new RegExp(re.source, "gi"));
		if (m) warns.push(...m);
	}
	if (warns.length) {
		console.log(`       note ${label}: review-by-eye terms present: ${[...new Set(warns)].join(", ")}`);
	}
};

resetCounters();

section("authored prose files");
for (const rel of [
	"content/platform-info.md",
	"README.md",
	"commertize-skill/SKILL.md",
]) {
	let text;
	try {
		text = await readFile(path.join(ROOT, rel), "utf8");
	} catch {
		check(`${rel}: exists`, false, "file missing");
		continue;
	}
	check(`${rel}: exists`, true);
	scan(rel, text);
}

section("protocol-visible metadata");
{
	const client = await connect();
	const { tools } = await client.listTools();
	for (const t of tools) {
		scan(`tool:${t.name}`, `${t.title ?? ""} ${t.description ?? ""} ${JSON.stringify(t.outputSchema ?? {})}`);
	}

	const info = await client.callTool({ name: "platform_info", arguments: {} });
	const payload = info.structuredContent ?? JSON.parse(info.content[0].text);
	scan("platform_info.markdown", payload.markdown ?? "");
	scan("disclaimer", payload.disclaimer ?? "");
	await client.close();
}

/**
 * The GATED tools' prose, scanned too.
 *
 * The default connection above lists only what an unconfigured server
 * registers, so every gated tool's title and description would ship unread by
 * this check — and the first draft of `sandbox_universe` said "no returns,
 * yields, cap rates" inside a sentence promising their absence, which the
 * banned-word scan would have caught and did not, because the tool was not
 * listed. Prose an operator can turn on is prose that reaches a reader.
 */
section("protocol-visible metadata behind every gate");
{
	const client = await connect({
		COMMERTIZE_MCP_ENABLE_OFFERINGS: "1",
		COMMERTIZE_MCP_DISABLE_OFFERINGS: "",
		COMMERTIZE_MCP_ENABLE_SANDBOX: "1",
		COMMERTIZE_MCP_DISABLE_SANDBOX: "",
		COMMERTIZE_MCP_ENABLE_X402: "1",
		COMMERTIZE_MCP_DISABLE_X402: "",
		COMMERTIZE_MCP_ENABLE_MEMO: "1",
		COMMERTIZE_MCP_DISABLE_MEMO: "",
		COMMERTIZE_MCP_ENABLE_DISCLOSURE: "1",
		COMMERTIZE_MCP_DISABLE_DISCLOSURE: "",
		COMMERTIZE_MCP_ENABLE_INQUIRY: "1",
		COMMERTIZE_MCP_DISABLE_INQUIRY: "",
	});
	const { tools } = await client.listTools();
	// Positive control: if a gate silently stopped opening, this sweep would
	// scan the same short list as the block above and report a clean bill of
	// health for text it never read.
	check(
		"the gated tools are listed for scanning",
		tools.some((t) => t.name.startsWith("sandbox_")) &&
			tools.some((t) => t.name.startsWith("x402_")) &&
			// The two deployment-gated tools carry the longest prose in the
			// server; leaving them out of this sweep is exactly the hole the
			// docblock above describes.
			tools.some((t) => t.name === "request_memo") &&
			tools.some((t) => t.name === "get_disclosure_package") &&
			tools.some((t) => t.name === "file_sponsor_inquiry"),
		tools.map((t) => t.name).join(",")
	);
	for (const t of tools) {
		scan(
			`gated tool:${t.name}`,
			`${t.title ?? ""} ${t.description ?? ""} ${JSON.stringify(t.outputSchema ?? {})}`
		);
	}
	await client.close();
}

section("no internal flags in shipped prose");
{
	// Mirrors the strip-internal-flags rule for anything that leaves the
	// building: no internal codenames or gate labels in agent-facing text.
	const INTERNAL = [
		// Two codenames are assembled from fragments so this file does not spell them.
		new RegExp("\\b" + ["AE", "GIS"].join("") + "\\b"),
		new RegExp("\\b" + ["RU", "NE"].join("") + "\\.CTZ\\b"),
		/\bMINT\b/,
		/\bDEAL DESK\b/,
		/\bGate0\b/i,
		/\bcounsel-gated\b/i,
		/\bH1\b|\bM[124]\b/,
	];
	for (const rel of ["content/platform-info.md", "commertize-skill/SKILL.md"]) {
		const text = await readFile(path.join(ROOT, rel), "utf8").catch(() => "");
		const hits = INTERNAL.filter((re) => re.test(text)).map((re) => String(re));
		check(`${rel}: no internal codenames`, hits.length === 0, hits.join(", "));
	}
}

/* ---------------------------------------------------------------- */
section("the negated-form allowance is narrow");
{
	/**
	 * Guard for the guard added 2026-09-02. An allowance that swallowed the whole
	 * `guarantee` family would silently disable the ban it was carved out of, so
	 * a real promise is checked here directly.
	 */
	const trips = (text) => {
		const scanned = stripNegations(text);
		return BANNED.some((re) => new RegExp(re.source, "gi").test(scanned));
	};

	check(
		"allows the ratified disclaimer's negation",
		!trips("The turnaround is a target, not a guarantee.")
	);
	check("allows 'no guarantee'", !trips("There is no guarantee of any outcome."));
	check(
		"allows 'cannot guarantee'",
		!trips("We cannot guarantee a turnaround time.")
	);
	check("still bans a bare promise", trips("Guaranteed 8% to every investor."));
	check("still bans 'we guarantee'", trips("We guarantee delivery in two days."));
	check(
		"still bans the other families",
		trips("Risk-free passive income with attractive returns.")
	);
}

process.exit(summary("language") === 0 ? 0 : 1);
