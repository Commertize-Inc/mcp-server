// Vercel serverless entry for POST /mcp/public (rewritten here by vercel.json).
// The no-login read-only endpoint; 404 unless COMMERTIZE_MCP_ENABLE_PUBLIC=1.
// The path is pinned, as in api/mcp.js, so routing never depends on how the
// platform reports a rewritten URL.
import { publicHandler } from "../dist/httpEntry.js";

export default function mcpPublic(req, res) {
	req.url = "/mcp/public";
	return publicHandler(req, res);
}
