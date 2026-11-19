// agent-sniper — caller input → Strategy rows, validated in one place.
//
// The CLI, the MCP server and the HTTP API all accept strategies from outside
// the process. They share this module so a SOL amount converts to lamports the
// same exact way everywhere, every numeric field has the same bounds, and a
// row the engine would mis-handle (a zero stop-loss that exits on the first
// tick, a per-trade amount larger than the daily budget) is rejected up front.

import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';

import { MAX_SLIPPAGE_BPS, resolveSlippageBps } from './guards.js';

export const LAMPORTS_PER_SOL = 1_000_000_000n;
// Far above any real budget (total SOL supply is ~6e8); rejects typos like 1e12.
export const MAX_SOL = 1_000_000_000;

/**
 * Convert a SOL amount to lamports without binary floating-point drift. Numbers
 * go through toFixed(9) (so 0.1 is exactly 100000000 and 1e-7 works); strings
 * must be plain decimals with at most 9 fractional digits.
 *
 * @param {number|string} sol
 * @returns {bigint}
 * @throws {RangeError} on a negative, non-finite, over-precise or absurd amount
 */
export function solToLamports(sol) {
	let text;
	if (typeof sol === 'number') {
		if (!Number.isFinite(sol) || sol < 0 || sol > MAX_SOL) throw new RangeError(`invalid SOL amount: ${sol}`);
		text = sol.toFixed(9);
	} else if (typeof sol === 'string' && /^\d+(\.\d{1,9})?$/.test(sol.trim())) {
		text = sol.trim();
		if (Number(text) > MAX_SOL) throw new RangeError(`invalid SOL amount: ${sol}`);
	} else {
		throw new RangeError(`invalid SOL amount: ${String(sol)}`);
	}
	const [whole, frac = ''] = text.split('.');
	return BigInt(whole) * LAMPORTS_PER_SOL + BigInt(frac.padEnd(9, '0'));
}

/**
 * True for a base58 string that decodes to a 32-byte Solana public key.
 * @param {unknown} value
 */
export function isValidMint(value) {
	if (typeof value !== 'string' || value.length < 32 || value.length > 44) return false;
	try {
		return new PublicKey(value).toBase58() === value;
	} catch {
		return false;
	}
}

export const mintSchema = z.string().trim().refine(isValidMint, 'must be a base58 Solana mint address');

// Ids end up in logs, store keys and (for agents) keystore file names.
export const idSchema = z.string().trim().regex(/^[A-Za-z0-9._:-]{1,128}$/, 'letters, digits, . _ : - only (max 128)');

const pct = (max) => z.number().finite().positive().max(max);
const solAmount = () => z.number().finite().positive().max(MAX_SOL);

/**
 * Zod shapes for every caller-settable strategy field. Faces pick the subset
 * they expose; bounds are identical everywhere.
 */
export const strategyFieldShapes = {
	per_trade_sol: solAmount().describe('SOL committed per snipe.'),
	daily_budget_sol: solAmount().describe('SOL/day spend ceiling for this agent (counts each buy at its max-slippage cost).'),
	stop_loss_pct: pct(100).describe('REQUIRED. Exit when down this percent from entry (0 < x <= 100).'),
	take_profit_pct: pct(100_000).optional().describe('Exit when up this percent from entry.'),
	trailing_stop_pct: z.number().finite().positive().lt(100).optional().describe('Exit when down this percent from peak (0 < x < 100).'),
	max_hold_seconds: z.number().int().positive().max(30 * 86_400).optional().describe('Hard time-stop in seconds (default 1800, max 30 days).'),
	slippage_bps: z.number().int().min(0).max(MAX_SLIPPAGE_BPS).optional().describe('Entry slippage tolerance in bps, 0-10000 (default 500).'),
	max_price_impact_pct: pct(100).optional().describe('Entry circuit breaker: skip buys whose quote impact exceeds this percent (default 10).'),
	trigger: z.enum(['new_mint', 'intel_confirmed', 'first_claim', 'manual']).optional().describe('What fires the buy.'),
	network: z.enum(['mainnet', 'devnet']).optional().describe('Chain (defaults to the sniper network).'),
	mev_tip_mode: z.enum(['off', 'economy', 'turbo']).optional().describe('MEV tip aggressiveness.'),
	firewall_level: z.enum(['block', 'warn', 'off']).optional().describe('Rug/honeypot firewall posture.'),
	min_market_cap_usd: z.number().finite().nonnegative().optional().describe('Skip candidates below this market cap.'),
	max_market_cap_usd: z.number().finite().positive().optional().describe('Skip candidates above this market cap.'),
	require_socials: z.boolean().optional().describe('Require twitter/telegram/website on the candidate.'),
	max_concurrent_positions: z.number().int().positive().max(1_000).optional().describe('Open positions allowed at once for this agent.'),
	require_sol_quote: z.boolean().optional().describe('Only buy SOL-quoted coins (default true).'),
	min_creator_graduated: z.number().int().nonnegative().optional().describe('Skip creators with fewer graduated coins.'),
	max_creator_launches: z.number().int().nonnegative().optional().describe('Skip creators with more launches.'),
	min_quality_score: z.number().finite().optional().describe('intel trigger: minimum quality score.'),
	max_bundle_score: z.number().finite().optional().describe('intel trigger: maximum bundle score.'),
	max_concentration_top1: z.number().finite().optional().describe('intel trigger: maximum top-holder concentration.'),
	avoid_dev_dump: z.boolean().optional().describe('intel trigger: skip coins whose dev sold (default true).'),
	allowed_categories: z.array(z.string().max(64)).max(32).optional().describe('intel trigger: allowed categories.'),
	initials_out_multiple: z.number().finite().gt(1).max(1_000).optional().describe('Exit ladder: at this multiple of entry, sell enough to recover the cost basis.'),
	moonbag_min_pct: z.number().finite().min(0).max(95).optional().describe('Exit ladder: share of the bag always kept (default 15).'),
};

