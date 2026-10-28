import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when this module is the script Node was started with.
 *
 * `import.meta.url === "file://" + process.argv[1]` is false whenever the
 * script is reached through a symlink, which is how npm installs every `bin`
 * (node_modules/.bin/commertize-mcp-server -> ../commertize-mcp-server/dist/
 * index.js). Under `npx` or a global install, the server therefore exited
 * silently. Both sides are resolved with realpathSync, so a symlinked
 * launch, a relative argv path and a percent-encoded path (spaces) all
 * match, while importing the module from a test still does not start it.
 */
export function isMainModule(
	metaUrl: string,
	argv1: string | undefined = process.argv[1]
): boolean {
	if (!argv1) return false;
	try {
		return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
	} catch {
		return false;
	}
}
