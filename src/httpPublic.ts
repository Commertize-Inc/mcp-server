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

import { protocolVersionOf, srcOf, uaProductOf } from "./analytics.js";
import type { FixedWindowLimiter } from "./httpRateLimit.js";
import { clientIpOf, type HttpLogEvent, type NodeHandler } from "./httpServer.js";
import {
	clientNameOf,
	clientVersionOf,
	isPublicTool,
	type PublicErrorDetail,
} from "./publicSurface.js";
import { refusalBody, rpcRefusal } from "./refusals.js";

export const PUBLIC_PATH = "/mcp/public";

/** The served version (package.json; `/openapi.json` info.version pins to it). */
export const SERVER_VERSION = "0.2.0";

/**
 * security review L4-1, MCP Streamable HTTP transport: servers MUST validate `Origin`
 * (DNS rebinding). A browser sends it; a server-to-server client usually does
 * not. So: absent = allowed; present = allowed only on an exact match with
 * the endpoint's own origin; anything else (another site, "null", a
 * look-alike suffix, http) is 403 before the body is read.
 */
export const PUBLIC_ALLOWED_ORIGINS: ReadonlySet<string> = new Set(["https://agents.commertize.com"]);
export const originAllowed = (raw: string | string[] | undefined): boolean =>
	raw === undefined || (typeof raw === "string" && PUBLIC_ALLOWED_ORIGINS.has(raw));

/**
 * Error text in public_tool_error / public_error lines can carry caller input
 * (a slug, a parse error quoting the body). Strip control and format
 * characters so a caller cannot inject fake log lines, and cap the length.
 */
export const LOG_DETAIL_MAX = 200;
export const logSafe = (s: unknown): string => {
	const flat = String(s ?? "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");
	// Cap on code points, so a surrogate pair is never split.
	const cps = Array.from(flat);
	return cps.length > LOG_DETAIL_MAX ? `${cps.slice(0, LOG_DETAIL_MAX).join("")}…` : flat;
};

export interface PublicHandlerOptions {
	/**
	 * False = 404 for every request. Called per request, but the production
	 * closure (httpEntry.ts) returns config.publicDisabled, which is computed
	 * once at module load from the environment. Changing the environment does
	 * NOT close a running deployment; see README "Turning the no-login endpoint on and off".
	 */
	enabled: () => boolean;
	ipLimiter: FixedWindowLimiter;
	/** Builds a public-surface server; `onToolResult` sees each tool result. */
	createServer: (
		onToolResult?: (tool: string, r: CallToolResult, d?: PublicErrorDetail) => void
	) => McpServer;
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
		let protocolVersion: unknown = undefined;
		// Directory attribution from `?src=`, a closed set (analytics.ts srcOf).
		const src = srcOf(req.url);
		let outcome = "unhandled";

		const send = (status: number, body: unknown, extra: Record<string, string> = {}): void => {
			res.writeHead(status, { ...JSON_HEADERS, ...extra });
			res.end(JSON.stringify(body));
		};

		try {
			if (!o.enabled() || path !== PUBLIC_PATH) {
				outcome = "not_found";
				send(404, refusalBody("not_found", {}, o.enabled()));
				return;
			}
			if (method !== "POST") {
				outcome = "method_not_allowed";
				send(405, refusalBody("method_not_allowed", {}, o.enabled()), { allow: "POST" });
				return;
			}
			// The Origin value is caller-chosen text: never logged.
			if (!originAllowed(req.headers.origin)) {
				outcome = "origin_refused";
				send(403, refusalBody("origin_not_allowed", {}, o.enabled()));
				return;
			}

			const limit = o.ipLimiter.hit(clientIpOf(req));
			if (!limit.allowed) {
				outcome = "rate_limited";
				send(429, refusalBody("rate_limited", {}, o.enabled()), { "retry-after": String(limit.retryAfterSeconds) });
				return;
			}

			const ct = String(req.headers["content-type"] ?? "");
			if (!/^application\/json(?:[ \t]*;|$)/i.test(ct)) {
				outcome = "unsupported_media_type";
				send(415, refusalBody("unsupported_media_type", {}, o.enabled()));
				return;
			}
			const raw = await readBody(req, o.maxBodyBytes);
			if (raw === null) {
				outcome = "payload_too_large";
				send(413, refusalBody("payload_too_large", {}, o.enabled()));
				return;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				outcome = "parse_error";
				send(400, rpcRefusal(null, -32700, "Parse error", "parse_error"));
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
					params?: { name?: unknown; clientInfo?: { name?: unknown; version?: unknown }; protocolVersion?: unknown };
				};
				if (msg.method === "initialize") {
					clientName = clientNameOf(msg.params?.clientInfo?.name);
					clientVersion = clientVersionOf(msg.params?.clientInfo?.version);
					protocolVersion = protocolVersionOf(msg.params?.protocolVersion);
				}
				if (msg.method !== "tools/call") continue;
				const name = msg.params?.name;
				// A refused name is caller-chosen text; log a fixed token instead.
				tool = isPublicTool(name) ? name : "(refused)";
				if (!isPublicTool(name)) {
					outcome = "tool_refused";
					send(403, rpcRefusal(msg.id, -32601, "Method not found", "tool_not_public"));
					return;
				}
			}

