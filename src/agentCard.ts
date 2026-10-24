/**
 * `GET /.well-known/agent-card.json` (A2A v1.0 well-known path) and
 * `GET /.well-known/agent.json` (the path 0.2.x clients and INTEL's probe
 * use): one card describing the NO-KEY MCP endpoint.
 *
 * Same gate as `/mcp/public` (COMMERTIZE_MCP_ENABLE_PUBLIC): closed = 404, so
 * the card never advertises an endpoint that answers 404. The keyed `/mcp`
 * is not advertised (an outside reader cannot obtain a key).
 *
 * A2A v1.0 AgentCard required fields (spec read 2026-10-20,
 * a2a-protocol.org/latest/specification 4.4.1): name, description,
 * supportedInterfaces, version, capabilities, defaultInputModes,
 * defaultOutputModes, skills. AgentInterface requires url, protocolBinding,
 * protocolVersion; protocolBinding is an open string and custom bindings
 * SHOULD be a URI (5.8). This server speaks MCP, not the A2A JSON-RPC
 * methods, so the binding is the MCP Streamable HTTP transport URI, and no
 * A2A core binding (JSONRPC/GRPC/HTTP+JSON) is claimed.
 *
 * Strings: name/description are the AXIOM-certified OpenAPI strings
 * (L7a-e, CERT_mcp_directory_listings_2026-10-19); skill names are the
 * certified tool titles. Nothing here is new prose.
 */

import type { NodeHandler } from "./httpServer.js";
import { OPENAPI_DOCUMENT, SERVER_VERSION } from "./httpPublic.js";
import { D6_DISCLAIMER, PUBLIC_ENDPOINT_URL, refusalBody } from "./refusals.js";

export const AGENT_CARD_PATHS: ReadonlySet<string> = new Set([
	"/.well-known/agent-card.json",
	"/.well-known/agent.json",
]);

export const MCP_STREAMABLE_HTTP_BINDING =
	"https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http";

/** The public tools, as A2A skills. Titles are the certified tool titles. */
const SKILLS = [
	{ id: "get_news", name: "Get Commertize news and market commentary", tags: ["news", "real-world-assets"] },
	{ id: "get_article", name: "Get one Commertize article", tags: ["news", "real-world-assets"] },
	{ id: "platform_info", name: "About Commertize", tags: ["reference"] },
] as const;

export const AGENT_CARD = Object.freeze({
	name: OPENAPI_DOCUMENT.info.title,
	description: OPENAPI_DOCUMENT.info.description,
	version: SERVER_VERSION,
	provider: { organization: "Commertize, Inc.", url: "https://commertize.com" },
	supportedInterfaces: [
		{ url: PUBLIC_ENDPOINT_URL, protocolBinding: MCP_STREAMABLE_HTTP_BINDING, protocolVersion: "2025-06-18" },
	],
	capabilities: { streaming: false, pushNotifications: false },
	defaultInputModes: ["application/json"],
	defaultOutputModes: ["application/json"],
	skills: SKILLS.map((s) => ({ ...s, description: s.name })),
	sec_disclaimer: D6_DISCLAIMER,
});

export const createAgentCardHandler = (o: { enabled: () => boolean }): NodeHandler => {
	const body = JSON.stringify(AGENT_CARD, null, 2);
	const headers = {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	};
	return async (req, res) => {
		const path = new URL(req.url ?? "/", "http://localhost").pathname;
		const method = (req.method ?? "GET").toUpperCase();
		if (!o.enabled() || !AGENT_CARD_PATHS.has(path)) {
			res.writeHead(404, headers);
			res.end(JSON.stringify(refusalBody("not_found", {}, o.enabled())));
			return;
		}
		if (method !== "GET" && method !== "HEAD") {
			res.writeHead(405, { ...headers, allow: "GET, HEAD" });
			res.end(JSON.stringify(refusalBody("get_only")));
			return;
		}
		res.writeHead(200, headers);
		res.end(method === "HEAD" ? undefined : body);
	};
};
