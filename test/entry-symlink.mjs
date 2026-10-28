/**
 * Entry detection: npm installs every `bin` as a
 * SYMLINK (node_modules/.bin/commertize-mcp-server -> .../dist/index.js), so
 * `npx` and global installs start Node with argv[1] = the link. The old check
 * (`import.meta.url === "file://" + argv[1]`) compared the link to the real
 * file and silently did nothing. Offline; needs loopback for the HTTP case.
 *
 * Runs against dist/ (npm test builds first).
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainModule } from "../dist/isMain.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "..", "dist");
const SCRATCH = path.join(HERE, `.entry-scratch-${process.pid}`);
let failed = 0;
let passed = 0;
const check = (name, ok, detail = "") => {
	if (ok) passed++;
	else failed++;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
};

/** Spawn, wait for `marker` on stderr (or exit / timeout), then kill. */
function launch(argv, { cwd = SCRATCH, env = {}, marker, ms = 15000, stdin } = {}) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, argv, {
			cwd,
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let err = "";
		let out = "";
		let done = false;
		const finish = (r) => {
			if (done) return;
			done = true;
			clearTimeout(t);
			child.kill("SIGKILL");
			resolve({ ...r, err, out });
		};
		const t = setTimeout(() => finish({ started: false, why: "timeout" }), ms);
		child.stderr.on("data", (d) => {
			err += d;
			if (marker && err.includes(marker) && !stdin) finish({ started: true });
		});
		child.stdout.on("data", (d) => {
			out += d;
			if (stdin && out.includes('"id":1')) finish({ started: true });
		});
		child.on("exit", (code) => finish({ started: false, why: `exit ${code}` }));
		if (stdin) child.stdin.write(stdin);
	});
}

const freePort = () =>
	new Promise((res, rej) => {
		const s = createServer();
		s.once("error", rej);
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => res(port));
		});
	});

const INIT = `${JSON.stringify({
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "entry-test", version: "0" },
	},
})}\n`;

try {
	mkdirSync(path.join(SCRATCH, "node_modules", ".bin"), { recursive: true });
	const stdioLink = path.join(SCRATCH, "node_modules", ".bin", "commertize-mcp-server");
	const httpLink = path.join(SCRATCH, "node_modules", ".bin", "commertize-mcp-http");
	symlinkSync(path.join(DIST, "index.js"), stdioLink);
	symlinkSync(path.join(DIST, "httpMain.js"), httpLink);

	// unit: isMainModule
	const real = pathToFileURL(path.join(DIST, "index.js")).href;
	check(
		"positive control: the old string compare is false for a bin symlink",
		real !== `file://${stdioLink}`
	);
	check("isMainModule: symlinked bin matches the real module", isMainModule(real, stdioLink));
	check("isMainModule: the real path matches", isMainModule(real, path.join(DIST, "index.js")));
	check(
		"isMainModule: a different script does not match",
		!isMainModule(real, path.join(DIST, "httpMain.js"))
	);
	check("isMainModule: no argv[1] is false", !isMainModule(real, undefined));
	check("isMainModule: a missing path is false (no throw)", !isMainModule(real, path.join(SCRATCH, "nope.js")));

	// stdio server through the npm-style bin symlink answers initialize
	const viaLink = await launch([stdioLink], { stdin: INIT });
	check("stdio: launched via node_modules/.bin symlink answers initialize", viaLink.started, `${viaLink.why} ${viaLink.err.slice(0, 300)}`);
	check("stdio: ready line on stderr, never stdout", viaLink.err.includes("ready on stdio") && !viaLink.out.includes("ready on"), viaLink.err.slice(0, 200));

	const viaRel = await launch([path.join("node_modules", ".bin", "commertize-mcp-server")], { stdin: INIT });
	check("stdio: relative symlink argv starts too", viaRel.started, `${viaRel.why}`);

	const direct = await launch([path.join(DIST, "index.js")], { stdin: INIT });
	check("stdio: direct path still starts", direct.started, `${direct.why}`);

	// importing the module (tests, other code) must never grab stdio
	const imported = await launch(
		["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(path.join(DIST, "index.js")).href)}); setTimeout(() => {}, 1500);`],
		{ marker: "ready on stdio", ms: 4000 }
	);
	check("import only: the server does not start", !imported.started && !imported.err.includes("ready on"), imported.err.slice(0, 200));

	// HTTP server through its bin symlink
	const port = await freePort();
	const http = await launch([httpLink], {
		env: { COMMERTIZE_MCP_HTTP_PORT: String(port), COMMERTIZE_MCP_HTTP_HOST: "127.0.0.1" },
		marker: "ready on http://",
	});
	check("http: launched via bin symlink listens", http.started, `${http.why} ${http.err.slice(0, 300)}`);
} finally {
	if (path.basename(SCRATCH).startsWith(".entry-scratch-") && path.dirname(SCRATCH) === HERE)
		rmSync(SCRATCH, { recursive: true, force: true });
}

console.log(`\nentry-symlink: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
