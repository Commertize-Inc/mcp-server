// Vercel serverless entry for GET /health (rewritten here by vercel.json).
import { handler } from "../dist/httpEntry.js";

export default function health(req, res) {
	req.url = "/health";
	return handler(req, res);
}
