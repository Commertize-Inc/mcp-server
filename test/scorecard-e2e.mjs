/**
 * `tokenizability_check` end to end, offline (AXIOM ruling 2026-10-15 §4).
 *
 * A LOCAL stub plays the backend's `POST /scorecard/check` (commertize.com
 * #700); the tool runs on the real stdio and public servers, in process.
 *
 *   1. GATE: default closed on every surface; open = stdio + public, never
 *      the keyed /mcp; the public surface lists it only while open (DIR-1).
 *   2. STRINGS: name, title, description, every question, option, document
 *      row and error are the certified bytes (ids pinned HERE as literals).
 *   3. C4-2: every input is a closed choice; no free-text field anywhere.
 *   4. CONTRACT: alias mapped server-side (F-5), result = ids before F-1 in
 *      order with F-2 last, F-1 is the disclaimer, block text_id = F-1,
 *      scorecard_version "0.1", source_url = site root, documents echo.
 *   5. FAIL CLOSED: unknown id, wrong version, F-1 missing or not last,
 *      backend 400/404/429/5xx, docs on a non-RE class, SDK arg errors.
 *   6. C4-3: S-2 deny list over the FULL serialized responses and tools/list.
 *   7. C4-1: no answer value in any log line, console write or stderr.
 *   8. C4-4: no class-to-bucket table in this repo's source, tests or docs.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createServer as createNodeServer } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { check, connect, resetCounters, section, summary } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DIST = path.join(ROOT, "dist");
const apx = (s) => "apx-" + createHash("sha1").update(s, "utf8").digest("hex").slice(0, 10);

/* ---- stub backend ------------------------------------------------- */
let next = { status: 200, body: null };
const received = [];
const upstream = createNodeServer((req, res) => {
	const url = new URL(req.url, "http://stub");
	let raw = "";
	req.on("data", (c) => (raw += c));
	req.on("end", () => {
		const json = (status, body) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		};
		if (req.method === "POST" && url.pathname === "/scorecard/check") {
			received.push(JSON.parse(raw));
			return json(next.status, next.body);
		}
		if (url.pathname === "/api/news") return json(200, { data: [] });
		json(404, { error: "not_found" });
	});
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;
process.env.COMMERTIZE_API_BASE_URL = UPSTREAM;
process.env.COMMERTIZE_MCP_ENABLE_SCORECARD = "1";

const { createServer } = await import(path.join(DIST, "index.js"));
const { createPublicHttpHandler, PUBLIC_PATH } = await import(path.join(DIST, "httpPublic.js"));
const { FixedWindowLimiter } = await import(path.join(DIST, "httpRateLimit.js"));
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const inProc = async (surface) => {
	const s = createServer(surface);
	const [a, b] = InMemoryTransport.createLinkedPair();
	await s.connect(a);
	const c = new Client({ name: "scorecard-e2e", version: "0" });
	await c.connect(b);
	return c;
};

const events = [];
const handler = createPublicHttpHandler({
	enabled: () => true,
	ipLimiter: new FixedWindowLimiter(10_000, 60_000),
	createServer: () => createServer("public"),
	log: (e) => events.push(e),
	maxBodyBytes: 65_536,
});
const pubServer = createNodeServer((req, res) => void handler(req, res));
await new Promise((r) => pubServer.listen(0, "127.0.0.1", r));
const URL_PUBLIC = `http://127.0.0.1:${pubServer.address().port}${PUBLIC_PATH}`;
let rpcId = 0;
const rpc = async (method, params) => {
	const r = await fetch(URL_PUBLIC, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-vercel-forwarded-for": "198.51.100.9" },
		body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
	});
	return { status: r.status, body: await r.json().catch(() => null) };
};
const pubCall = async (args) => (await rpc("tools/call", { name: "tokenizability_check", arguments: args })).body?.result;

/* ---- certified ids, pinned here as literals ----------------------- */
const F1 = "apx-ae7d0aacc7";
const F2 = "apx-09c32736e2";
const NOW = "apx-ac50a6dc09";
const LIFT = "apx-b7d9de2717";
const L_LEN = "apx-3660e37e2f";
const INCOMPLETE = "apx-67908e9f07";
const MISSING_Q2 = "apx-d29b96056c";
const SERVED = [];
const keep = (x) => (SERVED.push(JSON.stringify(x)), x);

