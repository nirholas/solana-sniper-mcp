// Caller input → Strategy rows (shared by the CLI, MCP and HTTP faces).
import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { buildStrategy, isValidMint, solToLamports, strategyRowProblems } from '../src/strategy-input.js';

describe('solToLamports', () => {
	it('converts exactly, including values that defeat naive string splitting', () => {
		expect(solToLamports(0.1)).toBe(100_000_000n);
		expect(solToLamports(0.3)).toBe(300_000_000n);
		expect(solToLamports(1e-7)).toBe(100n);
		expect(solToLamports(1e-9)).toBe(1n);
		expect(solToLamports(123.456789123)).toBe(123_456_789_123n);
		expect(solToLamports('0.000000001')).toBe(1n);
		expect(solToLamports('42')).toBe(42_000_000_000n);
	});

	it('rejects negative, non-finite, over-precise and absurd amounts', () => {
		for (const bad of [-1, NaN, Infinity, 1e12, '0.0000000001', '-1', '1e3', '', ' ', null, undefined, {}]) {
			expect(() => solToLamports(/** @type {any} */ (bad))).toThrow(RangeError);
		}
	});
});

describe('isValidMint', () => {
	it('accepts real base58 public keys only', () => {
		expect(isValidMint('FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump')).toBe(true);
		expect(isValidMint(Keypair.generate().publicKey.toBase58())).toBe(true);
		for (const bad of ['', 'abc', 'THREEsynthetic1111111111111111111111111111111', '0OIl'.repeat(10), 42, null]) {
			expect(isValidMint(bad)).toBe(false);
		}
	});
});

describe('buildStrategy', () => {
	const base = { per_trade_sol: 0.1, daily_budget_sol: 1, stop_loss_pct: 30 };
	const ids = { id: 's1', agentId: 'a1', network: /** @type {const} */ ('devnet') };

	it('builds a lamport-denominated row and only copies supplied optionals', () => {
		const row = buildStrategy({ ...base, take_profit_pct: 80 }, ids);
		expect(row).toEqual({
			id: 's1', agent_id: 'a1', enabled: true, trigger: 'new_mint', network: 'devnet',
			per_trade_lamports: '100000000', daily_budget_lamports: '1000000000',
			stop_loss_pct: 30, take_profit_pct: 80,
		});
		expect('trailing_stop_pct' in row).toBe(false);
	});

	it('rejects a per-trade amount above the daily budget', () => {
		expect(() => buildStrategy({ ...base, per_trade_sol: 2 }, ids)).toThrow(/exceeds the daily budget/);
	});

	it('reports every problem with a row at once', () => {
		const problems = strategyRowProblems({ per_trade_lamports: '0', daily_budget_lamports: 'x', stop_loss_pct: 0, slippage_bps: 20_000, min_market_cap_usd: 10, max_market_cap_usd: 5 });
		expect(problems).toHaveLength(5);
	});
});
