/**
 * Simulation-venue tools: the paper sandbox, as five tools an agent can drive.
 *
 *   sandbox_enroll               take the capability and open a notional ledger
 *   sandbox_universe             the invented instrument list
 *   sandbox_record_commitment    record one simulated primary commitment
 *   sandbox_withdraw_commitment  withdraw one, before the simulated close only
 *   sandbox_account              this credential's own balance and commitments
 *
 * ── COMMITMENTS, NOT ORDERS (legal ruling 2026-10-28, item 5) ─────────────
 *
 * The write used to be `sandbox_place_order` with a `side: buy|sell` input.
 * A buy/sell tool is an order-entry front end in name and shape even when
 * nothing is real, and the name travels into catalogues and transcripts. So
 * the venue simulates a PRIMARY COMMITMENT only: there is no side, no sell in
 * any form (a sell is secondary trading), and a reversal is a separate
 * withdrawal that the venue declines once its simulated close has passed.
 * The old name stays callable for one release and returns `TOOL_RENAMED`
 * naming the new tool; it records nothing and is not in `platform_info`.
 * `test/sandbox-e2e.mjs` bars the order vocabulary from every sandbox
 * title, description and schema.
 *
 * ── NOT REGISTERED WHEN THE GATE IS CLOSED ────────────────────────────────
 *
 * `registerSandboxTools` returns without registering anything unless
 * `COMMERTIZE_MCP_ENABLE_SANDBOX=1`. That is different from the offerings gate,
 * which registers tools that then refuse, and the difference is deliberate: the
 * backend does not 403 an unmounted sandbox, it 404s it, so a registered tool
 * would be a name that can only ever fail. A machine reader that calls a listed
 * name and gets nothing concludes the venue is broken rather than absent — the
 * #308 `/partner` defect, in a tool list.
 *
 * ── WHAT THESE TOOLS ARE, IN THE WORDS THAT MATTER ────────────────────────
 *
 * No money, no securities, no offering, no subscription, no order. The
 * instruments are invented and live in Commertize's backend source; they do not
 * describe any real asset, sponsor, or transaction. Every response the backend
 * sends carries `simulation: true` and a disclaimer, and this module RELAYS
 * both rather than restating them — a relay cannot drift from ratified wording
 * and a restatement can.
 *
 * ── WHY THERE IS NO RESULTS OR LEADERBOARD TOOL ───────────────────────────
 *
 * Because there is no such endpoint, and its absence is the feature. Simulated
 * results are private to the credential holder; publishing, ranking or
 * advertising them is prohibited, and a tool that returned another agent's
 * simulated performance would be exactly the surface that prohibition is about.
 * Do not add one because a demo wanted a scoreboard.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { config } from "./config.js";
import { envelopeShape } from "./schemas.js";
import { fail, refuse, toResult } from "./envelope.js";
import { DISCLAIMER } from "./disclaimer.js";
import { getJsonAs, postJson } from "./http.js";

/** Pinned so `platform_info` and the tests read one list, not two. */
export const SANDBOX_TOOL_NAMES = [
	"sandbox_enroll",
	"sandbox_universe",
	"sandbox_record_commitment",
	"sandbox_withdraw_commitment",
	"sandbox_account",
] as const;

/** Tools that write. Named so `platform_info` can report them honestly. */
export const SANDBOX_WRITE_TOOL_NAMES = [
	"sandbox_enroll",
	"sandbox_record_commitment",
	"sandbox_withdraw_commitment",
] as const;

/**
 * Retired for ONE release: registered (behind the same gate) so an old client
 * gets an answer naming the replacement instead of "tool not found", but
 * deliberately absent from both lists above, so `platform_info` never
 * advertises it as a capability. Delete in the release after this one.
 */
export const RETIRED_SANDBOX_TOOL_NAME = "sandbox_place_order";

/** A commitment id is a plain token; anything else never reaches a URL path. */
const COMMITMENT_ID = /^[A-Za-z0-9_-]{1,80}$/;