const PASS = {
	q1_class: "cre_multifamily",
	q2_title: "single_entity_this_asset",
	q3_cashflow: "contracted_third_party",
	q4_valuation: "independent_appraisal_or_index",
	q5_custody: "recorded_title_or_registry",
	q6_encumbrance: "none",
	q7_evidence: "third_party_generated",
	q8_band: "10m_to_500m",
};
const ok = (ids) => ({ status: 200, body: { rubric: "0.1", sentence_ids: ids } });

resetCounters();

/* ------------------------------------------------------------------ */
section("1. gate: default closed; open = stdio + public, never keyed /mcp");
{
	const parse = (env) =>
		spawnSync(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(path.join(DIST, "config.js"))}).then(m=>process.stdout.write(String(m.config.scorecardDisabled)))`], {
			env: { PATH: process.env.PATH, ...env },
			encoding: "utf8",
		}).stdout.trim();
	check("unset -> closed", parse({}) === "true");
	for (const v of ["", "true", "yes", " 1", "1 ", "01"]) check(`ENABLE=${JSON.stringify(v)} -> closed`, parse({ COMMERTIZE_MCP_ENABLE_SCORECARD: v }) === "true");
	check("ENABLE=1 -> open", parse({ COMMERTIZE_MCP_ENABLE_SCORECARD: "1" }) === "false");
	check("ENABLE=1 + DISABLE=1 -> closed", parse({ COMMERTIZE_MCP_ENABLE_SCORECARD: "1", COMMERTIZE_MCP_DISABLE_SCORECARD: "1" }) === "true");

	const closed = await connect({ COMMERTIZE_MCP_ENABLE_SCORECARD: "" });
	check("closed: stdio does not list it", !(await closed.listTools()).tools.some((x) => x.name === "tokenizability_check"));
	await closed.close();
	const pubClosed = spawnSync(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(path.join(DIST, "publicSurface.js"))}).then(m=>process.stdout.write(String(m.isPublicTool("tokenizability_check"))))`], { env: { PATH: process.env.PATH }, encoding: "utf8" }).stdout.trim();
	check("closed: the public pre-dispatch check refuses it", pubClosed === "false", pubClosed);

	const stdio = await inProc("stdio");
	check("open: stdio lists it", (await stdio.listTools()).tools.some((x) => x.name === "tokenizability_check"));
	const capS = (await stdio.callTool({ name: "platform_info", arguments: {} })).structuredContent?.capabilities;
	check("open: stdio platform_info names it", capS?.tools?.includes("tokenizability_check"));
	await stdio.close();
	const keyed = await inProc("http");
	check("open: keyed http never lists it", !(await keyed.listTools()).tools.some((x) => x.name === "tokenizability_check"));
	const capK = (await keyed.callTool({ name: "platform_info", arguments: {} })).structuredContent?.capabilities;
	check("open: keyed platform_info does not name it", !capK?.tools?.includes("tokenizability_check"));
	await keyed.close();
	const list = (await rpc("tools/list", {})).body?.result?.tools ?? [];
	check("open: public lists exactly the three reads + it", JSON.stringify(list.map((x) => x.name).sort()) === JSON.stringify(["get_article", "get_news", "platform_info", "tokenizability_check"]), list.map((x) => x.name).join(","));
	const capP = (await rpc("tools/call", { name: "platform_info", arguments: {} })).body?.result?.structuredContent?.capabilities;
	check("open: public platform_info names it (C2-1 stays true)", capP?.tools?.includes("tokenizability_check"));
}

