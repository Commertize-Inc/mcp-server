#!/usr/bin/env node
/**
 * Commertize MCP server — v0, stdio transport.
 *
 * Read-only. Public data only. No credentials, no write surface.
 * See README.md for the HTTP/SSE production path.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { config } from "./config.js";
import { registerInquiryTool } from "./inquiryTool.js";
import { registerSandboxTools } from "./sandboxTools.js";
import { registerScreenerTools } from "./screenerTools.js";
import { registerX402Tools } from "./x402Tools.js";
import {
	registerDisclosureTool,
	registerMemoTool,
	registerTools,
	type ToolSurface,
} from "./tools.js";

/**
 * @param surface "stdio" (default) registers every tool its gate allows.
 *   "http" registers ONLY the names in `HTTP_TOOL_ALLOWLIST`
 *   (httpAllowlist.ts): the reads, the disclosure package and the sponsor
 *   inquiry. The memo, the simulation venue and the paid-data rail are not
 *   registered over HTTP whatever their gates say — and `httpServer.ts`
 *   refuses them by name on top, so a slip here is still a 403.
 */
export const createServer = (surface: ToolSurface = "stdio"): McpServer => {
	const server = new McpServer(
		{ name: "commertize", version: "0.1.0" },
		{
			capabilities: { tools: {} },
			instructions:
				"Commertize is a digital capital markets platform for real-world assets. " +
				"This server exposes PUBLIC, READ-ONLY marketplace data: offerings and their " +
				"public terms, platform statistics, published news and commentary, and curated " +
				"platform reference text. Call platform_info first if you are unfamiliar with " +
				"the platform. Nothing here is an offer, a solicitation, or a recommendation, " +
				"and no tool can transact or create an obligation. Every response carries an " +
				"as_of timestamp, the upstream source URL, and a disclaimer — carry them into " +
				"anything you report. Null means not disclosed; it never means zero.",
		}
	);

	registerTools(server, surface);
	/*
	 * Registered separately from `registerTools` to keep the screener in its
	 * own module. Both calls hit the same `McpServer`, so the
	 * tools are indistinguishable to a client — `tools/list` is one flat list
	 * and the portal gateway authorizes all of them identically.
	 */
	registerScreenerTools(server);
	/* The sponsor inquiry: a write to a mounted public route, gated on the
	 * attribution contract (config.ts). On both surfaces. */
	registerInquiryTool(server);
	if (surface === "http") {
		registerDisclosureTool(server);
		return server;
	}
	/*
	 * Gated at REGISTRATION for a DEPLOYMENT reason, not a policy one, and this
	 * is the same rule the two comments below already state — it simply was not
	 * being applied to these two. `POST /api/agents/memo-request` and
	 * `GET /api/offerings/v1/{id}/disclosure` both 404 on api.commertize.com
	 * (probed 2026-09-10; the plain-text body is Hono's unmounted-route 404,
	 * distinguishable from a mounted route's JSON 404). A registry-installed
	 * client runs this server with no environment, so by default it must not be
	 * told these tools exist.
	 */
	registerMemoTool(server);
	registerDisclosureTool(server);
	/*
	 * Gated at REGISTRATION, not at call time: this returns without registering
	 * anything unless `COMMERTIZE_MCP_ENABLE_SANDBOX=1`. The backend 404s an
	 * unmounted simulation venue rather than 403ing it, so a registered tool
	 * would be a name that can only ever fail — and a machine reader that calls
	 * a listed name and gets nothing concludes the venue is broken rather than
	 * absent.
	 */
	registerSandboxTools(server);
	/* Gated the same way, for the same reason: the paid rail is off by default
	 * and its purchase terms are unratified draft text, so a tool that quotes a
	 * price against them should not appear in a tool list. */
	registerX402Tools(server);
	return server;
};

const main = async (): Promise<void> => {
	const server = createServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	// stdout is the protocol channel. Diagnostics go to stderr, always.
	console.error(
		`commertize-mcp-server 0.1.0 ready on stdio (api: ${config.apiBaseUrl}, cache: ${config.cacheTtlMs}ms${
			config.offeringsDisabled ? ", offerings: DISABLED" : ""
		})`
	);
};

// Only run when executed directly; importing this module (tests) must not
// grab stdio.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	main().catch((err) => {
		console.error("Fatal:", err);
		process.exit(1);
	});
}
