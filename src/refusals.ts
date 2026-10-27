/**
 * Machine-readable refusals for the agent-facing HTTP surfaces.
 *
 * Every refusal an outside agent can receive is `{ error: <code>, fix: <one
 * line> }`: `error` is a closed, stable code (unchanged from the codes these
 * endpoints already returned, so nothing that parses `error` breaks), and
 * `fix` is one line saying what to do next. JSON-RPC refusals carry the same
 * pair in `error.data`. There is no bare 401/403/429/500 on the public
 * surface (market research competitive map 2026-10-20 section 8: an agent that cannot
 * tell what to do next leaves).
 *
 * The `fix` lines are DRAFT copy pending legal review certification (handoff
 * an internal note); the surface they appear on is
 * behind COMMERTIZE_MCP_ENABLE_PUBLIC, closed by default. Rules for adding a
 * line: no barred words (wording-guard), no promise, one line, at most 200
 * characters, and it names a concrete next step.
 */

/**
 * D6 (legal review RULING_sec_ui_statement_mcp_2026-10-20; text CERTIFIED in
 * CERT_front_door_copy_2026-10-20 §1, byte for byte). One field name
 * everywhere (cert §8): `sec_disclaimer` on the agent card, every refusal
 * body, JSON-RPC `error.data`, and tool results (whose `disclaimer` field
 * keeps D-1). Never in `disclaimer`, never edited or merged into `fix`.
 */
export const D6_DISCLAIMER =
	"Commertize is not registered with or regulated by the SEC as a broker-dealer or investment adviser. This is not a recommendation or investment advice. Consult your own advisers.";

export const PUBLIC_ENDPOINT_URL = "https://agents.commertize.com/mcp/public";
export const AGENT_CARD_URL = "https://agents.commertize.com/.well-known/agent-card.json";

export const REFUSAL_FIX = Object.freeze({
	not_found: `Unknown path. The no-key MCP endpoint is POST ${PUBLIC_ENDPOINT_URL}; the agent card is at ${AGENT_CARD_URL}.`,
	method_not_allowed: "Use POST with a JSON-RPC 2.0 body. This endpoint keeps no session and opens no stream.",
	origin_not_allowed: "Call from a server-side client without an Origin header; browser origins other than agents.commertize.com are refused.",
	rate_limited: "Too many requests from this client. Wait for the Retry-After seconds, then retry.",
	get_only: "Use GET.",
	unsupported_media_type: "Send Content-Type: application/json.",
	payload_too_large: "The request body is too large. Send one JSON-RPC message per request.",
	parse_error: "The body is not valid JSON. Send one JSON-RPC 2.0 message.",
	batch_refused: "JSON-RPC batches are not accepted. Send one message per request.",
	tool_not_public: "That tool is not on the no-key surface. Call tools/list for the tools you can use.",
	internal_error: "Something failed on our side. Retry later; if you sent a payment, resend the same one, never a new one.",
	missing_credential: `No key is needed for the public tools: POST ${PUBLIC_ENDPOINT_URL} (initialize, then tools/list).`,
	malformed_credential: `This endpoint needs a Commertize agent key. Without one, use POST ${PUBLIC_ENDPOINT_URL}.`,
	invalid_credential: `This key is not valid here. Without a key, use POST ${PUBLIC_ENDPOINT_URL}.`,
	verifier_unavailable: "The key check is unavailable. Retry later.",
	verifier_not_configured: `Keyed access is not open on this deployment. Use POST ${PUBLIC_ENDPOINT_URL}.`,
	verify_rate_limited: "Too many key checks from this client. Wait for the Retry-After seconds, then retry.",
} as const);

export type RefusalCode = keyof typeof REFUSAL_FIX;

/** The HTTP body for a refusal: the stable code plus its one-line fix. */
export const refusalBody = (code: RefusalCode, extra: Record<string, unknown> = {}) => ({
	error: code,
	fix: REFUSAL_FIX[code],
	sec_disclaimer: D6_DISCLAIMER,
	...extra,
});

const RPC_CODE_REFUSAL: Readonly<Record<number, RefusalCode>> = {
	[-32700]: "parse_error",
	[-32600]: "batch_refused",
	[-32601]: "tool_not_public",
	[-32000]: "rate_limited",
};

const isRefusalCode = (c: unknown): c is RefusalCode =>
	typeof c === "string" && Object.hasOwn(REFUSAL_FIX, c);

/**
 * Add the one-line fix to a refusal body that lacks one (the keyed `/mcp`
 * handler's existing bodies). A plain `{ error: <code> }` gains `fix`; a
 * JSON-RPC error gains `data: { error, fix }`. Bodies that already carry a
 * fix, success bodies, and unknown codes are returned unchanged.
 */
export const withFix = (status: number, body: unknown): unknown => {
	if (status < 400 || !body || typeof body !== "object") return body;
	const b = body as Record<string, unknown>;
	if ("fix" in b) return body;
	if (isRefusalCode(b.error)) return { ...b, fix: REFUSAL_FIX[b.error], sec_disclaimer: D6_DISCLAIMER };
	const e = b.error as { code?: unknown; data?: unknown } | undefined;
	if (e && typeof e === "object" && e.data === undefined && typeof e.code === "number") {
		const code = RPC_CODE_REFUSAL[e.code];
		if (code)
			return {
				...b,
				error: { ...e, data: { error: code, fix: REFUSAL_FIX[code], sec_disclaimer: D6_DISCLAIMER } },
			};
	}
	return body;
};

/** A JSON-RPC 2.0 error that carries the same code and fix in `data`. */
export const rpcRefusal = (id: unknown, rpcCode: number, message: string, code: RefusalCode) => ({
	jsonrpc: "2.0" as const,
	id: id === undefined ? null : id,
	error: {
		code: rpcCode,
		message,
		data: { error: code, fix: REFUSAL_FIX[code], sec_disclaimer: D6_DISCLAIMER },
	},
});
