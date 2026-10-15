/**
 * `POST /mcp/public`: the NO-LOGIN, read-only MCP endpoint.
 *
 * A separate handler from the keyed `/mcp` (httpServer.ts), which this file
 * does not touch. Same stateless Streamable HTTP shape, no credential.
 *
 * Order of checks, each fail-closed:
 *   0. gate: closed (default) -> 404, before anything else is read;
 *   1. method: only POST (no SSE, no sessions, no CORS preflight) -> 405;
 *   2. per-client-IP request ceiling -> 429 + Retry-After;
 *   3. body: JSON only, bounded size -> 415 / 413 / 400 (-32700);
 *   4. tool allowlist: any `tools/call` (batches included) naming a tool not
 *      in PUBLIC_TOOL_SET -> HTTP 403, JSON-RPC -32601, before the MCP
 *      server sees it. Registration is filtered too (tools.ts), so this is
 *      the second of two readers;
 *   5. dispatch to a fresh `createServer("public")`.
 *
 * Refusals carry machine codes and the JSON-RPC standard messages only; no
 * new prose. An Authorization header, if sent, is ignored and never logged.
 *
 * The log is one object per request: method, path, JSON-RPC methods, tool,
 * the client family from `initialize` (sanitised), status, outcome, ms.
 * Never the client IP, a header, or a body.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { uaProductOf } from "./analytics.js";
import type { FixedWindowLimiter } from "./httpRateLimit.js";
import { clientIpOf, type HttpLogEvent, type NodeHandler } from "./httpServer.js";
import { clientNameOf, clientVersionOf, isPublicTool } from "./publicSurface.js";

export const PUBLIC_PATH = "/mcp/public";

export interface PublicHandlerOptions {
	/** False = 404 for every request. Read per request (the kill switch). */
	enabled: () => boolean;
	ipLimiter: FixedWindowLimiter;
	/** Builds a public-surface server; `onToolResult` sees each tool result. */
	createServer: (onToolResult?: (tool: string, r: CallToolResult) => void) => McpServer;
	/**
	 * Awaited AFTER the response is written and the event logged (analytics).
	 * Never allowed to throw into the request.
	 */
	afterResponse?: (e: HttpLogEvent) => Promise<void>;
	log: (e: HttpLogEvent) => void;
	maxBodyBytes: number;
	now?: () => number;
}

const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
} as const;

const readBody = (req: IncomingMessage, max: number): Promise<string | null> =>
	new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let overflow = false;
		req.on("data", (c: Buffer) => {
			if (overflow) return;
			size += c.length;
			if (size > max) {
				overflow = true;
				resolve(null);
				req.resume();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => {
			if (!overflow) resolve(Buffer.concat(chunks).toString("utf8"));
		});
		req.on("error", reject);
	});

const rpcError = (id: unknown, code: number, message: string) => ({
	jsonrpc: "2.0" as const,
	id: id === undefined ? null : id,
	error: { code, message },
});

