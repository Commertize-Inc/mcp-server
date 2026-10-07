/**
 * `file_sponsor_inquiry` — the sponsor-inquiry write.
 *
 * Posts to `POST /contact` (type `desk`, persona `Sponsor`) with the `agent`
 * attribution object the API's discovery files document: `{ name, url?,
 * operator? }`. No credential: the route is public and rate-limited by the
 * API per client IP (5 per hour, shared with the website's form). Over the
 * HTTP transport this server adds its own per-key ceiling on top.
 *
 * What the tool claims is exactly what the API returns: an id and the time
 * the request was accepted. It does not promise a reply, a timeline or an
 * outcome, because the route does not.
 *
 * Gated at registration (`config.inquiryDisabled`, default OFF): see the
 * config docblock for why — the attribution contract must be deployed before
 * a tool may say the attribution is recorded.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { config } from "./config.js";
import { fail, ok, refuse } from "./envelope.js";
import { postPublicJson } from "./http.js";
import { envelopeShape } from "./schemas.js";

export const INQUIRY_TOOL_NAME = "file_sponsor_inquiry";
export const INQUIRY_PATH = "/contact";

/** `https://` only, no credentials in the authority, bounded like the API. */
const HTTPS_URL_RX = /^https:\/\/[^\s@/]+(?:\/[^\s]*)?$/;

const EMPTY = { inquiry: null } as const;

export const registerInquiryTool = (server: McpServer): void => {
	if (config.inquiryDisabled) return;

	server.registerTool(
		INQUIRY_TOOL_NAME,
		{
			title: "File a sponsor inquiry on behalf of a principal who controls an asset",
			description:
				"File a sponsor inquiry with Commertize on behalf of a principal who controls an asset and wants to discuss tokenizing it. The inquiry is recorded with the principal's contact details and with attribution to the calling agent (agent_name, optional agent_url and operator). It returns the inquiry id and the time the API accepted it — nothing else is promised. This is a services inquiry about the principal's OWN asset: it names no listing, returns no security, and nothing about it is an offer, a solicitation or a recommendation. Rate-limited by the API at 5 requests per hour per client IP and, over HTTP, per key by this server. Do not retry a 400; a 429 may be retried after the stated interval.",
			inputSchema: {
				principal_name: z
					.string()
					.trim()
					.min(2)
					.max(120)
					.describe("The principal's full name (a person or an authorised signatory)."),
				principal_email: z
					.string()
					.trim()
					.email()
					.max(254)
					.describe("The principal's email address. Commertize replies here."),
				principal_phone: z
					.string()
					.trim()
					.min(5)
					.max(40)
					.describe("The principal's phone number. Required for sponsor inquiries."),
				organization: z
					.string()
					.trim()
					.max(200)
					.optional()
					.describe("The entity that controls the asset, if any."),
				asset_type: z
					.string()
					.trim()
					.max(120)
					.optional()
					.describe('What the asset is, in the principal\'s words, e.g. "data center", "multifamily", "gold in vault".'),
				message: z
					.string()
					.trim()
					.min(10)
					.max(5000)
					.describe("What the principal wants to discuss. 10 to 5000 characters."),
				agent_name: z
					.string()
					.trim()
					.min(1)
					.max(80)
					.describe("The calling agent's name, for attribution. 1 to 80 characters."),
				agent_url: z
					.string()
					.trim()
					.max(200)
					.regex(HTTPS_URL_RX, "agent_url must be an https URL with no credentials")
					.optional()
					.describe("An https URL identifying the agent or its operator. Optional."),
				operator: z
					.string()
					.trim()
					.max(120)
					.optional()
					.describe("Who runs the agent. Optional."),
			},
			outputSchema: {
				...envelopeShape,
				inquiry: z
					.object({
						id: z.string().describe("The id the API assigned to the inquiry."),
						accepted_at: z
							.string()
							.describe("ISO-8601 time this server received the API's acceptance."),
						persona: z.literal("Sponsor"),
					})
					.nullable()
					.describe("Null when nothing was filed; read `error`."),
			},
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		async (args) => {
			const url = `${config.apiBaseUrl}${INQUIRY_PATH}`;
			const agent: Record<string, string> = { name: args.agent_name };
			if (args.agent_url) agent.url = args.agent_url;
			if (args.operator) agent.operator = args.operator;

			const body = {
				type: "desk",
				persona: "Sponsor",
				fullName: args.principal_name,
				email: args.principal_email,
				phone: args.principal_phone,
				...(args.organization ? { organization: args.organization } : {}),
				...(args.asset_type ? { assetType: args.asset_type } : {}),
				message: args.message,
				agent,
			};

			try {
				const res = await postPublicJson<{ success?: unknown; id?: unknown }>(
					INQUIRY_PATH,
					body
				);
				const id = res.body?.id;
				if (typeof id !== "string" && typeof id !== "number") {
					// A 2xx without an id is not an acceptance this tool can report.
					return refuse(
						"UPSTREAM_BAD_BODY",
						"The API accepted the request but returned no inquiry id, so this server cannot confirm what was filed.",
						url,
						EMPTY
					);
				}
				return ok(
					{
						fetchedAt: res.sentAt,
						cache: { hit: false, age_seconds: 0, stale: false },
						sourceUrl: res.sourceUrl,
					},
					{
						inquiry: {
							id: String(id),
							accepted_at: res.sentAt.toISOString(),
							persona: "Sponsor" as const,
						},
					}
				);
			} catch (err) {
				return fail(err, url, EMPTY);
			}
		}
	);
};
