/**
 * The no-login endpoint through the official MCP SDK Client.
 *
 * The SDK Client validates every structuredContent, error results included,
 * against the tool's declared output schema and rejects additional
 * properties. The raw-HTTP suites cannot see that, so this one drives every
 * public tool, a not-found error and a RATE_LIMITED error through a real
 * Client over Streamable HTTP, against a local stub upstream.
 *
 * Run directly: node test/public-sdk-client.mjs (after npm run build)
 */

import { createServer as createNodeServer } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { check, LOOPBACK, resetCounters, section, summary } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "..", "dist");

resetCounters();

const ARTICLE = {
	slug: "tokenization-week",
	title: "This week",
	summary: "A summary.",
	category: "Tokenization",
	publishedAt: "2026-10-01T00:00:00.000Z",
	readTime: 3,
	imageUrl: null,
	content: "<p>Body text.</p>",
};
const upstream = createNodeServer((req, res) => {
	const url = new URL(req.url, "http://stub");
	const json = (status, body) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};
	if (url.pathname === "/api/news") return json(200, { data: [ARTICLE] });
	if (url.pathname.startsWith("/api/news/")) {
		return url.pathname.endsWith(ARTICLE.slug) ? json(200, { data: ARTICLE }) : json(404, { error: "Article not found" });
	}
	return json(404, { error: "not found" });
});
await new Promise((r) => upstream.listen(0, LOOPBACK, r));

process.env.COMMERTIZE_API_BASE_URL = `http://${LOOPBACK}:${upstream.address().port}`;
// Budget 3: news, article, missing article; the fourth distinct news read is RATE_LIMITED.
process.env.COMMERTIZE_MCP_UPSTREAM_NEWS_RPM = "3";

const { createPublicHttpHandler, PUBLIC_PATH } = await import(path.join(DIST, "httpPublic.js"));
const { FixedWindowLimiter } = await import(path.join(DIST, "httpRateLimit.js"));
const { createServer } = await import(path.join(DIST, "index.js"));
const { PUBLIC_TOOL_NAMES } = await import(path.join(DIST, "publicSurface.js"));

const handler = createPublicHttpHandler({
	enabled: () => true,
	ipLimiter: new FixedWindowLimiter(1000, 60_000),
	createServer: (onToolResult) => createServer("public", onToolResult),
	log: () => {},
	maxBodyBytes: 65_536,
});
const server = createNodeServer((req, res) => {
	handler(req, res).catch(() => {
		if (!res.headersSent) res.writeHead(500).end();
	});
});
await new Promise((r) => server.listen(0, LOOPBACK, r));
const ENDPOINT = new URL(`http://${LOOPBACK}:${server.address().port}${PUBLIC_PATH}`);

const connectClient = async () => {
	const client = new Client({ name: "sdk-client-test", version: "0" });
	await client.connect(new StreamableHTTPClientTransport(ENDPOINT));
	await client.listTools(); // the Client caches output schemas from here
	return client;
};

const callChecked = async (client, name, args) => {
	try {
		return { result: await client.callTool({ name, arguments: args }), threw: null };
	} catch (e) {
		return { result: null, threw: e instanceof Error ? e.message : String(e) };
	}
};

section("1. every public tool, through the SDK Client, passes output-schema validation");
const client = await connectClient();
const tools = (await client.listTools()).tools.map((t) => t.name).sort();
check("the Client sees exactly the public tools", JSON.stringify(tools) === JSON.stringify([...PUBLIC_TOOL_NAMES].sort()), JSON.stringify(tools));

const cases = [
	["get_news", { limit: 5 }, false],
	["get_article", { slug: ARTICLE.slug }, false],
	["platform_info", {}, false],
	["get_article", { slug: "no-such-article" }, true],
];
for (const [name, args, expectError] of cases) {
	const { result, threw } = await callChecked(client, name, args);
	check(`${name} ${JSON.stringify(args)}: accepted by the Client`, threw === null, threw ?? "");
	check(`${name} ${JSON.stringify(args)}: isError is ${expectError}`, (result?.isError === true) === expectError);
}

section("2. RATE_LIMITED reaches the Client with its fixed text and retry_after_seconds");
{
	const { result, threw } = await callChecked(client, "get_news", { limit: 5, since: "2026-10-01" });
	check("RATE_LIMITED result accepted by the Client", threw === null, threw ?? "");
	const err = result?.structuredContent?.error;
	check("code is RATE_LIMITED", err?.code === "RATE_LIMITED", JSON.stringify(err));
	check("retry_after_seconds is 60", err?.retry_after_seconds === 60, JSON.stringify(err));
	check("message is the fixed text", err?.message === "Too many reads right now. Retry later.");
}

await client.close();
server.close();
upstream.close();
process.exit(summary("public sdk client") === 0 ? 0 : 1);