/* ------------------------------------------------------------------ */
section("2-3. certified strings; closed choices only (C4-2)");
let TOOL;
{
	const mod = await import(path.join(DIST, "scorecardTool.js"));
	const bad = Object.entries(mod.CERT).filter(([id, text]) => apx(text) === id ? false : true);
	check("every CERT entry hashes to its id, and the load-time check agrees", bad.length === 0 && mod.CERT_INTEGRITY_OK === true && Object.keys(mod.CERT).length === 104, `${bad.map(([i]) => i).join(",")} n=${Object.keys(mod.CERT).length}`);
	const list = (await rpc("tools/list", {})).body?.result?.tools ?? [];
	TOOL = list.find((x) => x.name === "tokenizability_check");
	SERVED.push(JSON.stringify(TOOL));
	check("name is apx-887f96a180", apx(TOOL?.name ?? "") === "apx-887f96a180");
	check("title is apx-2869d443af", apx(TOOL?.title ?? "") === "apx-2869d443af", TOOL?.title);
	check("description is apx-46f7925268 (S3 redline)", apx(TOOL?.description ?? "") === "apx-46f7925268");
	const props = TOOL?.inputSchema?.properties ?? {};
	const Q_IDS = { q1_class: "apx-0e5412406d", q2_title: "apx-cafb1121e6", q3_cashflow: "apx-42bd751c57", q4_valuation: "apx-39096d175d", q5_custody: "apx-38ce58f6ef", q6_encumbrance: "apx-861deb578b", q7_evidence: "apx-2d1d0eeb0b", q8_band: "apx-57502c8645" };
	check("inputs are exactly q1..q8 + docs", JSON.stringify(Object.keys(props).sort()) === JSON.stringify([...Object.keys(Q_IDS), "docs"].sort()), Object.keys(props).join(","));
	for (const [f, id] of Object.entries(Q_IDS)) check(`${f} description is ${id}`, apx(props[f]?.description ?? "") === id, props[f]?.description);
	check("q1..q8 are required; docs is optional", JSON.stringify([...(TOOL?.inputSchema?.required ?? [])].sort()) === JSON.stringify(Object.keys(Q_IDS).sort()));

	const options = (p) => p?.anyOf ?? p?.oneOf ?? [];
	const LABELS = new Set([
		"apx-f8ec23577c","apx-0fcfaccb4b","apx-f84b4b2f26","apx-dc3a66f4d8","apx-10119a892b","apx-db959fc143","apx-67a99446d4","apx-f8fa324282","apx-42b95f0a34","apx-99f9c713a1","apx-bde6b65f26","apx-71efc0ca53","apx-be025bc085","apx-e38b34cbf5","apx-11ed5303d3","apx-b237e4122c","apx-593ebdfc93","apx-ad26aa9c40","apx-fc0278f95e","apx-92b65ae751","apx-9cdf42fba8","apx-6e6a6f2086",
		"apx-eaf44855da","apx-d264b6fefe","apx-23382604a2","apx-96c0880f04","apx-20c47c9167",
		"apx-4b350c8c3d","apx-018f2ad03b","apx-077c5a1b5f","apx-dd1fde4181",
		"apx-2ec065b4e6","apx-792d376575","apx-4f5dc2bb1f","apx-ebb3eea6ac",
		"apx-458aec37d7","apx-75e79c5110","apx-a267107629","apx-55108f1118",
		"apx-265dcc1081","apx-99357dc24f","apx-b9dc1682f2","apx-3380ae9f5b",
		"apx-f81d909535","apx-b532fa50d9","apx-33d7fc36a9","apx-80e9901fb4",
		"apx-802bc4c730","apx-a09109bf6c","apx-c2425cd56a","apx-b81508f179",
	]);
	const counts = { q1_class: 22, q2_title: 5, q3_cashflow: 4, q4_valuation: 4, q5_custody: 4, q6_encumbrance: 5, q7_evidence: 4, q8_band: 4 };
	for (const [f, n] of Object.entries(counts)) {
		const o = options(props[f]);
		check(`${f}: ${n} closed options, each {const, title} with a certified S-1 label`, o.length === n && o.every((x) => typeof x.const === "string" && LABELS.has(apx(x.title ?? ""))), JSON.stringify(o).slice(0, 160));
	}
	const q6 = options(props.q6_encumbrance).map((x) => x.const);
	check("F-5: q6 offers lender_consented_in_writing, not the internal key", q6.includes("lender_consented_in_writing") && !q6.includes("lender_consent_in_hand_or_expected"));
	const q1 = options(props.q1_class).map((x) => x.const);
	check("q1 follows S-1 order (other last; no class grouping beyond S-1)", q1[0] === "cre_multifamily" && q1[21] === "other" && q1[18] === "collectible_fractional_pool");

	const docs = props.docs;
	check("docs description is apx-faa0615547 (S4 redline)", apx(docs?.description ?? "") === "apx-faa0615547", docs?.description);
	const DOCS = { "RE-01": "apx-c6abde3660", "RE-06": "apx-a8e9f6e36c", "RE-09": "apx-2097f7a3b3", "RE-12": "apx-239b0d88a4", "RE-19": "apx-c7f79c2e1a", "RE-20": "apx-45c6034dee", "RE-24": "apx-092a161796", "RE-27": "apx-5d691fa896", "RE-29": "apx-cc8bdceab3", "RE-31": "apx-5d98c5203b", "RE-35": "apx-e8a5d909aa", "RE-36": "apx-1693de0c13" };
	check("docs: exactly the 12 RE rows, additionalProperties false", JSON.stringify(Object.keys(docs?.properties ?? {})) === JSON.stringify(Object.keys(DOCS)) && docs?.additionalProperties === false);
	const OPT = new Set(["apx-3d91c18d32", "apx-8de95fd5b4", "apx-67c4d0506a"]);
	check("docs rows: certified label + have/not_yet/na with DOC.opt titles", Object.entries(DOCS).every(([d, id]) => apx(docs.properties[d]?.description ?? "") === id && options(docs.properties[d]).length === 3 && options(docs.properties[d]).every((x) => OPT.has(apx(x.title ?? "")))));
	check("F-4: DOC.nonRE and DOC.note never on this tool", !JSON.stringify(TOOL).includes("The desk will"));

	// C4-2: walk every leaf; nothing accepts free text.
	const leaves = [];
	const walk = (s) => {
		if (!s || typeof s !== "object") return;
		if (s.properties) Object.values(s.properties).forEach(walk);
		else if (s.anyOf || s.oneOf) leaves.push(s);
		else leaves.push(s);
	};
	walk(TOOL?.inputSchema);
	check("C4-2: every input leaf is a closed set of consts (no free text)", leaves.length === 20 && leaves.every((l) => options(l).length > 0 && options(l).every((x) => "const" in x)), String(leaves.length));
	check("C4-2: top level rejects unknown fields", TOOL?.inputSchema?.additionalProperties === false);
}

