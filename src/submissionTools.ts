/**
 * `submit_asset` and `get_submission_status` (funnel map A2b/A3).
 *
 * Thin relays over the Commertize API's keyed routes
 * `POST /api/agents/submissions` and `GET /api/agents/submissions/{id}`
 * (commertize.com PR #876). The API enforces everything that matters: a
 * vended key bound to a KYC-approved principal, the principal in the body
 * being that key holder, authority attested, a per-key daily cap, and a
 * strict schema with no money terms. This server re-validates the same
 * shape so a malformed call fails before it spends a unit of the cap.
 *
 * What the tools report is what the API returned: an id and screening
 * states. `pending` means not screened yet. Nothing here promises a review
 * time, an outcome or a listing, and a human principal signs anything that
 * follows.
 *
 * Gated at registration (`config.submissionsDisabled`, default OFF), stdio
 * only. Without `COMMERTIZE_AGENT_KEY` a registered tool refuses and files
 * nothing.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { config } from "./config.js";
import { DISCLAIMER } from "./disclaimer.js";
import { toResult } from "./envelope.js";

export const SUBMISSION_TOOL_NAMES = [
	"submit_asset",
	"get_submission_status",
] as const;
export const SUBMISSIONS_PATH = "/api/agents/submissions";

/** Mirrors the API's lists (apps/backend/src/routes/assetSubmissions.ts). */
const ASSET_CLASSES = [
	"commercial_real_estate",
	"industrial",
	"energy",
	"digital_infrastructure",
	"precious_metals",
	"carbon",
	"agriculture",
	"other",
] as const;
const SIZE_BANDS = ["under_1m", "1m_to_10m", "10m_to_500m", "over_500m"] as const;
const DOCUMENT_IDS = [
	"title_or_deed",
	"entity_documents",
	"operating_statements",
	"rent_roll",
	"appraisal",
	"environmental_report",
	"survey",
	"existing_debt_documents",
	"insurance",
	"permits_or_licenses",
	"offtake_or_ppa",
	"technical_report",
] as const;
const UUID_RX =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const shortText = (max: number) =>
	z
		.string()
		.trim()
		.min(1)
		.max(max)
		.regex(/^[^<>\u0000-\u001f\u007f]*$/, "no markup or control characters");

const statusShape = z
	.object({
		submission_id: z.string(),
		counterparty_kind: z.literal("agent"),
		received_at: z.string(),
		updated_at: z.string(),
		asset_class: z.string(),
		size_band: z.string(),
		gate0: z.object({ state: z.string(), profile: z.string() }),
		atlas: z.object({ state: z.string() }),
		documents_needed: z.array(z.string()),
		principal_signature_required: z.literal(true),
	})
	.nullable()
	.describe("Null when nothing was returned; read `error`.");

const outputSchema = {
	submission: statusShape,
	as_of: z.string(),
	source_url: z.string(),
	cache: z.object({
		hit: z.boolean(),
		age_seconds: z.number(),
		stale: z.boolean(),
	}),
	disclaimer: z.string(),
	error: z
		.object({
			code: z.string(),
			message: z.string(),
			retryable: z.boolean(),
			status: z.number().optional(),
		})
		.nullable(),
};

type ErrorCode = "NO_CREDENTIAL" | "UPSTREAM_ERROR" | "UPSTREAM_BAD_BODY" | "UPSTREAM_UNREACHABLE";

const envelope = (
	sourceUrl: string,
	submission: unknown,
	error: { code: ErrorCode; message: string; retryable: boolean; status?: number } | null
) =>
	toResult(
		{
			submission,
			as_of: new Date().toISOString(),
			source_url: sourceUrl,
			cache: { hit: false, age_seconds: 0, stale: false },
			disclaimer: DISCLAIMER,
			error,
		},
		error !== null
	);