export const createPublicHttpHandler = (o: PublicHandlerOptions): NodeHandler => {
	const now = o.now ?? Date.now;

	return async (req, res) => {
		const started = now();
		const path = new URL(req.url ?? "/", "http://localhost").pathname;
		const method = (req.method ?? "GET").toUpperCase();
		let rpc: string[] = [];
		let tool: string | null = null;
		// Client family: the first User-Agent product token, replaced by
		// `initialize` clientInfo when the request carries one. Sanitised both ways.
		const ua = uaProductOf(req.headers["user-agent"]);
		let clientName: string = ua.name;
		let clientVersion: string | null = ua.version;
		let errorCode: string | null = null;
		let outcome = "unhandled";

		const send = (status: number, body: unknown, extra: Record<string, string> = {}): void => {
			res.writeHead(status, { ...JSON_HEADERS, ...extra });
			res.end(JSON.stringify(body));
		};

		try {
			if (!o.enabled() || path !== PUBLIC_PATH) {
				outcome = "not_found";
				send(404, { error: "not_found" });
				return;
			}
			if (method !== "POST") {
				outcome = "method_not_allowed";
				send(405, { error: "method_not_allowed" }, { allow: "POST" });
				return;
			}

			const limit = o.ipLimiter.hit(clientIpOf(req));
			if (!limit.allowed) {
				outcome = "rate_limited";
				send(429, { error: "rate_limited" }, { "retry-after": String(limit.retryAfterSeconds) });
				return;
			}

			const ct = String(req.headers["content-type"] ?? "");
			if (!/^application\/json(?:[ \t]*;|$)/i.test(ct)) {
				outcome = "unsupported_media_type";
				send(415, { error: "unsupported_media_type" });
				return;
			}
			const raw = await readBody(req, o.maxBodyBytes);
			if (raw === null) {
				outcome = "payload_too_large";
				send(413, { error: "payload_too_large" });
				return;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				outcome = "parse_error";
				send(400, rpcError(null, -32700, "Parse error"));
				return;
			}

			const messages: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
			rpc = messages
				.map((m) =>
					m && typeof m === "object" && typeof (m as { method?: unknown }).method === "string"
						? (m as { method: string }).method
						: ""
				)
				.filter((m) => m !== "");
			for (const m of messages) {
				if (!m || typeof m !== "object") continue;
				const msg = m as {
					method?: unknown;
					id?: unknown;
					params?: { name?: unknown; clientInfo?: { name?: unknown; version?: unknown } };
				};
				if (msg.method === "initialize") {
					clientName = clientNameOf(msg.params?.clientInfo?.name);
					clientVersion = clientVersionOf(msg.params?.clientInfo?.version);
				}
				if (msg.method !== "tools/call") continue;
				const name = msg.params?.name;
				// A refused name is caller-chosen text; log a fixed token instead.
				tool = isPublicTool(name) ? name : "(refused)";
				if (!isPublicTool(name)) {
					outcome = "tool_refused";
					send(403, rpcError(msg.id, -32601, "Method not found"));
					return;
				}
			}

			/*
			 * ONE MESSAGE PER COUNTED REQUEST (AEGIS PR #4 F4-1). The limiter
			 * above charged this HTTP request once; a JSON-RPC batch would let
			 * that one charge fan out to hundreds of upstream GETs (PoC: 500
			 * get_article calls in one POST = 500 upstream hits) and exhaust the
			 * backend's shared news limiter for every surface. MCP 2025-06-18
			 * removed batching, so any array is refused whole, before dispatch.
			 */
			if (Array.isArray(parsed)) {
				outcome = "batch_refused";
				send(400, rpcError(null, -32600, "Invalid Request"));
				return;
			}

			const server = o.createServer((_tool, r) => {
				// Only the envelope's own machine code, never its message.
				const code = (r.structuredContent as { error?: { code?: unknown } } | undefined)?.error?.code;
				if (r.isError) errorCode = typeof code === "string" && /^[A-Z_]{1,40}$/.test(code) ? code : "TOOL_ERROR";
			});
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
				enableJsonResponse: true,
			});
			res.on("close", () => {
				transport.close().catch(() => {});
				server.close().catch(() => {});
			});
			await server.connect(transport);
			await transport.handleRequest(req, res, parsed);
			outcome = "ok";
		} catch (err) {
			outcome = "error";
			o.log({
				ts: new Date(now()).toISOString(),
				event: "public_error",
				message: err instanceof Error ? err.message : String(err),
			});
			if (!res.headersSent) send(500, { error: "internal_error" });
		} finally {
			const evt: HttpLogEvent = {
				ts: new Date(now()).toISOString(),
				event: "public_request",
				method,
				path,
				rpc,
				tool,
				client_name: clientName,
				client_version: clientVersion,
				status: res.statusCode,
				outcome,
				error_code: errorCode,
				ms: now() - started,
			};
			o.log(evt);
			if (o.afterResponse) {
				try {
					await o.afterResponse(evt);
				} catch {
					/* analytics never reaches the request */
				}
			}
		}
	};
};