const BASE = "/api/agents/sandbox";

/**
 * the legal review's 2026-09-03 badge, required on every sandbox surface.
 *
 * A tool DESCRIPTION is a surface: it is what a model reads before deciding
 * what a tool is for, and it travels into transcripts, tool catalogues and
 * registry listings that a response payload never reaches. So the badge is
 * prefixed to every description as a literal, AND it arrives on every
 * response — relayed from the backend body rather than restated, so a backend
 * that stopped sending it produces a visible null instead of a locally invented
 * reassurance.
 *
 * This is a copy of a constant that lives in another repository
 * (`apps/backend/src/sandbox/universe.ts`), which is a real seam: nothing here
 * can import it. `sandbox-e2e.mjs` asserts every description carries this exact
 * string, so a drift shows up as a failed test rather than as two subtly
 * different badges.
 */
const BADGE =
	"SIMULATION — fictional instruments for testing; not offerings; no real assets, sponsors, or transactions.";

/** The blanket line, for the surfaces that name things. */
const FICTION_NOTICE =
	"Sponsor and asset names are invented; any resemblance to a real company is coincidental.";

/**
 * Every tool here needs the agent credential.
 *
 * A missing credential is a refusal that says so, not a silent no-op: a tool
 * that appears to work and does nothing is worse than one that is off.
 */
const NO_CREDENTIAL = (empty: Record<string, unknown>, path: string) =>
	refuse(
		"NO_CREDENTIAL",
		"The simulation venue needs an agent credential. Register at POST /api/agents/register on the Commertize API and set COMMERTIZE_AGENT_KEY. Nothing was recorded.",
		`${config.apiBaseUrl}${path}`,
		empty,
	);

/**
 * Relay a backend payload with the simulation designation intact.
 *
 * `simulation` and the disclaimer come from the BACKEND response, never from a
 * literal here. If the backend ever stopped sending them, this would relay
 * their absence — which is the honest failure — rather than papering over it
 * with a locally hardcoded `true` that would be a claim about a response we did
 * not read.
 */
const relay = (
	body: Record<string, unknown>,
	sourceUrl: string,
	payload: Record<string, unknown>,
) =>
	toResult({
		...payload,
		simulation: body.simulation ?? null,
		// Relayed, never asserted. A backend that stopped sending the badge
		// produces a visible null here rather than a reassurance we invented.
		simulation_badge: body.badge ?? null,
		simulation_fiction_notice: body.fictionNotice ?? null,
		simulation_disclaimer: body.disclaimer ?? null,
		simulation_disclaimer_version: body.disclaimerVersion ?? null,
		as_of: new Date().toISOString(),
		source_url: sourceUrl,
		cache: { hit: false, age_seconds: 0, stale: false },
		disclaimer: DISCLAIMER,
		error: null,
	});

/** The three simulation keys every response in this module carries. */
const simulationShape = {
	simulation: z.boolean().nullable(),
	simulation_badge: z.string().nullable(),
	simulation_fiction_notice: z.string().nullable(),
	simulation_disclaimer: z.string().nullable(),
	simulation_disclaimer_version: z.string().nullable(),
};