/** Keyed request to the API. The key goes in `x-api-key`, never in a URL. */
const keyed = async (
	method: "GET" | "POST",
	path: string,
	body?: unknown
) => {
	const url = `${config.apiBaseUrl}${path}`;
	if (!config.agentKey) {
		return envelope(url, null, {
			code: "NO_CREDENTIAL",
			message:
				"This tool needs an agent key issued to a Commertize account (set COMMERTIZE_AGENT_KEY). Nothing was sent.",
			retryable: false,
		});
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
	try {
		const res = await fetch(url, {
			method,
			signal: controller.signal,
			headers: {
				accept: "application/json",
				"user-agent": config.userAgent,
				"x-api-key": config.agentKey,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		let parsed: unknown = null;
		try {
			parsed = await res.json();
		} catch {
			parsed = null;
		}
		if (!res.ok) {
			const detail =
				parsed && typeof parsed === "object" && "error" in parsed
					? String((parsed as { error: unknown }).error).slice(0, 200)
					: `HTTP ${res.status}`;
			return envelope(url, null, {
				code: "UPSTREAM_ERROR",
				message: `Commertize API refused the request: ${detail}`,
				// A 4xx is the request being wrong; 429 and 5xx are timing.
				retryable: res.status >= 500 || res.status === 429,
				status: res.status,
			});
		}
		const s = statusShape.safeParse(parsed);
		if (!s.success || s.data === null) {
			return envelope(url, null, {
				code: "UPSTREAM_BAD_BODY",
				message:
					"The API answered but not with a submission status this server can relay, so nothing is reported as filed.",
				retryable: false,
				status: res.status,
			});
		}
		return envelope(url, s.data, null);
	} catch (err) {
		return envelope(url, null, {
			code: "UPSTREAM_UNREACHABLE",
			message: `Commertize API is unreachable (${url}): ${
				err instanceof Error ? err.name : "error"
			}`,
			retryable: true,
		});
	} finally {
		clearTimeout(timer);
	}
};

export const registerSubmissionTools = (server: McpServer): void => {
	if (config.submissionsDisabled) return;

	server.registerTool(
		"submit_asset",
		{
			title: "Submit an asset your principal controls for a tokenization review",
			description:
				"Submit an asset that your principal controls to Commertize for a tokenization review. The principal must be the verified person who holds the agent key, and must have authority over the asset. Send the asset class, location, size band and the names of documents that exist; do not send prices, raise amounts, returns or investor terms, which this tool does not accept. Returns a submission id and the screening state (gate0 pending, atlas not_started). Nothing is promised beyond that. Any agreement that follows is signed by the human principal, never by the agent. Limited to 5 submissions per key per day. Do not retry a 400 or 403; a 429 may be retried the next UTC day.",
			// A strict object, not a raw shape: the SDK wraps a raw shape in a
			// non-strict object, which silently DROPS an extra key such as a
			// raise amount instead of refusing the call.
			inputSchema: z.object({
				asset_class: z.enum(ASSET_CLASSES),
				location: z
					.object({
						country: z
							.string()
							.regex(/^[A-Z]{2}$/)
							.describe("ISO 3166-1 alpha-2, e.g. US."),
						region: shortText(80).optional(),
						city: shortText(80).optional(),
					})
					.strict(),
				size_band: z.enum(SIZE_BANDS),
				documents_available: z
					.array(z.enum(DOCUMENT_IDS))
					.max(DOCUMENT_IDS.length)
					.describe("Names of documents that exist. No content is sent."),
				principal: z
					.object({
						full_name: shortText(120),
						email: z
							.string()
							.trim()
							.toLowerCase()
							.email()
							.max(254)
							.describe("Must be the email of the account that holds the agent key."),
						organization: shortText(160),
						role: shortText(80),
						authority_attested: z
							.literal(true)
							.describe("The principal confirms authority over the asset."),
					})
					.strict(),
			}).strict(),
			outputSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		async (args) => {
			if (new Set(args.documents_available).size !== args.documents_available.length) {
				return envelope(`${config.apiBaseUrl}${SUBMISSIONS_PATH}`, null, {
					code: "UPSTREAM_ERROR",
					message: "documents_available has a duplicate id. Nothing was sent.",
					retryable: false,
				});
			}
			return keyed("POST", SUBMISSIONS_PATH, args);
		}
	);

	server.registerTool(
		"get_submission_status",
		{
			title: "Read the screening state of a submission you made",
			description:
				"Read the machine-readable screening state of an asset submission made with the same agent key: gate0 (pending, pass, needs_info, declined), atlas (not_started, in_progress, complete) and the documents screening asked for. A submission made with another key reads as not found.",
			inputSchema: {
				submission_id: z.string().regex(UUID_RX, "a submission id from submit_asset"),
			},
			outputSchema,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		async (args) => keyed("GET", `${SUBMISSIONS_PATH}/${args.submission_id}`)
	);
};