			/*
			 * ONE MESSAGE PER COUNTED REQUEST (security review PR #4 F4-1). The limiter
			 * above charged this HTTP request once; a JSON-RPC batch would let
			 * that one charge fan out to hundreds of upstream GETs (PoC: 500
			 * get_article calls in one POST = 500 upstream hits) and exhaust the
			 * backend's shared news limiter for every surface. MCP 2025-06-18
			 * removed batching, so any array is refused whole, before dispatch.
			 */
			if (Array.isArray(parsed)) {
				outcome = "batch_refused";
				send(400, rpcRefusal(null, -32600, "Invalid Request", "batch_refused"));
				return;
			}

			const server = o.createServer((t, r, d) => {
				// Only the envelope's own machine code, never its message.
				const code = (r.structuredContent as { error?: { code?: unknown } } | undefined)?.error?.code;
				if (r.isError) errorCode = typeof code === "string" && /^[A-Z_]{1,40}$/.test(code) ? code : "TOOL_ERROR";
				// H1: the raw cause the client no longer sees, server-side only
				// (never reaches analytics: toCaptures reads public_request only).
				if (d) {
					o.log({
						ts: new Date(now()).toISOString(),
						event: "public_tool_error",
						tool: isPublicTool(t) ? t : "(sdk)",
						code: d.code,
						detail: logSafe(d.detail),
					});
				}
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
				message: logSafe(err instanceof Error ? err.message : String(err)),
			});
			if (!res.headersSent) send(500, refusalBody("internal_error", {}, o.enabled()));
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
				protocol_version: protocolVersion,
				src,
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

/**
 * `GET /openapi.json`: a description of the keyless surface for directories
 * (listing review listing handoff 2026-10-19 F-2). Same gate as `/mcp/public`: closed
 * means 404, so the document never advertises an endpoint that answers 404.
 * The keyed `/mcp` is left out on purpose (a directory reader cannot obtain a
 * key). The summary and description strings are legal review-certified L7a-e
 * (directory listings review, 2026-10-19); public-hardening.mjs pins the
 * bytes, and info.version pins to package.json. Changing one needs a re-cert.
 */
export const OPENAPI_PATH = "/openapi.json";

export const OPENAPI_DOCUMENT = {
	openapi: "3.1.0",
	info: {
		title: "Commertize Agents",
		version: SERVER_VERSION,
		description:
			"MCP server for Commertize, the digital capital markets platform for real-world assets.",
	},
	servers: [{ url: "https://agents.commertize.com" }],
	paths: {
		"/health": {
			get: {
				summary: "Service status",
				responses: { "200": { description: "JSON status" } },
			},
		},
		[PUBLIC_PATH]: {
			post: {
				summary:
					"MCP Streamable HTTP endpoint, no key (get_news, get_article, platform_info)",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["jsonrpc", "method"],
								properties: {
									jsonrpc: { const: "2.0" },
									id: {},
									method: { type: "string" },
									params: { type: "object" },
								},
							},
						},
					},
				},
				responses: {
					"200": { description: "JSON-RPC result" },
					"403": { description: "Tool not on the public surface" },
				},
			},
		},
	},
} as const;

export const createOpenApiHandler = (o: { enabled: () => boolean }): NodeHandler => {
	const body = JSON.stringify(OPENAPI_DOCUMENT, null, 2);
	return async (req, res) => {
		const path = new URL(req.url ?? "/", "http://localhost").pathname;
		const method = (req.method ?? "GET").toUpperCase();
		if (!o.enabled() || path !== OPENAPI_PATH) {
			res.writeHead(404, JSON_HEADERS);
			res.end(JSON.stringify(refusalBody("not_found", {}, o.enabled())));
			return;
		}
		if (method !== "GET" && method !== "HEAD") {
			res.writeHead(405, { ...JSON_HEADERS, allow: "GET, HEAD" });
			res.end(JSON.stringify(refusalBody("get_only", {}, o.enabled())));
			return;
		}
		res.writeHead(200, JSON_HEADERS);
		res.end(method === "HEAD" ? undefined : body);
	};
};
