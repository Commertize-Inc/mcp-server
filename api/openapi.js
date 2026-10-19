// Vercel serverless entry for GET /openapi.json (rewritten here by vercel.json).
// 404 unless COMMERTIZE_MCP_ENABLE_PUBLIC=1, the same gate as /mcp/public.
import { openApiHandler } from "../dist/httpEntry.js";

export default function openapi(req, res) {
	req.url = "/openapi.json";
	return openApiHandler(req, res);
}
