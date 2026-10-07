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
import { createServer } from "./index.js";

export const VERSION = "0.1.0";

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
	});

/** Module-level singleton: a warm serverless instance reuses its caches. */
export const handler: NodeHandler = buildHandler();
