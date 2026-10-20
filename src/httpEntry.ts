/**
 * The production HTTP handler, built once from `config` and shared by the
 * local server (`httpMain.ts`) and the serverless entries (`api/*.js`).
 *
 * Everything that varies by deployment comes from the environment through
 * `config.ts`; nothing here reads `process.env` directly.
 */

import { config } from "./config.js";
import { KeyVerifier } from "./httpAuth.js";
import { FixedWindowLimiter } from "./httpRateLimit.js";
import { createHttpHandler, type HttpLogEvent, type NodeHandler } from "./httpServer.js";
import { analyticsConfigFrom, createAnalyticsSink } from "./analytics.js";
import { createOpenApiHandler, createPublicHttpHandler } from "./httpPublic.js";
import { createAgentCardHandler } from "./agentCard.js";
import { createServer } from "./index.js";

export const VERSION = "0.2.0";

// PostHog, off unless COMMERTIZE_MCP_ANALYTICS=1 and a phc_ key are set
// (analytics.ts). Undefined sink = nothing is sent, on either surface.
const analyticsSink =
	createAnalyticsSink(analyticsConfigFrom(config.analyticsEnv, VERSION)) ?? undefined;

/** One JSON object per line on stderr. stdout stays free for stdio mode. */
export const logToStderr = (e: HttpLogEvent): void => {
	process.stderr.write(`${JSON.stringify(e)}\n`);
};

export const buildHandler = (log: (e: HttpLogEvent) => void = logToStderr): NodeHandler =>
	createHttpHandler({
		verifier: new KeyVerifier({
			introspectUrl: `${config.apiBaseUrl}${config.keyIntrospectPath}`,
			serviceSecret: config.introspectSecret,
			cacheMs: config.keyVerifyCacheMs,
			negativeCacheMs: config.keyNegativeCacheMs,
			timeoutMs: config.requestTimeoutMs,
			userAgent: config.userAgent,
		}),
		requestLimiter: new FixedWindowLimiter(config.httpRequestsPerMinute, 60_000),
		inquiryLimiter: new FixedWindowLimiter(config.httpInquiriesPerHour, 60 * 60_000),
		verifyLimiter: new FixedWindowLimiter(config.httpVerifyPerIpPerMinute, 60_000),
		createServer: () => createServer("http"),
		log,
		maxBodyBytes: config.httpMaxBodyBytes,
		version: VERSION,
		afterResponse: analyticsSink,
	});

/** Module-level singleton: a warm serverless instance reuses its caches. */
export const handler: NodeHandler = buildHandler();

/**
 * The no-login public endpoint (`POST /mcp/public`, httpPublic.ts). Its own
 * handler and its own per-IP limiter; nothing above is shared except the log
 * sink. Closed unless COMMERTIZE_MCP_ENABLE_PUBLIC=1 (config.ts).
 */
export const buildPublicHandler = (
	log: (e: HttpLogEvent) => void = logToStderr
): NodeHandler =>
	createPublicHttpHandler({
		enabled: () => !config.publicDisabled,
		ipLimiter: new FixedWindowLimiter(config.publicRequestsPerIpPerMinute, 60_000),
		createServer: (onToolResult) => createServer("public", onToolResult),
		log,
		maxBodyBytes: config.httpMaxBodyBytes,
		// PostHog, off unless COMMERTIZE_MCP_ANALYTICS=1 and a phc_ key are set
		// (analytics.ts). Null sink = nothing is sent.
		afterResponse: analyticsSink,
	});

export const publicHandler: NodeHandler = buildPublicHandler();

/** `GET /openapi.json`, behind the same gate as `/mcp/public`. */
export const openApiHandler: NodeHandler = createOpenApiHandler({
	enabled: () => !config.publicDisabled,
});

/** `GET /.well-known/agent-card.json` and `/.well-known/agent.json`, same gate. */
export const agentCardHandler: NodeHandler = createAgentCardHandler({
	enabled: () => !config.publicDisabled,
});
