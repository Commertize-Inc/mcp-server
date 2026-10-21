#!/usr/bin/env node
/**
 * Commertize MCP server — v0, stdio transport.
 *
 * Read-only. Public data only. No credentials, no write surface.
 * See README.md for the HTTP/SSE production path.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { config } from "./config.js";
import { registerInquiryTool } from "./inquiryTool.js";
import {
	envelopeSdkToolErrors,
	withPublicDisclaimer,
	type PublicErrorDetail,
} from "./publicSurface.js";
import { registerSandboxTools } from "./sandboxTools.js";
import { registerScreenerTools } from "./screenerTools.js";
import { applyToolMeta } from "./toolMeta.js";
import { registerX402Tools } from "./x402Tools.js";
import { registerDataProductTools } from "./dataProductTools.js";
import { registerOmnigridTools } from "./omnigridTools.js";
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
export const createServer = (
	surface: ToolSurface = "stdio",
	onToolResult?: (tool: string, r: CallToolResult, d?: PublicErrorDetail) => void
): McpServer => {
	/*
	 * The no-login public surface (`/mcp/public`, publicSurface.ts): the three
	 * reads that return data today and nothing else. No `instructions` string:
	 * the server-wide one describes offering data this surface never serves,
	 * and new copy for it waits on certification.
	 */
	/*
	 * AEGIS F3-1: the DEFAULT stdio build is the public three too. A directory
	 * that installs and introspects this server would otherwise re-list tools
	 * that are closed to anonymous readers, and the README documents three.
	 * The gated set needs COMMERTIZE_MCP_ENABLE_GATED_TOOLS exactly "1"
	 * (config.ts); each gated tool still has its own gate on top.
	 */
	const publicOnly = surface === "public" || (surface === "stdio" && !config.gatedToolsEnabled);
	if (publicOnly) {
		const pub = new McpServer(
			{ name: "commertize", version: "0.1.0" },
			{ capabilities: { tools: {} } }
		);
		applyToolMeta(pub);
		registerTools(pub, "public", onToolResult);
		registerPublicDataProductTools(pub, onToolResult);
		envelopeSdkToolErrors(pub, onToolResult);
		return pub;
	}
	const server = new McpServer(
		{ name: "commertize", version: "0.2.0" },
		/*
		 * No `instructions` string (AXIOM ruling 2026-10-15 F-B / R3-h): the
		 * previous one described offering data and platform statistics this
		 * server does not serve. Deleted; nothing replaces it until certified.
		 */
		{ capabilities: { tools: {} } }
	);

	// Every tool carries the toolMeta.ts annotations and pricing; an unknown name throws.
	applyToolMeta(server);
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
	/* Same pattern: off unless COMMERTIZE_MCP_ENABLE_DATA_PRODUCTS=1. */
	registerDataProductTools(server);
	/* OmniGrid: off unless COMMERTIZE_MCP_ENABLE_OMNIGRID=1 AND the data gate. */
	registerOmnigridTools(server);
	return server;
};

/**
 * The paid data products on the public surface (gate-checked inside
 * registerDataProductTools). Each result gets the public disclaimer and the
 * error-text scrub (withPublicDisclaimer), and is seen by the analytics
 * observer, like the three free tools.
 */
const registerPublicDataProductTools = (
	pub: McpServer,
	onToolResult?: (tool: string, r: CallToolResult, d?: PublicErrorDetail) => void
): void => {
	const s = pub as unknown as { registerTool: (...a: unknown[]) => unknown };
	const original = s.registerTool;
	s.registerTool = (name: unknown, cfg: unknown, cb: unknown) =>
		original.call(pub, name, cfg, async (...a: unknown[]) => {
			let detail: PublicErrorDetail | undefined;
			const run = cb as (...x: unknown[]) => unknown;
			const r = withPublicDisclaimer((await run(...a)) as CallToolResult, (d) => (detail = d));
			try {
				onToolResult?.(String(name), r, detail);
			} catch {
				/* an observer never changes a result */
			}
			return r;
		});
	try {
		registerDataProductTools(pub);
		registerOmnigridTools(pub);
	} finally {
		s.registerTool = original;
	}
};

const main = async (): Promise<void> => {
	const server = createServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	// stdout is the protocol channel. Diagnostics go to stderr, always.
	console.error(
		`commertize-mcp-server 0.2.0 ready on stdio (api: ${config.apiBaseUrl}, cache: ${config.cacheTtlMs}ms${
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