/* ------------------------------------------------------------------ */
section("4. contract (stdio and public)");
{
	next = ok([NOW, F2, F1]);
	received.length = 0;
	const r = keep(await pubCall(PASS));
	const s = r?.structuredContent;
	check("200 path: not an error", r?.isError !== true && s?.error === null, JSON.stringify(s?.error));
	check("output keys are exactly the certified set, in order", JSON.stringify(Object.keys(s ?? {})) === JSON.stringify(["result", "documents_marked_not_yet", "documents_note", "scorecard_version", "as_of", "source_url", "disclaimer", "disclaimer_block", "error"]), Object.keys(s ?? {}).join(","));
	check("result = ids before F-1, text by id, F-2 last", JSON.stringify(s?.result?.map((x) => x.id)) === JSON.stringify([NOW, F2]) && s.result.every((x) => apx(x.text) === x.id));
	check("disclaimer is F-1 only (AXIOM F-2)", apx(s?.disclaimer ?? "") === F1);
	check("disclaimer_block text_id = F-1, values certified", JSON.stringify(s?.disclaimer_block) === JSON.stringify({ schema: "commertize.disclaimer/1", text_id: F1, informational_only: true, is_offer: false, is_solicitation: false, is_recommendation: false, is_advice: false, confers_authority_to_transact: false }));
	check("scorecard_version is \"0.1\" (no codename)", s?.scorecard_version === "0.1");
	check("source_url is the site root until /tokenize is live", s?.source_url === "https://commertize.com", s?.source_url);
	check("RE class with no docs: documents_marked_not_yet [] and no note", JSON.stringify(s?.documents_marked_not_yet) === "[]" && s?.documents_note === null);
	check("text content agrees with structuredContent", JSON.stringify(JSON.parse(r.content[0].text)) === JSON.stringify(s));
	check("backend got {v:1, answers} with the scorer's keys and no docs", JSON.stringify(received[0]) === JSON.stringify({ v: 1, answers: PASS }));

	next = ok([LIFT, L_LEN, F2, F1]);
	received.length = 0;
	const alias = keep(await pubCall({ ...PASS, q6_encumbrance: "lender_consented_in_writing", docs: { "RE-09": "not_yet", "RE-01": "have", "RE-36": "not_yet" } }));
	check("F-5: alias sent as lender_consent_in_hand_or_expected", received[0]?.answers?.q6_encumbrance === "lender_consent_in_hand_or_expected");
	check("docs sent as all 12 rows, unanswered = null", Object.keys(received[0]?.docs ?? {}).length === 12 && received[0].docs["RE-09"] === "not_yet" && received[0].docs["RE-06"] === null);
	const marked = alias?.structuredContent?.documents_marked_not_yet;
	check("documents_marked_not_yet: S-1 order, certified labels", JSON.stringify(marked) === JSON.stringify([{ doc: "RE-09", id: "apx-2097f7a3b3", text: "Independent appraisal" }, { doc: "RE-36", id: "apx-1693de0c13", text: "Ownership chart for every entity that holds the asset" }]), JSON.stringify(marked));

	next = ok([NOW, F2, F1]);
	const nonRe = keep(await pubCall({ ...PASS, q1_class: "farmland" }));
	check("non-RE: documents_marked_not_yet null, documents_note T1-S5", nonRe?.structuredContent?.documents_marked_not_yet === null && JSON.stringify(nonRe?.structuredContent?.documents_note) === JSON.stringify({ id: "apx-7802b82794", text: "This tool lists documents for commercial-property asset types only." }));

	next = ok([INCOMPLETE, MISSING_Q2, F1]);
	const inc = keep(await pubCall({ ...PASS, q2_title: "unsure" }));
	check("INCOMPLETE: no F-2, the missing item follows the lead", JSON.stringify(inc?.structuredContent?.result?.map((x) => x.id)) === JSON.stringify([INCOMPLETE, MISSING_Q2]));

	const stdio = await inProc("stdio");
	next = ok([NOW, F2, F1]);
	const st = keep(await stdio.callTool({ name: "tokenizability_check", arguments: PASS }));
	check("stdio: same contract, F-1 disclaimer (no public swap)", apx(st?.structuredContent?.disclaimer ?? "") === F1 && st?.structuredContent?.result?.length === 2);
	await stdio.close();
}

