/**
 * Tool registration.
 *
 * Read-only, public data only, no credentials anywhere in this file. Every
 * handler funnels through `respond()` so the envelope (as_of, source URL,
 * cache metadata, disclaimer) is impossible to forget, and every upstream
 * failure becomes a typed error response rather than an exception.
 */

import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { config } from "./config.js";
import { DISCLAIMER } from "./disclaimer.js";
import { ApiError, getJson, postJson, type ApiResult } from "./http.js";
import {
	normalizeArticleFull,
	normalizeArticleSummary,
	normalizeOffering,
	num,
	type RawArticle,
	type RawListing,
} from "./normalize.js";
import {
	articleFullSchema,
	articleSummarySchema,
	envelopeShape,
	offeringSchema,
} from "./schemas.js";
import {
	SANDBOX_TOOL_NAMES,
	SANDBOX_WRITE_TOOL_NAMES,
} from "./sandboxTools.js";
import { SCREENER_TOOL_NAMES } from "./screenerTools.js";
import { X402_TOOL_NAMES } from "./x402Tools.js";
import { HTTP_TOOL_ALLOWLIST } from "./httpAllowlist.js";
import { INQUIRY_TOOL_NAME } from "./inquiryTool.js";
import {
	FIREWALL_NOTE,
	FIREWALL_SOURCE_PATH,
	FIREWALL_UNAVAILABLE_MESSAGE,
	publishableOfferingIds,
} from "./offeringFirewall.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/**
 * content/ sits next to dist/ and src/, so one level up from either — unless
 * the deployment moved the built file, in which case the operator says where.
 */
const CONTENT_DIR =
	config.contentDir || path.resolve(HERE, "..", "content");

/**
 * Which transport the server is being built for. Over HTTP only the names in
 * `HTTP_TOOL_ALLOWLIST` are registered (see `httpAllowlist.ts`), and
 * `platform_info` must describe THAT surface — a manifest that names a tool
 * the transport refuses is the same lie as one naming an unregistered tool.
 */
export type ToolSurface = "stdio" | "http";

/* ------------------------------------------------------------------ */
/* response helpers                                                    */
/* ------------------------------------------------------------------ */

const toResult = (structured: Record<string, unknown>, isError = false): CallToolResult => ({
	content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
	structuredContent: structured,
	...(isError ? { isError: true } : {}),
});

/** Success envelope built from the upstream fetch metadata. */
const ok = <T extends Record<string, unknown>>(
	meta: Pick<ApiResult<unknown>, "fetchedAt" | "cache" | "sourceUrl">,
	payload: T
): CallToolResult =>
	toResult({
		...payload,
		as_of: meta.fetchedAt.toISOString(),
		source_url: meta.sourceUrl,
		cache: meta.cache,
		disclaimer: DISCLAIMER,
		error: null,
	});

/**
 * Failure envelope. Payload keys are still present (as empty/null) so the
 * declared output schema holds for errors too, and a client that only reads
 * `error` never has to special-case the shape.
 */
const fail = (
	err: unknown,
	sourceUrl: string,
	emptyPayload: Record<string, unknown>
): CallToolResult => {
	const api = err instanceof ApiError ? err : null;
	return toResult(
		{
			...emptyPayload,
			as_of: new Date().toISOString(),
			source_url: api?.sourceUrl ?? sourceUrl,
			cache: { hit: false, age_seconds: 0, stale: false },
			disclaimer: DISCLAIMER,
			error: {
				code: api?.code ?? "INTERNAL_ERROR",
				message: api
					? api.message
					: `Unexpected failure: ${err instanceof Error ? err.message : String(err)}`,
				retryable: api?.retryable ?? false,
			},
		},
		true
	);
};

const OFFERINGS_DISABLED_MESSAGE =
	"The offerings tools are disabled on this server instance. They are off by default and require an explicit COMMERTIZE_MCP_ENABLE_OFFERINGS=1 (and no COMMERTIZE_MCP_DISABLE_OFFERINGS=1 override). No listing data will be returned.";

