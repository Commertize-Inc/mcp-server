/**
 * server.json (MCP registry entry) must parse, and its version must equal the
 * version /health reports (src/httpEntry.ts VERSION) and package.json.
 * Offline. Run directly: node test/server-json.mjs (after npm run build)
 */
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { check, resetCounters, summary } from "./harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
resetCounters();
const sj = JSON.parse(await readFile(path.join(ROOT, "server.json"), "utf8"));
const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
const { VERSION } = await import(
	pathToFileURL(path.join(ROOT, "dist", "httpEntry.js")).href
);
check(
	"server.json version equals /health VERSION",
	sj.version === VERSION,
	`${sj.version} vs ${VERSION}`,
);
check("server.json version equals package.json", sj.version === pkg.version);
check(
	"one remote, the keyless public endpoint",
	sj.remotes?.length === 1 &&
		/\/mcp\/public\?src=mcp-registry$/.test(sj.remotes[0].url),
);
check(
	"remote is https on agents.commertize.com",
	new URL(sj.remotes[0].url).origin === "https://agents.commertize.com",
);
check(
	"repository is this repo",
	sj.repository?.url === "https://github.com/Commertize-Inc/mcp-server",
);
process.exit(summary("server.json") ? 1 : 0);