/* ------------------------------------------------------------------ */
section("5. fail closed");
{
	const refusal = (r, code, msgId) => {
		const s = r?.structuredContent;
		return r?.isError === true && s?.error?.code === code && (msgId === null ? s.error.message === null : apx(s.error.message ?? "") === msgId) && JSON.stringify(s.result) === "[]" && apx(s.disclaimer ?? "") === F1 && s.disclaimer_block?.text_id === F1;
	};
	received.length = 0;
	const docsNonRe = keep(await pubCall({ ...PASS, q1_class: "carbon", docs: { "RE-01": "have" } }));
	check("docs on a non-RE class: T1-S7, nothing sent upstream", refusal(docsNonRe, "INVALID_ARGUMENT", "apx-3f25f6e06a") && received.length === 0, JSON.stringify(docsNonRe?.structuredContent?.error));
	const cases = [
		["unknown id", ok([NOW, "apx-0000000000", F2, F1]), "INTERNAL_ERROR", null],
		["codename version", { status: 200, body: { rubric: "atlas-0.1", sentence_ids: [NOW, F2, F1] } }, "INTERNAL_ERROR", null],
		["F-1 missing", ok([NOW, F2]), "INTERNAL_ERROR", null],
		["F-1 not last", ok([F1, NOW, F2]), "INTERNAL_ERROR", null],
		["F-1 twice", ok([NOW, F1, F2, F1]), "INTERNAL_ERROR", null],
		["ids not an array", { status: 200, body: { rubric: "0.1", sentence_ids: "x" } }, "INTERNAL_ERROR", null],
		["backend 404 (flag off)", { status: 404, body: { error: "not_found" } }, "TOOL_DISABLED", "apx-955c10dcd7"],
		["backend 400", { status: 400, body: { error: "invalid_answers" } }, "INVALID_ARGUMENT", "apx-e03c85072a"],
		["backend 429", { status: 429, body: { error: "rate_limited" } }, "RATE_LIMITED", null],
		["backend 503", { status: 503, body: { error: "unavailable" } }, "UPSTREAM_UNAVAILABLE", null],
		["backend 500", { status: 500, body: { error: "no_certified_result" } }, "UPSTREAM_UNAVAILABLE", null],
	];
	for (const [label, resp, code, msg] of cases) {
		next = resp;
		const r = keep(await pubCall(PASS));
		check(`${label} -> ${code}${msg ? " " + msg : ""}, empty result, F-1`, refusal(r, code, msg), JSON.stringify(r?.structuredContent?.error));
	}
	next = { status: 429, body: { error: "rate_limited" } };
	check("429 is retryable; 404 is not", (await pubCall(PASS))?.structuredContent?.error?.retryable === true);

	// SDK-built argument errors, before the handler runs.
	received.length = 0;
	const badEnum = keep(await pubCall({ ...PASS, q8_band: "a lot" }));
	check("public: an answer outside the choices -> T1-S6 with F-1 (not D-1)", refusal(badEnum, "INVALID_ARGUMENT", "apx-e03c85072a"), JSON.stringify(badEnum).slice(0, 200));
	const freeText = keep(await pubCall({ ...PASS, notes: "my building at 1 Main St" }));
	check("public: an extra free-text field is refused the same way", refusal(freeText, "INVALID_ARGUMENT", "apx-e03c85072a"));
	check("neither reached the backend", received.length === 0);
	const stdio = await inProc("stdio");
	const sBad = keep(await stdio.callTool({ name: "tokenizability_check", arguments: { ...PASS, q1_class: "castle" } }));
	check("stdio: same T1-S6 refusal", refusal(sBad, "INVALID_ARGUMENT", "apx-e03c85072a"));
	const other = await stdio.callTool({ name: "get_article", arguments: {} });
	check("stdio: other tools keep the SDK protocol error (gates-e2e shape)", other.isError === true && other.structuredContent === undefined);
	await stdio.close();
}

