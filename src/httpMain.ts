#!/usr/bin/env node
/**
 * Commertize MCP server — Streamable HTTP transport, local process.
 *
 *   node dist/httpMain.js
 *
 * Binds 127.0.0.1:3920 unless COMMERTIZE_MCP_HTTP_HOST / _PORT say otherwise.
 * Every request needs `Authorization: Bearer cfa_…`, verified against the API
 * named by COMMERTIZE_API_BASE_URL (see httpAuth.ts). There is no anonymous
 * mode and no "skip verification" switch.
 */

import { createServer as createNodeServer } from "node:http";

import { config } from "./config.js";
import { handler, VERSION } from "./httpEntry.js";

const main = (): void => {
	const server = createNodeServer((req, res) => {
		handler(req, res).catch((err) => {
			// The handler answers its own errors; this is the last resort.
			if (!res.headersSent) {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "internal_error" }));
			}
			process.stderr.write(
				`${JSON.stringify({ ts: new Date().toISOString(), event: "fatal", message: err instanceof Error ? err.message : String(err) })}\n`
			);
		});
	});
	server.listen(config.httpPort, config.httpHost, () => {
		process.stderr.write(
			`commertize-mcp-server ${VERSION} ready on http://${config.httpHost}:${config.httpPort}/mcp (api: ${config.apiBaseUrl}, verifier: ${config.keyIntrospectPath}, rpm: ${config.httpRequestsPerMinute}${
				config.inquiryDisabled ? ", inquiry: DISABLED" : ""
			})\n`
		);
	});
};

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	main();
}
