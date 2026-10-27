/**
 * get_news `class` and `since` (news agent-feed spec, 2026-10-21).
 * Offline: a local stub upstream records every query string it is sent.
 */

import { createServer } from "node:http";
import { call, check, connect, resetCounters, section, summary } from "./harness.mjs";

const listen = (handler) =>
	new Promise((resolve) => {
		const srv = createServer(handler);
		srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
	});
const close = (srv) => new Promise((r) => srv.close(() => r()));

const ROWS = [
	{ slug: "farm-new", title: "Farmland", summary: "s", category: "Markets", tags: ["farmland"], publishedAt: "2026-10-10T00:00:00.000Z" },
	{ slug: "farm-old", title: "Farmland old", summary: "s", category: "Markets", tags: ["farmland"], publishedAt: "2026-09-01T00:00:00.000Z" },
	{ slug: "cre", title: "CRE", summary: "s", category: "Markets", tags: ["cre"], publishedAt: "2026-10-11T00:00:00.000Z" },
	{ slug: "untagged", title: "Stablecoins", summary: "s", category: "Markets", tags: null, publishedAt: "2026-10-12T00:00:00.000Z" },
];

/** mode "honours": filters like the new API. mode "ignores": returns all rows (an API deployed before the params). */
const stub = async (mode) => {
	const seen = [];
	const { srv, port } = await listen((req, res) => {
		const url = new URL(req.url, "http://stub");
		seen.push(url);
		if (url.pathname === "/api/news") {
			const cls = url.searchParams.get("class");
			const since = url.searchParams.get("since");
			if (mode === "honours" && cls && !["farmland", "cre"].includes(cls)) {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "Unknown class" }));
				return;
			}
			let rows = ROWS;
			if (mode === "honours") {
				if (cls) rows = rows.filter((r) => (r.tags ?? []).includes(cls));
				if (since) rows = rows.filter((r) => Date.parse(r.publishedAt) >= Date.parse(since));
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: rows }));
			return;
		}
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "not found" }));
	});
	return { srv, seen, base: `http://127.0.0.1:${port}` };
};

resetCounters();

section("1. class and since reach the API as query parameters");
{
	const s = await stub("honours");
	const client = await connect({ COMMERTIZE_API_BASE_URL: s.base });
	const { result, payload } = await call(client, "get_news", { class: "farmland", since: "2026-10-01", limit: 5 });
	const q = s.seen.at(-1)?.searchParams;
	check("not an error", result.isError !== true, JSON.stringify(payload?.error ?? null));
	check("class passed through", q?.get("class") === "farmland", String(q));
	check("since passed through in canonical minute form", q?.get("since") === "2026-10-01T00:00:00.000Z", String(q));
	check("limit still passed", q?.get("limit") === "5", String(q));
	check("only the new farmland article", JSON.stringify(payload.articles.map((a) => a.slug)) === '["farm-new"]', JSON.stringify(payload.articles));
	check("tags are in the output", JSON.stringify(payload.articles[0]?.tags) === '["farmland"]');

	const plain = await call(client, "get_news", {});
	const pq = s.seen.at(-1)?.searchParams;
	check("no class/since params when not asked", !pq.has("class") && !pq.has("since"), String(pq));
	check("untagged article reports tags: []", JSON.stringify(plain.payload.articles.find((a) => a.slug === "untagged")?.tags) === "[]");
	await client.close();
	await close(s.srv);
}

section("2. an API that ignores the parameters never yields an unfiltered list");
{
	const s = await stub("ignores");
	const client = await connect({ COMMERTIZE_API_BASE_URL: s.base });
	const { payload } = await call(client, "get_news", { class: "cre" });
	check("class re-checked locally", JSON.stringify(payload.articles.map((a) => a.slug)) === '["cre"]', JSON.stringify(payload.articles.map((a) => a.slug)));
	const since = await call(client, "get_news", { since: "2026-10-01" });
	check(
		"since re-checked locally",
		JSON.stringify(since.payload.articles.map((a) => a.slug).sort()) === '["cre","farm-new","untagged"]',
		JSON.stringify(since.payload.articles.map((a) => a.slug))
	);
	check("count matches the filtered list", since.payload.count === 3);
	await client.close();
	await close(s.srv);
}

section("3. bad inputs are refused, not widened");
{
	const s = await stub("honours");
	const client = await connect({ COMMERTIZE_API_BASE_URL: s.base });
	const before = s.seen.length;
	const badSince = await call(client, "get_news", { since: "yesterday" });
	check("unparseable since is an error", badSince.result.isError === true);
	const badShape = await call(client, "get_news", { class: "cre&limit=100" });
	check("class with query characters is an error", badShape.result.isError === true);
	check("neither reached the API", s.seen.length === before, `${s.seen.length - before} requests`);
	const unknown = await call(client, "get_news", { class: "carbon" });
	check(
		"unknown class surfaces the API's refusal",
		unknown.result.isError === true && unknown.payload?.error?.code === "UPSTREAM_ERROR",
		JSON.stringify(unknown.payload?.error ?? null)
	);
	check("and it is not retryable", unknown.payload?.error?.retryable === false);
	await client.close();
	await close(s.srv);
}

process.exit(summary("news filters") ? 1 : 0);