/* ------------------------------------------------------------------ */
section("6. C4-3: S-2 deny list over every full response and tools/list");
{
	const DENY = /\b(approved|accepted|qualified|eligible|guarantee(d)?|securit(y|ies)|exempt(ion)?|complian(t|ce)|legal|reg d|506|spv|wrapper|valuation estimate|worth|price|ltv|rais(e|ing)|yield|returns?|investors?|investor demand|capital partners|capital need|tokeni[sz]ed|completed)\b/i;
	const BUCKETS = /\b(NOW|NEVER|NOT_YET|LIFT)\b/;
	const BANDS = new Set(["$1 million", "$10 million", "$500 million"]);
	const OWNER = new Set(["1d572acbfa68c7c6", "0ecfe6d17b4237fc"]); // sha1[:16] of the two name tokens
	check("the scan has material (tools/list + every response above)", SERVED.length >= 20, String(SERVED.length));
	let hits = [];
	for (const blob of SERVED) {
		// Pinned exceptions. (1) AXIOM's: "tax returns" in apx-e8a5d909aa.
		// (2) AXIOM-PENDING, FORGE 2026-10-15: the certified T1-S3
		// (apx-46f7925268) itself contains the VERB "returns" ("and returns the
		// scorecard's result sentences"). S-2's "return(s)" targets financial
		// return; only this exact certified phrase is exempted, so the word
		// still trips anywhere else. Withdrawn if AXIOM re-words S3.
		const t = blob
			.split("Entity tax returns for the last three years")
			.join("")
			.split("one asset and returns the scorecard's result sentences in order")
			.join("");
		const m = t.match(new RegExp(DENY.source, "gi"));
		if (m) hits.push(...m);
		const b = t.match(new RegExp(BUCKETS.source, "g"));
		if (b) hits.push(...b);
		for (const d of t.match(/\$[\d,.]+(?: (?:million|billion))?/g) ?? []) if (!BANDS.has(d)) hits.push(d);
		for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) if (OWNER.has(createHash("sha1").update(w).digest("hex").slice(0, 16))) hits.push("(owner name)");
	}
	check("0 deny-list hits across all served bytes", hits.length === 0, [...new Set(hits)].join(","));
	check("negative control: the regex bites", DENY.test("we can help you raise") && BUCKETS.test("bucket NOW") && DENY.test("Entity tax returns"));
}

