/**
 * Boot the real HTTP transport on a local port with a LOCAL stub upstream, for
 * a hands-on client check (e.g. `claude mcp add --transport http ...`). Not a
 * test and not part of `npm test`.
 *
 * Prints, on stdout, one JSON line: { url, key, upstream }. The key is a
 * fixture accepted only by the stub's introspection route; it opens nothing
 * anywhere else. Stops on SIGINT/SIGTERM.
 *
 *   node test/http-serve-local.mjs [port]
 */

import { createServer as createNodeServer } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "..", "dist");

const KEY_ID = "0123456789abcdef";
const KEY = `cfa_${KEY_ID}_${"A".repeat(43)}`;

const ARTICLES = [
	{
		slug: "local-fixture",
		title: "Local fixture article",
		summary: "Served by the stub upstream of http-serve-local.mjs.",
		category: "Tokenization",
		publishedAt: "2026-10-01T00:00:00.000Z",
		readTime: 1,
		imageUrl: null,
		content: "<p>Fixture body.</p>",
	},
];

const upstream = createNodeServer((req, res) => {
	const url = new URL(req.url, "http://stub");
	const json = (status, body) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};
	if (url.pathname === "/agent-platform/keys/introspect") {
		const auth = req.headers.authorization ?? "";
		return auth === `Bearer ${KEY}`
			? json(200, { key_id: KEY_ID, scope: "single_agent" })
			: json(401, { error: "invalid_api_key" });
	}
	if (url.pathname === "/api/news") return json(200, { data: ARTICLES });
	if (url.pathname.startsWith("/api/news/")) {
		const a = ARTICLES.find((x) => x.slug === url.pathname.slice("/api/news/".length));
		return a ? json(200, { data: a }) : json(404, { error: "Article not found" });
	}
	if (url.pathname === "/contact" && req.method === "POST") {
		req.resume();
		req.on("end", () => json(201, { success: true, id: "inq_local_1" }));
		return;
	}
	res.writeHead(404, { "content-type": "text/plain" });
	res.end("404 Not Found");
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;

process.env.COMMERTIZE_API_BASE_URL = UPSTREAM;
process.env.COMMERTIZE_MCP_ENABLE_INQUIRY = "1";
process.env.COMMERTIZE_MCP_HTTP_HOST = "127.0.0.1";
process.env.COMMERTIZE_MCP_HTTP_PORT = String(Number(process.argv[2] ?? 3920));

const { buildHandler } = await import(path.join(DIST, "httpEntry.js"));
const handler = buildHandler((e) => process.stderr.write(`${JSON.stringify(e)}\n`));
const server = createNodeServer((req, res) => {
	handler(req, res).catch(() => {
		if (!res.headersSent) res.writeHead(500).end();
	});
});
await new Promise((r) =>
	server.listen(Number(process.env.COMMERTIZE_MCP_HTTP_PORT), "127.0.0.1", r)
);
process.stdout.write(
	`${JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/mcp`, key: KEY, upstream: UPSTREAM })}\n`
);

const stop = () => {
	server.close();
	upstream.close();
	process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