const disabled = (emptyPayload: Record<string, unknown>): CallToolResult =>
	toResult(
		{
			...emptyPayload,
			as_of: new Date().toISOString(),
			source_url: `${config.apiBaseUrl}/api/listings`,
			cache: { hit: false, age_seconds: 0, stale: false },
			disclaimer: DISCLAIMER,
			error: {
				code: "TOOL_DISABLED",
				message: OFFERINGS_DISABLED_MESSAGE,
				retryable: false,
			},
		},
		true
	);

/**
 * The offering firewall could not be consulted. Refuse — do not serve the
 * ungated marketplace feed because the gate was unavailable (legal review §4.2 C5).
 */
const firewallUnavailable = (
	emptyPayload: Record<string, unknown>
): CallToolResult =>
	toResult(
		{
			...emptyPayload,
			as_of: new Date().toISOString(),
			source_url: `${config.apiBaseUrl}${FIREWALL_SOURCE_PATH}`,
			cache: { hit: false, age_seconds: 0, stale: false },
			disclaimer: DISCLAIMER,
			error: {
				code: "FIREWALL_UNAVAILABLE",
				message: FIREWALL_UNAVAILABLE_MESSAGE,
				retryable: true,
			},
		},
		true
	);

/* ------------------------------------------------------------------ */
/* registration                                                        */
/* ------------------------------------------------------------------ */