/* ------------------------------------------------------------------ */
section("7. C4-1: no answer value in any log, console or stderr line");
{
	const captured = [];
	const origErr = console.error, origLog = console.log, origWarn = console.warn;
	const origStderr = process.stderr.write.bind(process.stderr);
	console.error = (...a) => captured.push(a.join(" "));
	console.log = (...a) => captured.push(a.join(" "));
	console.warn = (...a) => captured.push(a.join(" "));
	process.stderr.write = (c, ...rest) => (captured.push(String(c)), true);
	const SECRET_ANSWERS = { ...PASS, q1_class: "gpu_compute", q4_valuation: "sponsor_pro_forma", q8_band: "over_500m" };
	events.length = 0;
	try {
		next = ok([NOW, F2, F1]);
		await pubCall(SECRET_ANSWERS);
		next = { status: 503, body: { error: "unavailable" } };
		await pubCall(SECRET_ANSWERS);
		next = ok(["apx-0000000000", F1]);
		await pubCall(SECRET_ANSWERS);
		await pubCall({ ...SECRET_ANSWERS, q8_band: "a lot" });
	} finally {
		console.error = origErr;
		console.log = origLog;
		console.warn = origWarn;
		process.stderr.write = origStderr;
	}
	const sink = JSON.stringify(events) + "\n" + captured.join("\n");
	check("the log saw these calls (material)", events.filter((e) => e.tool === "tokenizability_check").length === 4, String(events.length));
	const leaked = ["gpu_compute", "sponsor_pro_forma", "over_500m", "a lot"].filter((v) => sink.includes(v));
	check("no answer value in log events, console or stderr", leaked.length === 0, leaked.join(","));
}

/* ------------------------------------------------------------------ */
section("8. C4-4: no class-to-bucket table anywhere in this repo");
{
	const files = [];
	const walk = async (dir) => {
		for (const e of await readdir(dir, { withFileTypes: true })) {
			if (["node_modules", ".git", "dist"].includes(e.name)) continue;
			const p = path.join(dir, e.name);
			if (e.isDirectory()) await walk(p);
			else if (/\.(ts|mjs|js|json|md)$/.test(e.name)) files.push(p);
		}
	};
	await walk(ROOT);
	const TABLE = /\b(cre_\w+|private_\w+|og_\w+|energy_\w+|hydro_\w+|data_center|gpu_compute|farmland|sports_receivable|music_ip_royalty|producing_mine|carbon|mitigation_bank|collectible_\w+|exploration_mining|other)["']?\s*[:=,]\s*["'](NOW|LIFT|NOT_YET|NEVER)["']/;
	const bad = [];
	for (const f of files) if (TABLE.test(await readFile(f, "utf8"))) bad.push(path.relative(ROOT, f));
	check(`no source/test/doc pairs a class with a bucket (${files.length} files)`, files.length > 20 && bad.length === 0, bad.join(","));
	check("positive control: the pattern bites", TABLE.test(["exploration_mining", ': "NEV', 'ER"'].join("")));
	const mod = await readFile(path.join(ROOT, "src", "scorecardTool.ts"), "utf8");
	check("the tool module never spells a bucket key", !/\b(NOW|NOT_YET|NEVER)\b|"LIFT"/.test(mod));
}

pubServer.close();
upstream.close();
process.exit(summary("scorecard e2e") === 0 ? 0 : 1);