/** Fields copied verbatim from validated input onto the stored row. */
const PASSTHROUGH = Object.keys(strategyFieldShapes).filter((k) => k !== 'per_trade_sol' && k !== 'daily_budget_sol');

/**
 * Problems with a lamport-denominated strategy row, as human-readable strings.
 * Empty when the row is safe to arm.
 *
 * @param {Partial<import('./types.js').Strategy>} row
 * @returns {string[]}
 */
export function strategyRowProblems(row) {
	const problems = [];
	const lamports = (v) => {
		try { return v == null || v === '' ? null : BigInt(/** @type {any} */ (v)); } catch { return null; }
	};
	const perTrade = lamports(row.per_trade_lamports);
	const budget = lamports(row.daily_budget_lamports);
	if (perTrade == null || perTrade <= 0n) problems.push('per_trade_lamports must be a positive integer');
	if (budget == null || budget <= 0n) problems.push('daily_budget_lamports must be a positive integer');
	if (perTrade != null && budget != null && perTrade > budget) problems.push('per-trade amount exceeds the daily budget, so no buy could ever pass');
	const stop = Number(row.stop_loss_pct);
	if (row.stop_loss_pct == null || !Number.isFinite(stop) || stop <= 0 || stop > 100) {
		problems.push('stop_loss_pct is required and must be in (0, 100]');
	}
	if (resolveSlippageBps(row.slippage_bps) == null) problems.push(`slippage_bps must be an integer from 0 to ${MAX_SLIPPAGE_BPS}`);
	if (row.min_market_cap_usd != null && row.max_market_cap_usd != null && Number(row.min_market_cap_usd) > Number(row.max_market_cap_usd)) {
		problems.push('min_market_cap_usd is above max_market_cap_usd');
	}
	return problems;
}

/**
 * Build a Strategy row from validated, SOL-denominated input.
 *
 * @param {Record<string, any>} input  output of a schema built from strategyFieldShapes
 * @param {{ id: string, agentId: string, network: 'mainnet'|'devnet', extra?: Record<string, unknown> }} ids
 * @returns {import('./types.js').Strategy}
 * @throws {Error} with `.code = 'invalid_strategy'` listing every problem
 */
export function buildStrategy(input, { id, agentId, network, extra = {} }) {
	/** @type {Record<string, any>} */
	const row = {
		id,
		agent_id: agentId,
		enabled: true,
		trigger: input.trigger || 'new_mint',
		network: input.network || network,
		per_trade_lamports: solToLamports(input.per_trade_sol).toString(),
		daily_budget_lamports: solToLamports(input.daily_budget_sol).toString(),
	};
	// Only set optional fields when supplied: stores that map to typed columns
	// distinguish null from absent.
	for (const key of PASSTHROUGH) {
		if (input[key] != null && row[key] === undefined) row[key] = input[key];
	}
	Object.assign(row, extra);
	const problems = strategyRowProblems(row);
	if (problems.length) {
		throw Object.assign(new Error(`invalid strategy: ${problems.join('; ')}`), { code: 'invalid_strategy', status: 400, problems });
	}
	return /** @type {import('./types.js').Strategy} */ (row);
}
