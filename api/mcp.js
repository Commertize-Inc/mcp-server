// Vercel serverless entry for POST /mcp (rewritten here by vercel.json).
// The path is pinned rather than read back from the rewrite, so the handler's
// routing never depends on how the platform reports a rewritten URL.
import { handler } from "../dist/httpEntry.js";

export default function mcp(req, res) {
	// Keep the query (`?src=` directory attribution, analytics.ts); the path stays pinned.
	const q = (req.url ?? "").indexOf("?");
	req.url = "/mcp" + (q >= 0 ? req.url.slice(q) : "");
	return handler(req, res);
}