export const registerSandboxTools = (server: McpServer): void => {
	if (config.sandboxDisabled) return;

	/* ---------------------------------------------------------- */
	/* sandbox_enroll                                              */
	/* ---------------------------------------------------------- */
	server.registerTool(
		"sandbox_enroll",
		{
			title: "Open a simulation ledger for this credential",
			description: `${BADGE} ${FICTION_NOTICE} Take the simulation capability and open a notional, non-monetary ledger for THIS credential. No money is involved, no security is offered, and nothing here is an investment or a subscription. Idempotent: calling it again returns the existing ledger and does not add a second opening balance. Requires an agent credential (COMMERTIZE_AGENT_KEY).`,
			inputSchema: {},
			outputSchema: {
				...envelopeShape,
				...simulationShape,
				notice: z.string().nullable(),
				capability: z.string().nullable(),
				universe: z.string().nullable(),
				account: z
					.object({
						opened_at: z.string(),
						notional_cents: z.number(),
						commitments: z.number(),
					})
					.nullable(),
			},
			annotations: {
				readOnlyHint: false,
				// It creates a row, and calling it twice changes nothing.
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		async () => {
			const path = `${BASE}/enroll`;
			const sourceUrl = `${config.apiBaseUrl}${path}`;
			const empty = {
				notice: null,
				capability: null,
				universe: null,
				account: null,
			};
			if (!config.agentKey) return NO_CREDENTIAL(empty, path);
			try {
				const res = await postJson<Record<string, unknown>>(
					path,
					{},
					config.agentKey,
				);
				const b = res.body ?? {};
				const account = (b.account ?? {}) as Record<string, unknown>;
				return relay(b, res.sourceUrl, {
					notice: (b.notice as string) ?? null,
					capability: (b.capability as string) ?? null,
					universe: (b.universe as string) ?? null,
					account: {
						opened_at: String(account.openedAt ?? ""),
						notional_cents: Number(account.notionalCents ?? 0),
						commitments: Number(account.commitments ?? 0),
					},
				});
			} catch (err) {
				return fail(err, sourceUrl, empty);
			}
		},
	);

	/* ---------------------------------------------------------- */
	/* sandbox_universe                                            */
	/* ---------------------------------------------------------- */
	server.registerTool(
		"sandbox_universe",
		{
			title: "The simulation venue's invented instrument list",
			description: `${BADGE} ${FICTION_NOTICE} List the instruments the simulation venue carries. Every one is INVENTED: an invented asset with an invented sponsor, existing only in Commertize's backend source. None of them is a real property, a real operator, or anything Commertize lists, and none of them is an offering. The payload carries no performance figures of any kind and no forward-looking estimate, because a simulation of an agent's plumbing does not need one. Requires an agent credential.`,
			inputSchema: {},
			outputSchema: {
				...envelopeShape,
				...simulationShape,
				universe: z.string().nullable(),
				assets: z
					.array(
						z.object({
							id: z.string(),
							name: z.string(),
							city: z.string(),
							state: z.string(),
							property_type: z.string(),
							sponsor: z.string(),
							unit_amount_cents: z.number(),
							units_outstanding: z.number(),
						}),
					)
					.nullable(),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async () => {
			const path = `${BASE}/universe`;
			const sourceUrl = `${config.apiBaseUrl}${path}`;
			const empty = { universe: null, assets: null };
			if (!config.agentKey) return NO_CREDENTIAL(empty, path);
			try {
				const res = await getJsonAs<Record<string, unknown>>(
					path,
					config.agentKey,
				);
				const b = res.body ?? {};
				const assets = Array.isArray(b.assets) ? b.assets : [];
				return relay(b, res.sourceUrl, {
					universe: (b.universe as string) ?? null,
					assets: assets.map((raw) => {
						const a = raw as Record<string, unknown>;
						return {
							id: String(a.id ?? ""),
							name: String(a.name ?? ""),
							city: String(a.city ?? ""),
							state: String(a.state ?? ""),
							property_type: String(a.propertyType ?? ""),
							sponsor: String(a.sponsor ?? ""),
							unit_amount_cents: Number(a.unitAmountCents ?? 0),
							units_outstanding: Number(a.unitsOutstanding ?? 0),
						};
					}),
				});
			} catch (err) {
				return fail(err, sourceUrl, empty);
			}
		},
	);

	/** The commitment row, as both commitment tools return it. */
	const commitmentShape = z
		.object({
			seq: z.number(),
			id: z.string(),
			asset_id: z.string(),
			status: z.string(),
			quantity: z.number(),
			unit_amount_cents: z.number(),
			notional_cents: z.number(),
			decline_reason: z.string().nullable(),
			simulation: z.boolean(),
			created_at: z.string(),
		})
		.nullable();

	/** Map the venue's row. Every field is read off the row, none asserted. */
	const commitmentOf = (raw: unknown) => {
		const o = (raw ?? {}) as Record<string, unknown>;
		return {
			seq: Number(o.seq ?? 0),
			id: String(o.id ?? ""),
			asset_id: String(o.assetId ?? ""),
			status: String(o.status ?? ""),
			quantity: Number(o.quantity ?? 0),
			unit_amount_cents: Number(o.unitAmountCents ?? 0),
			notional_cents: Number(o.notionalCents ?? 0),
			decline_reason: (o.declineReason as string) ?? null,
			// Relayed from the row, never asserted here.
			simulation: o.simulation === true,
			created_at: String(o.createdAt ?? ""),
		};
	};

	/* ---------------------------------------------------------- */
	/* sandbox_record_commitment                                   */
	/* ---------------------------------------------------------- */
	server.registerTool(
		"sandbox_record_commitment",
		{
			title: "Record one simulated commitment",
			description: `${BADGE} Record a simulated primary commitment against an invented instrument, from a notional balance. THIS MOVES NO MONEY AND CREATES NO OBLIGATION: it is not a subscription, and not an investment in anything. A declined commitment (insufficient notional balance, unknown instrument) still returns a row with a reason code. To reverse one, use sandbox_withdraw_commitment before the simulated close. Results are private to this credential; publishing, ranking, or advertising them is prohibited. Requires an agent credential.`,
			inputSchema: {
				asset_id: z
					.string()
					.describe(
						"An id from sandbox_universe. Never a Commertize listing id — the venue does not know what those are.",
					),
				quantity: z
					.number()
					.int()
					.positive()
					.describe("Whole units. There are no fractional units."),
				idempotency_key: z
					.string()
					.min(8)
					.max(80)
					.describe(
						"YOUR replay key, 8-80 characters. Required, not optional: reusing it returns the original commitment instead of recording a second one, which is the whole point. Generate one per intended commitment and reuse it on every retry.",
					),
			},
			outputSchema: {
				...envelopeShape,
				...simulationShape,
				commitment: commitmentShape,
			},
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				// True, and load-bearing: the caller supplies the key that makes it so.
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		async (args) => {
			const path = `${BASE}/commitments`;
			const sourceUrl = `${config.apiBaseUrl}${path}`;
			const empty = { commitment: null };
			if (!config.agentKey) return NO_CREDENTIAL(empty, path);
			try {
				// Built field by field: nothing the caller passes beyond these
				// three (an old client's `side`, say) can reach the venue.
				const res = await postJson<Record<string, unknown>>(
					path,
					{
						assetId: args.asset_id,
						quantity: args.quantity,
						idempotencyKey: args.idempotency_key,
					},
					config.agentKey,
				);
				const b = res.body ?? {};
				return relay(b, res.sourceUrl, {
					commitment: commitmentOf(b.commitment),
				});
			} catch (err) {
				return fail(err, sourceUrl, empty);
			}
		},
	);

	/* ---------------------------------------------------------- */
	/* sandbox_withdraw_commitment                                 */
	/* ---------------------------------------------------------- */
	server.registerTool(
		"sandbox_withdraw_commitment",
		{
			title: "Withdraw one simulated commitment",
			description: `${BADGE} Withdraw a simulated commitment this credential recorded, before the simulated close only; after it, the venue declines and says so. THIS MOVES NO MONEY AND CREATES NO OBLIGATION. Withdrawing twice returns the same withdrawn row. Requires an agent credential.`,
			inputSchema: {
				commitment_id: z
					.string()
					.describe(
						"The id sandbox_record_commitment returned. Letters, digits, '-' and '_' only.",
					),
			},
			outputSchema: {
				...envelopeShape,
				...simulationShape,
				commitment: commitmentShape,
			},
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		async (args) => {
			const empty = { commitment: null };
			// Checked before it is spliced into a path: an id like "../account"
			// must never address a different route.
			if (!COMMITMENT_ID.test(args.commitment_id)) {
				const path = `${BASE}/commitments`;
				return refuse(
					"INVALID_ARGUMENT",
					"commitment_id must be the id sandbox_record_commitment returned (letters, digits, '-' and '_'). Nothing was withdrawn.",
					`${config.apiBaseUrl}${path}`,
					empty,
				);
			}
			const path = `${BASE}/commitments/${args.commitment_id}/withdraw`;
			const sourceUrl = `${config.apiBaseUrl}${path}`;
			if (!config.agentKey) return NO_CREDENTIAL(empty, path);
			try {
				const res = await postJson<Record<string, unknown>>(
					path,
					{},
					config.agentKey,
				);
				const b = res.body ?? {};
				return relay(b, res.sourceUrl, {
					commitment: commitmentOf(b.commitment),
				});
			} catch (err) {
				return fail(err, sourceUrl, empty);
			}
		},
	);

	/* ---------------------------------------------------------- */
	/* retired name: one release, records nothing                  */
	/* ---------------------------------------------------------- */
	server.registerTool(
		RETIRED_SANDBOX_TOOL_NAME,
		{
			title: "Retired name",
			description: `${BADGE} RETIRED. This name has been replaced by sandbox_record_commitment; calling it records nothing and returns an error naming the replacement. It will be removed in the next release.`,
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async () =>
			refuse(
				"TOOL_RENAMED",
				`${RETIRED_SANDBOX_TOOL_NAME} has been renamed to sandbox_record_commitment, which takes asset_id, quantity and idempotency_key. Nothing was recorded.`,
				`${config.apiBaseUrl}${BASE}/commitments`,
				{},
			),
	);

	/* ---------------------------------------------------------- */
	/* sandbox_account                                             */
	/* ---------------------------------------------------------- */
	server.registerTool(
		"sandbox_account",
		{
			title: "This credential's own simulated ledger",
			description: `${BADGE} Read THIS credential's notional balance and derived positions. There is no way to read another credential's simulation: no such endpoint exists, and the absence is deliberate — simulated results are private to their holder and Commertize publishes no per-agent simulated results. Nothing in this payload is a return, a performance figure, or a track record. Requires an agent credential.`,
			inputSchema: {},
			outputSchema: {
				...envelopeShape,
				...simulationShape,
				account: z
					.object({
						opened_at: z.string(),
						reset_at: z.string().nullable(),
						notional_cents: z.number(),
						commitments: z.number(),
					})
					.nullable(),
				positions: z
					.array(z.object({ asset_id: z.string(), units: z.number() }))
					.nullable(),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async () => {
			const path = `${BASE}/account`;
			const sourceUrl = `${config.apiBaseUrl}${path}`;
			const empty = { account: null, positions: null };
			if (!config.agentKey) return NO_CREDENTIAL(empty, path);
			try {
				const res = await getJsonAs<Record<string, unknown>>(
					path,
					config.agentKey,
				);
				const b = res.body ?? {};
				const a = (b.account ?? {}) as Record<string, unknown>;
				const positions = Array.isArray(b.positions) ? b.positions : [];
				return relay(b, res.sourceUrl, {
					account: {
						opened_at: String(a.openedAt ?? ""),
						reset_at: (a.resetAt as string) ?? null,
						notional_cents: Number(a.notionalCents ?? 0),
						commitments: Number(a.commitments ?? 0),
					},
					positions: positions.map((raw) => {
						const p = raw as Record<string, unknown>;
						return {
							asset_id: String(p.assetId ?? ""),
							units: Number(p.units ?? 0),
						};
					}),
				});
			} catch (err) {
				return fail(err, sourceUrl, empty);
			}
		},
	);
};