export const registerTools = (
	server: McpServer,
	surface: ToolSurface = "stdio"
): void => {
	/* ---------------------------------------------------------- */
	/* list_offerings                                              */
	/* ---------------------------------------------------------- */
	server.registerTool(
		"list_offerings",
		{
			title: "List Commertize marketplace offerings",
			description:
				"List the real-world-asset offerings currently on the Commertize marketplace, with public terms: asset class, location, status, exemption, sponsor, tokenomics, and derived offering size. Public data only; no authentication. Filters are applied to the public set, they do not widen it. Informational reference data — not an offer, solicitation, or recommendation.",
			inputSchema: {
				status: z
					.enum(["ACTIVE", "FULLY_FUNDED", "TOKENIZING"])
					.optional()
					.describe(
						"Filter by listing status. The public set only ever contains these three."
					),
				asset_class: z
					.string()
					.optional()
					.describe(
						'Filter by asset class code, e.g. "MULTIFAMILY", "HOSPITALITY", "OFFICE". Case-insensitive.'
					),
				state: z
					.string()
					.optional()
					.describe('Filter by US state code, e.g. "WA". Case-insensitive.'),
				limit: z
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.describe("Maximum number of offerings to return. Default: all."),
			},
			outputSchema: {
				...envelopeShape,
				offerings: z.array(offeringSchema),
				count: z.number().describe("Number of offerings returned after filtering."),
				total_available: z
					.number()
					.describe(
						"Number of offerings in the set this server may publish, before the caller's own filters. NOT the size of the marketplace — offerings outside the Rule 506(c) set are withheld and are not counted here."
					),
				firewall: z
					.object({
						note: z.string(),
						source_url: z.string(),
						withheld: z
							.number()
							.nullable()
							.describe(
								"How many publicly viewable rows the backend withheld from machine readers. Always stated: a backend that does not state it is not treated as the authority."
							),
						as_of: z.string(),
					})
					.describe(
						"Which offerings this server may publish is decided by the Commertize backend, not here. This states the authority, when it was read, and how much it withheld."
					),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async (args) => {
			const empty = { offerings: [], count: 0, total_available: 0 };
			if (config.offeringsDisabled) return disabled(empty);
			/**
			 * THE FIREWALL RUNS BEFORE THE FETCH, AND ITS FAILURE REFUSES.
			 *
			 * `/api/listings` is the marketplace feed: every publicly viewable row
			 * whatever its exemption, and since `toPublicListing` it does not even
			 * carry `offeringType`, so there is nothing in it to filter on. The
			 * authority is the gated instrument book. Unreachable authority means
			 * no offerings, not all offerings.
			 */
			const gate = await publishableOfferingIds();
			if (!gate) return firewallUnavailable(empty);
			const url = `${config.apiBaseUrl}/api/listings`;
			try {
				const res = await getJson<RawListing[]>("/api/listings");
				const raw = Array.isArray(res.body) ? res.body : [];
				let offerings = raw
					.filter((l) => typeof l?.id === "string" && gate.ids.has(l.id))
					.map(normalizeOffering);
				// The size of the set an agent MAY see, not the size of the
				// marketplace. Reporting the marketplace total here would announce
				// the existence of the rows the gate just withheld.
				const total = offerings.length;

				if (args.status) {
					offerings = offerings.filter((o) => o.status.code === args.status);
				}
				if (args.asset_class) {
					const want = args.asset_class.toUpperCase();
					offerings = offerings.filter(
						(o) => (o.asset_class.code ?? "").toUpperCase() === want
					);
				}
				if (args.state) {
					const want = args.state.toUpperCase();
					offerings = offerings.filter(
						(o) => (o.location.state ?? "").toUpperCase() === want
					);
				}
				if (args.limit !== undefined) offerings = offerings.slice(0, args.limit);

				return ok(res, {
					offerings,
					count: offerings.length,
					total_available: total,
					firewall: {
						note: FIREWALL_NOTE,
						source_url: `${config.apiBaseUrl}${FIREWALL_SOURCE_PATH}`,
						withheld: gate.withheld,
						as_of: gate.fetchedAt.toISOString(),
					},
				});
			} catch (err) {
				return fail(err, url, empty);
			}
		}
	);

	/* ---------------------------------------------------------- */
	/* get_offering                                                */
	/* ---------------------------------------------------------- */
	server.registerTool(
		"get_offering",
		{
			title: "Get one Commertize offering",
			description:
				"Full PUBLIC detail for a single offering by id, including tokenomics and the SPV leverage disclosure where the sponsor has provided one. The complete listing record (documents, sponsor diligence, street address, funding progress) is authenticated and is NOT available through this server. Informational reference data — not an offer, solicitation, or recommendation.",
			inputSchema: {
				offering_id: z
					.string()
					.min(1)
					.describe("Offering UUID, as returned by list_offerings."),
			},
			outputSchema: {
				...envelopeShape,
				offering: offeringSchema.nullable(),
				public_fields_only: z
					.boolean()
					.describe(
						"Always true. Assembled from the public listing endpoint; authenticated detail fields are absent, not null-because-undisclosed."
					),
				firewall: z
					.object({
						note: z.string(),
						source_url: z.string(),
						withheld: z
							.number()
							.nullable()
							.describe(
								"How many publicly viewable rows the backend withheld from machine readers. Always stated: a backend that does not state it is not treated as the authority."
							),
						as_of: z.string(),
					})
					.describe(
						"Which offerings this server may publish is decided by the Commertize backend, not here. This states the authority, when it was read, and how much it withheld."
					),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ offering_id }) => {
			const empty = { offering: null, public_fields_only: true };
			if (config.offeringsDisabled) return disabled(empty);
			const gate = await publishableOfferingIds();
			if (!gate) return firewallUnavailable(empty);
			const url = `${config.apiBaseUrl}/api/listings`;
			try {
				const res = await getJson<RawListing[]>("/api/listings");
				const raw = Array.isArray(res.body) ? res.body : [];
				// Withheld and absent are answered with the SAME result, on purpose.
				// "That offering exists but you may not read it" confirms a private
				// placement to whoever guessed the id, which is the disclosure the
				// gate is there to prevent.
				const match = gate.ids.has(offering_id)
					? raw.find((l) => l.id === offering_id)
					: undefined;
				if (!match) {
					return toResult(
						{
							...empty,
							as_of: res.fetchedAt.toISOString(),
							source_url: res.sourceUrl,
							cache: res.cache,
							disclaimer: DISCLAIMER,
							error: {
								code: "NOT_FOUND",
								message: `No offering with id "${offering_id}" is published to machine readers. It may not exist, it may not be in a publicly viewable status, or it may be outside the set this server may publish. Call list_offerings for the current set.`,
								retryable: false,
							},
						},
						true
					);
				}
				return ok(res, {
					offering: normalizeOffering(match),
					public_fields_only: true,
					firewall: {
						note: FIREWALL_NOTE,
						source_url: `${config.apiBaseUrl}${FIREWALL_SOURCE_PATH}`,
						withheld: gate.withheld,
						as_of: gate.fetchedAt.toISOString(),
					},
				});
			} catch (err) {
				return fail(err, url, empty);
			}
		}
	);

	/* ---------------------------------------------------------- */
	/* get_news                                                    */
	/* ---------------------------------------------------------- */
	server.registerTool(
		"get_news",
		{
			title: "Get Commertize news and market commentary",
			description:
				"Published news and market commentary from Commertize: tokenization, real-world assets, digital capital markets infrastructure, and regulation. Returns headlines and summaries; use get_article for a full body. Commertize's own editorial view, not independent research.",
			inputSchema: {
				limit: z
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.describe("Maximum number of articles. Default 20, upstream max 100."),
				category: z
					.string()
					.optional()
					.describe(
						'Filter by category label, case-insensitive substring match, e.g. "Tokenization", "Regulation".'
					),
				query: z
					.string()
					.optional()
					.describe(
						"Case-insensitive substring filter over title and summary. Applied locally to the fetched set, not a search index."
					),
			},
			outputSchema: {
				...envelopeShape,
				articles: z.array(articleSummarySchema),
				count: z.number(),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async (args) => {
			const empty = { articles: [], count: 0 };
			const limit = args.limit ?? 20;
			const pathname = `/api/news?limit=${limit}`;
			try {
				const res = await getJson<{ data?: RawArticle[] }>(pathname);
				const raw = Array.isArray(res.body?.data) ? res.body.data : [];
				let articles = raw.map(normalizeArticleSummary);

				if (args.category) {
					const want = args.category.toLowerCase();
					articles = articles.filter((a) =>
						(a.category ?? "").toLowerCase().includes(want)
					);
				}
				if (args.query) {
					const want = args.query.toLowerCase();
					articles = articles.filter((a) =>
						`${a.title ?? ""} ${a.summary ?? ""}`.toLowerCase().includes(want)
					);
				}

				return ok(res, { articles, count: articles.length });
			} catch (err) {
				return fail(err, `${config.apiBaseUrl}${pathname}`, empty);
			}
		}
	);

	/* ---------------------------------------------------------- */
	/* get_article                                                 */
	/* ---------------------------------------------------------- */
	server.registerTool(
		"get_article",
		{
			title: "Get one Commertize article",
			description:
				"Full published text of a single Commertize news or commentary article, by slug (from get_news). Markup and embedded metadata are stripped.",
			inputSchema: {
				slug: z
					.string()
					.min(1)
					.describe('Article slug, e.g. "ai-in-cre-asset-management-from-rent-rolls-to-returns".'),
			},
			outputSchema: {
				...envelopeShape,
				article: articleFullSchema.nullable(),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ slug }) => {
			const empty = { article: null };
			const pathname = `/api/news/${encodeURIComponent(slug)}`;
			try {
				const res = await getJson<{ data?: RawArticle }>(pathname);
				const raw = res.body?.data;
				if (!raw) {
					return fail(
						new ApiError({
							code: "UPSTREAM_BAD_BODY",
							message: `The API returned no article body for slug "${slug}".`,
							retryable: false,
							sourceUrl: `${config.apiBaseUrl}${pathname}`,
						}),
						`${config.apiBaseUrl}${pathname}`,
						empty
					);
				}
				return ok(res, { article: normalizeArticleFull(raw) });
			} catch (err) {
				// A 404 from the API is "no such published article", not a fault.
				if (err instanceof ApiError && err.status === 404) {
					return toResult(
						{
							...empty,
							as_of: new Date().toISOString(),
							source_url: err.sourceUrl,
							cache: { hit: false, age_seconds: 0, stale: false },
							disclaimer: DISCLAIMER,
							error: {
								code: "NOT_FOUND",
								message: `No published article with slug "${slug}".`,
								retryable: false,
							},
						},
						true
					);
				}
				return fail(err, `${config.apiBaseUrl}${pathname}`, empty);
			}
		}
	);

	/*
	 * get_platform_stats is REMOVED (2026-09-26).
	 * GET /api/stats/platform now requires a signed-in session, and its counts
	 * must not reach an anonymous agent through this door either. Do not
	 * re-add it without a new ruling.
	 */

	/* ---------------------------------------------------------- */
	/* platform_info                                               */
	/* ---------------------------------------------------------- */
	server.registerTool(
		"platform_info",
		{
			title: "About Commertize",
			description:
				"Curated reference text an agent should read before using the other tools: what Commertize is, what it lists, how offerings are structured, how investor and sponsor verification works, and exactly what agents can and cannot do through public interfaces. Static text, not live data.",
			inputSchema: {},
			outputSchema: {
				...envelopeShape,
				markdown: z.string().nullable(),
				capabilities: z
					.object({
						read_only: z.boolean(),
						requires_authentication: z.boolean(),
						can_transact: z.boolean(),
						write_tools: z.array(z.string()),
						tools: z.array(z.string()),
					})
					.describe("Machine-readable summary of this server's surface."),
			},
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async () => {
			/*
			 * One list, built once, read three times — `write_tools`, `tools` and
			 * the derived `read_only`. Every entry that can be absent is spread on
			 * the SAME predicate the registration in `index.ts` uses, so this
			 * document and `tools/list` cannot disagree; a live test asserts them
			 * equal.
			 */
			/*
			 * Over HTTP the transport registers only the allowlisted names and
			 * refuses every other `tools/call` with 403, so the manifest filters
			 * on the SAME set. `onSurface` is applied to every spread below; a
			 * name that is not allowlisted never reaches either list.
			 */
			const onSurface = (names: readonly string[]): string[] =>
				surface === "http"
					? names.filter((n) => HTTP_TOOL_ALLOWLIST.has(n))
					: [...names];
			const writeTools = onSurface([
				// `request_memo` reaches a person, but its upstream route is not
				// mounted in production (probed 2026-09-10) — so it is registered,
				// and advertised, only when its gate is open.
				...(config.memoDisabled ? [] : ["request_memo"]),
				// The sponsor inquiry: a write to `POST /contact`, gated on the
				// attribution contract being deployed (see config.ts).
				...(config.inquiryDisabled ? [] : [INQUIRY_TOOL_NAME]),
				// Gated writes: absent from this list exactly when they are absent
				// from `tools/list`, because both read the same predicate. A
				// hand-maintained list would say "these exist" on a server where
				// they do not.
				...(config.sandboxDisabled ? [] : SANDBOX_WRITE_TOOL_NAMES),
				// `x402_fetch` writes nothing to a Commertize account, but calling
				// it spends the caller's own money on-chain — which is the fact a
				// client deciding whether to ask first actually needs.
				...(config.x402Disabled ? [] : ["x402_fetch"]),
			]);
			const capabilities = {
				// Derived, never asserted: with every write gate closed this server
				// really is read-only, and the hard-coded `false` that used to sit
				// here would have gone on claiming a write surface `tools/list` no
				// longer carries.
				read_only: writeTools.length === 0,
				// The reads need none; `request_memo` needs COMMERTIZE_AGENT_KEY.
				requires_authentication: false,
				can_transact: false,
				write_tools: writeTools,
				tools: onSurface([
					"list_offerings",
					"get_offering",
					// Upstream route not mounted in production; see the gate block
					// below `registerTools` for the probe that established it.
					...(config.disclosureDisabled ? [] : ["get_disclosure_package"]),
					"get_news",
					"get_article",
					"platform_info",
					...(config.memoDisabled ? [] : ["request_memo"]),
					...(config.inquiryDisabled ? [] : [INQUIRY_TOOL_NAME]),
					// Spread, not retyped: `platform_info` is the surface an agent
					// reads before deciding what this server can do, and a live test
					// asserts this list against `tools/list`. A second hand-written
					// copy of the screener tool names is how it would come to
					// under-report them.
					...SCREENER_TOOL_NAMES,
					// Same reasoning, plus a gate: these are registered only when the
					// opt-in is set, so the condition here is the same expression
					// `registerSandboxTools` returns on. One predicate, two readers.
					...(config.sandboxDisabled ? [] : SANDBOX_TOOL_NAMES),
					...(config.x402Disabled ? [] : X402_TOOL_NAMES),
				]),
			};
			const file = path.join(CONTENT_DIR, "platform-info.md");
			try {
				const markdown = await readFile(file, "utf8");
				return toResult({
					markdown,
					capabilities,
					as_of: new Date().toISOString(),
					source_url: `${config.siteUrl}/about`,
					cache: { hit: false, age_seconds: 0, stale: false },
					disclaimer: DISCLAIMER,
					error: null,
				});
			} catch (err) {
				return fail(err, `${config.siteUrl}/about`, {
					markdown: null,
					capabilities,
				});
			}
		}
	);
};


/* ============================================================== */
/* GATED TOOLS                                                     */
/* ============================================================== */
/**
 * The two tools below are registered SEPARATELY, and only when their upstream
 * route is actually mounted on the API they are pointed at.
 *
 * `index.ts` already states the rule for the sandbox and x402 groups —
 * "registering tools that can only 404 would teach a machine reader that the
 * venue is broken rather than absent" — and until 2026-09-10 these two were
 * the exception to it. Probed against production that day:
 *
 *   POST /api/agents/memo-request                -> 404 `404 Not Found` (text)
 *   GET  /api/offerings/v1/{id}/disclosure       -> 404 `404 Not Found` (text)
 *   GET  /api/news/{unknown-slug}                -> 404 {"error":"Article not found"}
 *   POST /api/contact  {}                        -> 400 (mounted, bad body)
 *
 * The plain-text body is Hono's unmounted-route 404; a mounted route with a
 * missing resource answers with a JSON body. Both routers exist only on
 * backend versions not deployed, so nothing under `/api/agents` and nothing
 * under `/api/offerings` is served by production.
 *
 * A client installed from a registry runs this server with NO environment at
 * all, so the DEFAULT manifest must describe only what production answers.
 * When the backend router lands, the flag is flipped — the tool code below is
 * unchanged and already tested.
 */

export const registerDisclosureTool = (server: McpServer): void => {
	if (config.disclosureDisabled) return;

/* ---------------------------------------------------------- */
/* get_disclosure_package                                      */
/* ---------------------------------------------------------- */
server.registerTool(
	"get_disclosure_package",
	{
		title: "Get one offering's signed, machine-readable disclosure package",
		description:
			"The structured disclosure package for one publishable offering: terms, waterfall, covenants, risk factors, attestations, the ratified minimum investment, and the transfer-restriction profile with its reason-code table. Every field carries a provenance (sponsor_reported, platform_derived, platform_policy, third_party_attested, not_disclosed) and an as-of. The package is signed by Commertize's server key (Ed25519 over canonical JSON); the signature, the key id and the verification endpoints are relayed so you can check it yourself, and a PDF rendered from the same signed data is linked. An asset under evaluation is never served here. Informational reference data — not an offer, solicitation, or recommendation.",
		inputSchema: {
			offering_id: z
				.string()
				.min(1)
				.describe("Offering UUID, as returned by list_offerings."),
		},
		outputSchema: {
			...envelopeShape,
			package: z
				.record(z.string(), z.unknown())
				.nullable()
				.describe("The signed payload, relayed byte-for-byte in content. Null when refused."),
			signature: z
				.object({
					alg: z.string(),
					key_id: z.string(),
					canonicalization: z.string(),
					sha256: z.string(),
					value: z.string(),
				})
				.nullable(),
			verify: z
				.object({ keys_url: z.string(), verify_url: z.string() })
				.nullable(),
			pdf_url: z.string().nullable(),
		},
		annotations: { readOnlyHint: true, openWorldHint: true },
	},
	async ({ offering_id }) => {
		const empty = { package: null, signature: null, verify: null, pdf_url: null };
		if (config.offeringsDisabled) return disabled(empty);
		const path = `/api/offerings/v1/${encodeURIComponent(offering_id)}/disclosure`;
		const url = `${config.apiBaseUrl}${path}`;
		try {
			const res = await getJson<{
				package?: Record<string, unknown>;
				signature?: {
					alg?: string;
					keyId?: string;
					canonicalization?: string;
					sha256?: string;
					value?: string;
				};
				verify?: { keysUrl?: string; verifyUrl?: string };
				pdfUrl?: string;
			}>(path);
			const b = res.body ?? {};
			if (!b.package || !b.signature) {
				return toResult(
					{
						...empty,
						as_of: res.fetchedAt.toISOString(),
						source_url: res.sourceUrl,
						cache: res.cache,
						disclaimer: DISCLAIMER,
						error: {
							code: "NOT_FOUND",
							message: `No disclosure package for "${offering_id}". The offering may not exist, may not be publishable, or the endpoint may be switched off on this API.`,
							retryable: false,
						},
					},
					true
				);
			}
			return ok(res, {
				package: b.package,
				signature: {
					alg: String(b.signature.alg ?? ""),
					key_id: String(b.signature.keyId ?? ""),
					canonicalization: String(b.signature.canonicalization ?? ""),
					sha256: String(b.signature.sha256 ?? ""),
					value: String(b.signature.value ?? ""),
				},
				verify: {
					keys_url: String(b.verify?.keysUrl ?? ""),
					verify_url: String(b.verify?.verifyUrl ?? ""),
				},
				pdf_url: b.pdfUrl ? String(b.pdfUrl) : null,
			});
		} catch (err) {
			if (err instanceof ApiError && err.status === 404) {
				// The API's 404 is one answer for every refusal — unknown id,
				// asset under evaluation, exemption not publishable, endpoint
				// switched off — and it is relayed as the same typed NOT_FOUND
				// here, not as an upstream fault a client might retry.
				return toResult(
					{
						...empty,
						as_of: new Date().toISOString(),
						source_url: url,
						cache: { hit: false, age_seconds: 0, stale: false },
						disclaimer: DISCLAIMER,
						error: {
							code: "NOT_FOUND",
							message: `No disclosure package for "${offering_id}". The offering may not exist, may not be publishable, or the endpoint may be switched off on this API.`,
							retryable: false,
						},
					},
					true
				);
			}
			return fail(err, url, empty);
		}
	}
);
};

export const registerMemoTool = (server: McpServer): void => {
	if (config.memoDisabled) return;

/* ---------------------------------------------------------- */
/* request_memo                                                */
/* ---------------------------------------------------------- */
/**
 * The one WRITE in this server.
 *
 * It files a request for a free written feasibility read on an asset the
 * caller's principal OWNS. That direction matters: it is a services inquiry
 * from an asset owner, not a request about anything Commertize lists, and it
 * returns no offering, no listing and no security. The upstream endpoint
 * enforces the same containment on its side.
 *
 * Fail-closed twice over: no credential and it refuses; a 4xx from upstream
 * is reported as non-retryable so a client does not file the same request
 * again with the same bad arguments.
 */
server.registerTool(
	"request_memo",
	{
		title: "Request a feasibility memo on an asset your principal owns",
		description:
			"File a request for a free written feasibility read: how an asset your principal controls would structure for tokenization, and — explicitly — the parts that do not work. Written by a person and returned to THE EMAIL ADDRESS YOUR CREDENTIAL WAS REGISTERED TO — you cannot direct it anywhere else. There is no committed turnaround time. This is a services inquiry about YOUR OWN asset. It is not a request about anything listed on Commertize, it returns no listing and no security, and nothing about it is an offer, a solicitation or a recommendation. Requires an agent credential (COMMERTIZE_AGENT_KEY).",
		inputSchema: {
			asset_class: z
				.enum([
					"commercial_real_estate",
					"industrial",
					"energy",
					"digital_infrastructure",
					"precious_metals",
					"carbon",
					"agriculture",
					"other",
				])
				.describe("What kind of asset your principal controls."),
			size_band: z
				.enum([
					"under_10m",
					"10m_to_50m",
					"50m_to_100m",
					"100m_to_500m",
					"over_500m",
				])
				.describe(
					"Approximate size band. A band, not an amount: nothing here is treated as an established figure."
				),
			doc_link: z
				.string()
				.describe(
					"HTTPS link to a data room or document set. Nothing is uploaded through this tool."
				),
			/**
			 * NO `principal_email`.
			 *
			 * Removed 2026-09-02 (security review delta, MEDIUM). It used to be free text,
			 * which let a caller put a third party's address into Commertize's
			 * database and cause Commertize to mail that third party about an
			 * asset they never mentioned. The destination is now the address the
			 * credential PROVED at registration, and the upstream refuses any
			 * other value — so offering the parameter here would only be a way
			 * for a client to earn a 400.
			 *
			 * The consequence, stated because it is a real constraint: to have
			 * the memo reach a particular person, register the credential on
			 * that person's address.
			 */
		},
		outputSchema: {
			...envelopeShape,
			request: z
				.object({
					request_id: z.string(),
					status: z.string(),
					received_at: z.string(),
					due_by: z.string(),
					sla_hours: z.number().nullable(),
					sla_basis: z.string().describe("Basis of any turnaround figure, relayed from the API; \"none\" when the API states none. This server commits to no turnaround."),
					memo_goes_to: z.string(),
					next: z.string(),
					not_verified: z.string(),
				})
				.nullable(),
		},
		// A write, and one that reaches a person. Say so in the metadata a
		// client uses to decide whether to ask first.
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
	},
	async (args) => {
		const empty = { request: null };
		const pathname = "/api/agents/memo-request";
		const sourceUrl = `${config.apiBaseUrl}${pathname}`;

		if (!config.agentKey) {
			return toResult(
				{
					...empty,
					as_of: new Date().toISOString(),
					source_url: sourceUrl,
					cache: { hit: false, age_seconds: 0, stale: false },
					disclaimer: DISCLAIMER,
					error: {
						code: "NO_CREDENTIAL",
						message:
							"request_memo needs an agent credential. Register at POST /api/agents/register on the Commertize API and set COMMERTIZE_AGENT_KEY. Nothing was filed.",
						retryable: false,
					},
				},
				true
			);
		}

		try {
			const res = await postJson<Record<string, unknown>>(
				pathname,
				{
					assetClass: args.asset_class,
					sizeBand: args.size_band,
					docLink: args.doc_link,
					// principalEmail deliberately not sent: the upstream resolves it
					// from the credential. See the input schema.
				},
				config.agentKey
			);
			const b = res.body ?? {};
			return toResult({
				request: {
					request_id: String(b.requestId ?? ""),
					status: String(b.status ?? ""),
					received_at: String(b.receivedAt ?? ""),
					due_by: String(b.dueBy ?? ""),
					// Relayed from the API, never defaulted here: this server
					// makes no turnaround commitment of its own.
					sla_hours: num(b.slaHours) ?? null,
					sla_basis: String(b.slaBasis ?? "none"),
					memo_goes_to: String(b.memoGoesTo ?? ""),
					next: String(b.whatHappensNext ?? ""),
					not_verified: String(b.gate0 ?? ""),
				},
				as_of: res.sentAt.toISOString(),
				source_url: res.sourceUrl,
				cache: { hit: false, age_seconds: 0, stale: false },
				// The upstream sends its own disclaimer INSIDE the payload;
				// both travel, because a relayed payload keeps whatever is in
				// it and drops whatever is not.
				disclaimer: `${DISCLAIMER} ${String(b.disclaimer ?? "")}`.trim(),
				error: null,
			});
		} catch (err) {
			return fail(err, sourceUrl, empty);
		}
	}
);
};
