/**
 * Streamable HTTP transport — the remote MCP surface.
 *
 * One handler, Node `http` shaped, so the same function serves a local
 * `node dist/httpMain.js` and a serverless entry (`api/*.js`). Stateless:
 * every POST builds a fresh McpServer + transport, answers, and tears both
 * down. No sessions, no SSE streams, no server-initiated messages.
 *
 * Order of checks on `POST /mcp`, each one fail-closed:
 *   0. per-IP brake — a request whose key is not answered from cache
 *      counts against its client IP before any upstream call; 429;
 *   1. credential — `Authorization: Bearer cfa_…`, verified upstream
 *      (`httpAuth.ts`); 401 or 503, never through;
 *   2. per-key request ceiling — 429 + Retry-After;
 *   3. body — JSON only, bounded size; 415 / 413 / 400 (-32700);
 *   4. tool allowlist — any `tools/call` whose name is not in
 *      `HTTP_TOOL_ALLOWLIST` is refused with 403 and a logged event BEFORE the
 *      MCP server sees it; the inquiry tool also pays its own per-key ceiling;
 *   5. dispatch to the SDK transport with the already-parsed body.
 *
 * CORS is OFF. No `Access-Control-*` header is ever written, OPTIONS is 405,
 * so a key pasted into a web page cannot be used from a browser.
 *
 * Logging is structured (one object per request) and carries the key id —
 * the public half — never the key, never a header, never a body.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { isAllowedOverHttp, isInquiryTool } from "./httpAllowlist.js";
import { parseBearer, type KeyVerifier } from "./httpAuth.js";
import type { FixedWindowLimiter } from "./httpRateLimit.js";

export interface HttpLogEvent {
	ts: string;
	event: string;
	[k: string]: unknown;
}

export interface HttpHandlerOptions {
	verifier: KeyVerifier;
	requestLimiter: FixedWindowLimiter;
	inquiryLimiter: FixedWindowLimiter;
	/** Per-client-IP brake on verification attempts (cache misses only). */
	verifyLimiter: FixedWindowLimiter;
	/** Builds an HTTP-surface server (see `createServer("http")`). */
	createServer: () => McpServer;
	log: (e: HttpLogEvent) => void;
	maxBodyBytes: number;
	version: string;
	now?: () => number;
}

export type NodeHandler = (
	req: IncomingMessage,
	res: ServerResponse
) => Promise<void>;

const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
} as const;

/** Read at most `max` bytes; `null` means the body was larger. */
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

/**
 * Collapse IPv6 to its /64. A single allocation is a /64
 * or larger, so a full IPv6 address is not a stable client identity: one
 * host can rotate through 2^64 of them and get a fresh brake bucket each
 * time. IPv4 and IPv4-mapped forms pass through. Mirrors the backend's
 * `toBucketKey` (apps/backend/src/utils/clientIp.ts) line for line, so both
 * brakes bucket one client the same way.
 */
export const toBucketKey = (ip: string): string => {
	// `.` catches IPv4 and IPv4-mapped forms like ::ffff:203.0.113.5.
	if (!ip.includes(":") || ip.includes(".")) return ip;

	const addr = ip.split("%")[0] ?? ""; // strip any zone id
	const [head = "", tail = ""] = addr.split("::");
	const h = head.split(":").filter(Boolean);
	const t = tail.split(":").filter(Boolean);
	const groups = addr.includes("::")
		? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t]
		: h;

	return groups.slice(0, 4).join(":") + "::/64";
};

/**
 * The client's address for the verification brake. Vercel sets
 * `x-vercel-forwarded-for` at its edge and strips it from inbound traffic;
 * `x-real-ip` is the Node runtime's; the socket is the local case. The raw
 * `x-forwarded-for` is caller-settable and is NOT consulted. No address at
 * all shares one bucket, which brakes harder, never softer. IPv6 is bucketed
 * by /64 (see `toBucketKey`).
 */
export const clientIpOf = (req: IncomingMessage): string => {
	const one = (v: string | string[] | undefined): string =>
		((Array.isArray(v) ? v[0] : v) ?? "").split(",")[0]?.trim() ?? "";
	const ip =
		one(req.headers["x-vercel-forwarded-for"]) ||
		one(req.headers["x-real-ip"]) ||
		req.socket?.remoteAddress ||
		"";
	return ip ? toBucketKey(ip) : "unknown";
};

