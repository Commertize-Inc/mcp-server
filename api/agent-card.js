// Vercel serverless entry for GET /.well-known/agent-card.json and
// /.well-known/agent.json (rewritten here by vercel.json with ?p=card|legacy).
// 404 unless COMMERTIZE_MCP_ENABLE_PUBLIC=1, the same gate as /mcp/public.
// The path is pinned from the closed ?p= value, never from the request.
import { agentCardHandler } from "../dist/httpEntry.js";

export default function agentCard(req, res) {
	const legacy = /[?&]p=legacy(?:&|$)/.test(req.url ?? "");
	req.url = legacy ? "/.well-known/agent.json" : "/.well-known/agent-card.json";
	return agentCardHandler(req, res);
}
