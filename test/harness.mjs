/**
 * Shared test harness: a real MCP client speaking stdio to a real spawned
 * server process. No mocks of the transport, no hand-rolled JSON-RPC.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ENTRY = path.resolve(HERE, "..", "dist", "index.js");

/** The one true disclaimer string, imported from the built server. */
export const { DISCLAIMER } = await import(
	path.resolve(HERE, "..", "dist", "disclaimer.js")
);

let failures = 0;
let checks = 0;

export const check = (name, condition, detail = "") => {
	checks += 1;
	if (condition) {
		console.log(`  ok   ${name}`);
	} else {
		failures += 1;
		console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
};

export const section = (title) => console.log(`\n${title}`);

export const summary = (label) => {
	console.log(
		`\n${label}: ${checks - failures}/${checks} checks passed${
			failures ? ` (${failures} FAILED)` : ""
		}`
	);
	return failures;
};

export const resetCounters = () => {
	failures = 0;
	checks = 0;
};

/** Spawn the server and return a connected client. */
export const connect = async (env = {}) => {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [SERVER_ENTRY],
		env: { ...process.env, ...env },
		stderr: "pipe",
	});
	const client = new Client({ name: "commertize-mcp-test", version: "0.1.0" });
	await client.connect(transport);
	return client;
};

/** Call a tool and return { result, payload } with payload = structuredContent. */
export const call = async (client, name, args = {}) => {
	const result = await client.callTool({ name, arguments: args });
	const payload =
		result.structuredContent ??
		(() => {
			try {
				return JSON.parse(result.content?.[0]?.text ?? "null");
			} catch {
				return null;
			}
		})();
	return { result, payload };
};

/** Envelope invariants that must hold on EVERY response, success or error. */
export const checkEnvelope = (label, payload) => {
	check(`${label}: has as_of`, typeof payload?.as_of === "string");
	check(
		`${label}: as_of parses as a date`,
		!Number.isNaN(Date.parse(payload?.as_of ?? ""))
	);
	check(
		`${label}: has source_url`,
		typeof payload?.source_url === "string" && payload.source_url.startsWith("http")
	);
	check(
		`${label}: has cache metadata`,
		typeof payload?.cache?.hit === "boolean" &&
			typeof payload?.cache?.age_seconds === "number" &&
			typeof payload?.cache?.stale === "boolean"
	);
	check(
		`${label}: carries the canonical disclaimer verbatim`,
		payload?.disclaimer === DISCLAIMER
	);
	check(`${label}: error key present`, "error" in (payload ?? {}));
};