export const createHttpHandler = (o: HttpHandlerOptions): NodeHandler => {
	const now = o.now ?? Date.now;

	return async (req, res) => {
		const started = now();
		const url = new URL(req.url ?? "/", "http://localhost");
		const path = url.pathname;
		const method = (req.method ?? "GET").toUpperCase();
		let keyId: string | null = null;
		let rpc: string[] = [];
		let tool: string | null = null;
		let outcome = "unhandled";

		const send = (
			status: number,
			body: unknown,
			extra: Record<string, string> = {}
		): void => {
			res.writeHead(status, { ...JSON_HEADERS, ...extra });
			res.end(JSON.stringify(body));
		};

		try {
			if (path === "/health") {
				if (method !== "GET") {
					outcome = "method_not_allowed";
					send(405, { error: "method_not_allowed" }, { allow: "GET" });
					return;
				}
				outcome = "ok";
				send(200, {
					ok: true,
					service: "commertize-mcp-server",
					version: o.version,
					transport: "streamable-http",
					endpoint: "/mcp",
					auth: "bearer-agent-key",
					verifier_configured: o.verifier.configured,
				});
				return;
			}

			if (path !== "/mcp") {
				outcome = "not_found";
				send(404, { error: "not_found" });
				return;
			}

			if (method !== "POST") {
				// Stateless: no SSE stream to open (GET), no session to end
				// (DELETE), and no CORS preflight to answer (OPTIONS).
				outcome = "method_not_allowed";
				send(405, { error: "method_not_allowed", allow: "POST" }, { allow: "POST" });
				return;
			}

			/* 0. per-IP brake on verification attempts: a request
			   whose key is not already answered from cache would cost one
			   upstream call. Count those per client IP BEFORE asking, so a
			   flood of well-formed unknown keys cannot turn this server into
			   an introspection amplifier. Cached answers are free and unbraked. */
			const presented = parseBearer(req.headers.authorization);
			if (!o.verifier.isCached(presented)) {
				const ip = clientIpOf(req);
				const brake = o.verifyLimiter.hit(ip);
				if (!brake.allowed) {
					outcome = "verify_rate_limited";
					o.log({ ts: new Date(now()).toISOString(), event: "verify_rate_limited" });
					send(
						429,
						{
							error: "rate_limited",
							message: `Too many key verifications from this client. Retry after ${brake.retryAfterSeconds}s.`,
						},
						{ "retry-after": String(brake.retryAfterSeconds) }
					);
					return;
				}
			}

			/* 1. credential */
			const verdict = await o.verifier.verify(presented);
			if (!verdict.ok) {
				outcome = verdict.code;
				send(
					verdict.status,
					{ error: verdict.code, message: verdict.message },
					verdict.status === 401
						? { "www-authenticate": 'Bearer realm="commertize-agents"' }
						: {}
				);
				return;
			}
			keyId = verdict.keyId;

			/* 2. per-key request ceiling */
			const limit = o.requestLimiter.hit(keyId);
			if (!limit.allowed) {
				outcome = "rate_limited";
				o.log({ ts: new Date(now()).toISOString(), event: "rate_limited", key_id: keyId });
				send(
					429,
					{
						error: "rate_limited",
						message: `Too many requests for this key. Retry after ${limit.retryAfterSeconds}s.`,
					},
					{ "retry-after": String(limit.retryAfterSeconds) }
				);
				return;
			}

			/* 3. body */
			const ct = String(req.headers["content-type"] ?? "");
			if (!/^application\/json(?:[ \t]*;|$)/i.test(ct)) {
				outcome = "unsupported_media_type";
				send(415, { error: "unsupported_media_type", message: "Send application/json." });
				return;
			}
			const raw = await readBody(req, o.maxBodyBytes);
			if (raw === null) {
				outcome = "payload_too_large";
				send(413, {
					error: "payload_too_large",
					message: `The body exceeds ${o.maxBodyBytes} bytes.`,
				});
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

			/* 4. allowlist, applied to every message of a batch */
			const messages: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
			rpc = messages
				.map((m) =>
					m && typeof m === "object" && typeof (m as { method?: unknown }).method === "string"
						? ((m as { method: string }).method as string)
						: ""
				)
				.filter((m) => m !== "");
			for (const m of messages) {
				if (!m || typeof m !== "object") continue;
				const msg = m as { method?: unknown; id?: unknown; params?: { name?: unknown } };
				if (msg.method !== "tools/call") continue;
				const name = msg.params?.name;
				tool = typeof name === "string" ? name : String(name);
				if (!isAllowedOverHttp(name)) {
					outcome = "tool_refused";
					o.log({
						ts: new Date(now()).toISOString(),
						event: "tool_refused",
						key_id: keyId,
						tool,
					});
					send(
						403,
						rpcError(
							msg.id,
							-32601,
							`Tool "${tool}" is not available over HTTP. The HTTP surface is the read tools and file_sponsor_inquiry.`
						)
					);
					return;
				}
				if (isInquiryTool(name)) {
					const q = o.inquiryLimiter.hit(keyId);
					if (!q.allowed) {
						outcome = "inquiry_rate_limited";
						o.log({
							ts: new Date(now()).toISOString(),
							event: "inquiry_rate_limited",
							key_id: keyId,
						});
						send(
							429,
							rpcError(
								msg.id,
								-32000,
								`Inquiry ceiling reached for this key. Retry after ${q.retryAfterSeconds}s. Nothing was filed.`
							),
							{ "retry-after": String(q.retryAfterSeconds) }
						);
						return;
					}
				}
			}

			/* 5. dispatch */
			const server = o.createServer();
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
				event: "error",
				key_id: keyId,
				message: err instanceof Error ? err.message : String(err),
			});
			if (!res.headersSent) send(500, { error: "internal_error" });
		} finally {
			o.log({
				ts: new Date(now()).toISOString(),
				event: "request",
				method,
				path,
				key_id: keyId,
				rpc,
				tool,
				status: res.statusCode,
				outcome,
				ms: now() - started,
			});
		}
	};
};
