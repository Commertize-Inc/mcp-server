/**
 * Signed relay identity, the MCP half (AEGIS mcp #14 M-1 = backend #835 M-2).
 *
 * Every agent relayed through `/mcp/public` reaches the backend from this
 * function's egress address, so the backend's per-IP buckets (free ceiling,
 * P4 30/min) are ONE bucket for all relayed agents: a busy agent locks the
 * rest out and hands them false x402 challenges. This module lets the
 * backend tell relayed callers apart without trusting anything a caller can
 * set:
 *
 *   X-Commertize-Relay-Identity: v1.<ts>.<nonce>.<subject>.<sig>
 *     subject = HMAC-SHA256(secret, "commertize-relay-subject/v1\n" + bucket)
 *               where bucket is this server's own view of the caller
 *               (clientIpOf: Vercel edge header, IPv6 /64). A keyed hash, so
 *               the caller's address never leaves this server.
 *     sig     = HMAC-SHA256(secret, "commertize-relay-identity/v1\n" + ts +
 *               "\n" + nonce + "\n" + subject + "\n" + scope)
 *     scope   = "p4:" + supplier id (one route + one supplier per header)
 *
 * The byte layout is pinned by a golden vector shared with
 * apps/backend/test/agent_data_relay_identity.test.ts.
 *
 * FAIL CLOSED: flag not exactly "1", secret absent or under 32 chars, or no
 * caller bucket in scope (stdio, tests, "unknown" address) -> NO header is
 * sent, and the backend buckets the call on the shared relay address exactly
 * as before this change. Nothing here ever names an identity the backend
 * would trust without the shared secret.
 *
 * Env, read per call and never logged:
 *   COMMERTIZE_MCP_RELAY_IDENTITY_ENABLED  exactly "1" to sign (default off)
 *   COMMERTIZE_MCP_RELAY_SECRET            same value as the backend's
 *                                          AGENT_DATA_RELAY_SECRET; set by
 *                                          the owner, never by an agent
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes } from "node:crypto";

export const RELAY_IDENTITY_HEADER = "x-commertize-relay-identity";
export const RELAY_IDENTITY_DOMAIN = "commertize-relay-identity/v1";
export const RELAY_SUBJECT_DOMAIN = "commertize-relay-subject/v1";
export const RELAY_SECRET_MIN_LENGTH = 32;

export interface RelayConfig {
	enabled: boolean;
	/** null = absent or shorter than RELAY_SECRET_MIN_LENGTH. */
	secret: string | null;
}

export const relayConfigFromEnv = (
	env: Record<string, string | undefined> = process.env
): RelayConfig => {
	const s = env.COMMERTIZE_MCP_RELAY_SECRET ?? "";
	return {
		enabled: env.COMMERTIZE_MCP_RELAY_IDENTITY_ENABLED === "1",
		secret: s.length >= RELAY_SECRET_MIN_LENGTH ? s : null,
	};
};

export const relaySubject = (secret: string, bucket: string): string =>
	createHmac("sha256", secret).update(`${RELAY_SUBJECT_DOMAIN}\n${bucket}`).digest("hex");

export const relaySignature = (
	secret: string,
	ts: string,
	nonce: string,
	subject: string,
	scope: string
): string =>
	createHmac("sha256", secret)
		.update(`${RELAY_IDENTITY_DOMAIN}\n${ts}\n${nonce}\n${subject}\n${scope}`)
		.digest("hex");

/** The caller this request is being served for (set by httpPublic.ts). */
const caller = new AsyncLocalStorage<{ bucket: string }>();

export const runAsRelayCaller = <T>(bucket: string, fn: () => T): T =>
	caller.run({ bucket }, fn);

/**
 * The header to attach to a backend call for `scope`, or {} (send nothing)
 * whenever any precondition is missing.
 */
export const relayIdentityHeaders = (
	scope: string,
	o: {
		config?: RelayConfig;
		nowSec?: number;
		nonce?: string;
		bucket?: string | null;
	} = {}
): Record<string, string> => {
	const config = o.config ?? relayConfigFromEnv();
	if (!config.enabled || !config.secret) return {};
	const bucket = o.bucket !== undefined ? o.bucket : (caller.getStore()?.bucket ?? null);
	if (!bucket || bucket === "unknown") return {};
	const ts = String(Math.floor(o.nowSec ?? Date.now() / 1000));
	const nonce = o.nonce ?? randomBytes(16).toString("hex");
	const subject = relaySubject(config.secret, bucket);
	const sig = relaySignature(config.secret, ts, nonce, subject, scope);
	return { [RELAY_IDENTITY_HEADER]: `v1.${ts}.${nonce}.${subject}.${sig}` };
};
