/**
 * Every serverInfo version in src/index.ts equals VERSION (what /health
 * reports) and package.json. A second hand-typed version is how the public
 * serverInfo drifted to 0.1.0 while /health said 0.2.0.
 * Offline. Run directly: node test/version-pin.mjs (after npm run build)
 */
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { check, resetCounters, summary } from "./harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
resetCounters();
const { VERSION } = await import(pathToFileURL(path.join(ROOT, "dist", "httpEntry.js")).href);
const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
const src = await readFile(path.join(ROOT, "src", "index.ts"), "utf8");
const versions = [...src.matchAll(/name: "commertize", version: "([^"]+)"/g)].map((m) => m[1]);
check("index.ts declares at least two serverInfo versions (stdio/http and public)", versions.length >= 2, JSON.stringify(versions));
check("every serverInfo version equals VERSION", versions.every((v) => v === VERSION), `${JSON.stringify(versions)} vs ${VERSION}`);
check("VERSION equals package.json", VERSION === pkg.version, `${VERSION} vs ${pkg.version}`);
process.exit(summary("version pin") ? 1 : 0);
