/**
 * Simulation-venue tools: the paper sandbox, as four tools an agent can drive.
 *
 *   sandbox_enroll       take the capability and open a notional ledger
 *   sandbox_universe     the invented instrument list
 *   sandbox_place_order  record one simulated allocation
 *   sandbox_account      this credential's own balance, positions and orders
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
	"sandbox_place_order",
	"sandbox_account",
] as const;

/** Tools that write. Named so `platform_info` can report them honestly. */
export const SANDBOX_WRITE_TOOL_NAMES = [
	"sandbox_enroll",
	"sandbox_place_order",
] as const;

const BASE = "/api/agents/sandbox";

/**
 * the legal review's 2026-09-03 badge, required on every sandbox surface.
 *
 * A tool DESCRIPTION is a surface: it is what a model reads before deciding
 * what a tool is for, and it travels into transcripts, tool catalogues and
 * registry listings that a response payload never reaches. So the badge is
 * prefixed to all four descriptions as a literal, AND it arrives on every
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
			description: `${BADGE} ${FICTION_NOTICE} Take the simulation capability and open a notional, non-monetary ledger for THIS credential. No money is involved, no security is offered, and nothing here is an investment, a subscription, or an order. Idempotent: calling it again returns the existing ledger and does not add a second opening balance. Requires an agent credential (COMMERTIZE_AGENT_KEY).`,
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
						orders: z.number(),
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
						orders: Number(account.orders ?? 0),
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
			description: `${BADGE} ${FICTION_NOTICE} List the instruments the simulation venue trades. Every one is INVENTED: an invented asset with an invented sponsor, existing only in Commertize's backend source. None of them is a real property, a real operator, or anything Commertize lists, and none of them is an offering. The payload carries no performance figures of any kind and no forward-looking estimate, because a simulation of an agent's plumbing does not need one. Requires an agent credential.`,
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
							unit_price_cents: z.number(),
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
							unit_price_cents: Number(a.unitPriceCents ?? 0),
							units_outstanding: Number(a.unitsOutstanding ?? 0),
						};
					}),
				});
			} catch (err) {
				return fail(err, sourceUrl, empty);
			}
		},
	);

	/* ---------------------------------------------------------- */
	/* sandbox_place_order                                         */
	/* ---------------------------------------------------------- */
	server.registerTool(
		"sandbox_place_order",
		{
			title: "Record one simulated allocation",
			description: `${BADGE} Record a simulated allocation against an invented instrument, from a notional balance. THIS MOVES NO MONEY AND CREATES NO OBLIGATION: it is not a subscription, not an order, and not an investment in anything. A rejected order (insufficient notional balance, unknown instrument) still returns a row with a reason code. Results are private to this credential; publishing, ranking, or advertising them is prohibited. Requires an agent credential.`,
			inputSchema: {
				asset_id: z
					.string()
					.describe(
						"An id from sandbox_universe. Never a Commertize listing id — the venue does not know what those are.",
					),
				side: z.enum(["buy", "sell"]),
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
						"YOUR replay key, 8-80 characters. Required, not optional: reusing it returns the original allocation instead of recording a second one, which is the whole point. Generate one per intended order and reuse it on every retry.",
					),
			},
			outputSchema: {
				...envelopeShape,
				...simulationShape,
				order: z
					.object({
						seq: z.number(),
						id: z.string(),
						asset_id: z.string(),
						side: z.string(),
						status: z.string(),
						quantity: z.number(),
						unit_price_cents: z.number(),
						notional_cents: z.number(),
						rejection_reason: z.string().nullable(),
						simulation: z.boolean(),
						created_at: z.string(),
					})
					.nullable(),
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
			const path = `${BASE}/orders`;
			const sourceUrl = `${config.apiBaseUrl}${path}`;
			const empty = { order: null };
			if (!config.agentKey) return NO_CREDENTIAL(empty, path);
			try {
				const res = await postJson<Record<string, unknown>>(
					path,
					{
						assetId: args.asset_id,
						side: args.side,
						quantity: args.quantity,
						idempotencyKey: args.idempotency_key,
					},
					config.agentKey,
				);
				const b = res.body ?? {};
				const o = (b.order ?? {}) as Record<string, unknown>;
				return relay(b, res.sourceUrl, {
					order: {
						seq: Number(o.seq ?? 0),
						id: String(o.id ?? ""),
						asset_id: String(o.assetId ?? ""),
						side: String(o.side ?? ""),
						status: String(o.status ?? ""),
						quantity: Number(o.quantity ?? 0),
						unit_price_cents: Number(o.unitPriceCents ?? 0),
						notional_cents: Number(o.notionalCents ?? 0),
						rejection_reason: (o.rejectionReason as string) ?? null,
						// Relayed from the row, never asserted here.
						simulation: o.simulation === true,
						created_at: String(o.createdAt ?? ""),
					},
				});
			} catch (err) {
				return fail(err, sourceUrl, empty);
			}
		},
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
						orders: z.number(),
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
						orders: Number(a.orders ?? 0),
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
