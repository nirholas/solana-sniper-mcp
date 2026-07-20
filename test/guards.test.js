// Unit tests for the pre-trade guards + flow control (src/guards.js). Pure.
import { describe, it, expect, vi } from 'vitest';
import {
	checkConcurrency,
	checkDailyBudgetLamports,
	checkSolHeadroom,
	checkPriceImpact,
	snipeConfidence,
	makeThrottle,
	makeQueue,
	SOL_FEE_HEADROOM_LAMPORTS,
} from '../src/guards.js';

describe('checkConcurrency', () => {
	it('passes (null) below the cap', () => {
		expect(checkConcurrency(2, 3)).toBe(null);
	});

	it('breaches at the cap', () => {
		expect(checkConcurrency(3, 3)).toEqual({ reason: 'max_concurrency' });
	});

	it('defaults the cap to 1 when unset', () => {
		expect(checkConcurrency(0, undefined)).toBe(null);
		expect(checkConcurrency(1, undefined)).toEqual({ reason: 'max_concurrency' });
	});
});

describe('checkDailyBudgetLamports', () => {
	it('breaches when no budget is set', () => {
		expect(checkDailyBudgetLamports(0n, 100n, 0n)).toEqual({ reason: 'no_budget' });
	});

	it('passes when spent + trade is within budget', () => {
		expect(checkDailyBudgetLamports(100n, 100n, 1_000n)).toBe(null);
	});

	it('breaches when spent + trade exceeds budget', () => {
		expect(checkDailyBudgetLamports(950n, 100n, 1_000n)).toEqual({ reason: 'daily_budget_exceeded' });
	});

	it('does bigint math beyond Number.MAX_SAFE_INTEGER', () => {
		const spent = 9_007_199_254_740_993n; // > 2^53
		const trade = 1n;
		const budget = spent + trade;
		expect(checkDailyBudgetLamports(spent, trade, budget)).toBe(null);
		expect(checkDailyBudgetLamports(spent, 2n, budget)).toEqual({ reason: 'daily_budget_exceeded' });
	});

	it('coerces non-bigint numeric inputs', () => {
		expect(checkDailyBudgetLamports(0, 500, 1_000)).toBe(null);
	});
});

describe('checkSolHeadroom', () => {
	it('passes when balance covers trade plus the default fee headroom', () => {
		const trade = 1_000_000n;
		const bal = trade + SOL_FEE_HEADROOM_LAMPORTS;
		expect(checkSolHeadroom(bal, trade)).toBe(null);
	});

	it('breaches when balance falls one lamport short of headroom', () => {
		const trade = 1_000_000n;
		const bal = trade + SOL_FEE_HEADROOM_LAMPORTS - 1n;
		expect(checkSolHeadroom(bal, trade)).toEqual({ reason: 'insufficient_sol' });
	});

	it('accepts a custom headroom', () => {
		expect(checkSolHeadroom(150n, 100n, 50n)).toBe(null);
		expect(checkSolHeadroom(149n, 100n, 50n)).toEqual({ reason: 'insufficient_sol' });
	});
});

describe('checkPriceImpact', () => {
	it('does not gate when the max is unset / non-positive', () => {
		expect(checkPriceImpact(99, undefined)).toBe(null);
		expect(checkPriceImpact(99, 0)).toBe(null);
		expect(checkPriceImpact(99, NaN)).toBe(null);
	});

	it('passes when impact is at or below the max', () => {
		expect(checkPriceImpact(10, 10)).toBe(null);
		expect(checkPriceImpact(5, 10)).toBe(null);
	});

	it('breaches when impact exceeds the max', () => {
		expect(checkPriceImpact(11, 10)).toEqual({ reason: 'price_impact_too_high' });
	});

	// An armed gate must never be satisfied by the absence of a number. A quote
	// that failed to price (a pool decoded to empty reserves, an adapter that
	// omitted the field) yields undefined/NaN, and `NaN > 10` is false, so this
	// used to wave the trade through as if impact were zero.
	it('fails closed when the impact figure is missing or not a number', () => {
		expect(checkPriceImpact(undefined, 10)).toEqual({ reason: 'price_impact_unknown' });
		expect(checkPriceImpact(null, 10)).toEqual({ reason: 'price_impact_unknown' });
		expect(checkPriceImpact(NaN, 10)).toEqual({ reason: 'price_impact_unknown' });
		expect(checkPriceImpact('not-a-number', 10)).toEqual({ reason: 'price_impact_unknown' });
		expect(checkPriceImpact(Infinity, 10)).toEqual({ reason: 'price_impact_unknown' });
	});

	// A real, genuinely zero impact is still a pass: the guard distinguishes
	// "no impact" from "no number".
	it('passes a real zero impact', () => {
		expect(checkPriceImpact(0, 10)).toBe(null);
	});

	// With no gate armed there is nothing to fail closed on.
	it('stays open when the gate is unset even if the impact is unknown', () => {
		expect(checkPriceImpact(undefined, 0)).toBe(null);
	});
});

describe('snipeConfidence', () => {
	it('scores a clean, low-impact entry above a high-impact one', () => {
		const low = snipeConfidence({ priceImpactPct: 1, maxImpactPct: 10, firewallVerdict: 'allow' });
		const high = snipeConfidence({ priceImpactPct: 9, maxImpactPct: 10, firewallVerdict: 'allow' });
		expect(low).toBeGreaterThan(high);
	});

	// The ledger records conviction. An unpriced quote is LOW conviction, not a
	// NaN hole in the audit trail.
	it('takes the full impact penalty (never NaN) on an unusable impact figure', () => {
		const unknown = snipeConfidence({ priceImpactPct: undefined, maxImpactPct: 10, firewallVerdict: null });
		expect(Number.isFinite(unknown)).toBe(true);
		// Same as a quote that consumed the entire impact allowance.
		expect(unknown).toBeCloseTo(snipeConfidence({ priceImpactPct: 10, maxImpactPct: 10, firewallVerdict: null }), 10);
		expect(unknown).toBeLessThan(snipeConfidence({ priceImpactPct: 0, maxImpactPct: 10, firewallVerdict: null }));
	});

	it('stays inside 0.05..0.95', () => {
		expect(snipeConfidence({ priceImpactPct: 1e9, maxImpactPct: 1, firewallVerdict: 'warn' })).toBeGreaterThanOrEqual(0.05);
		expect(snipeConfidence({ priceImpactPct: 0, maxImpactPct: 10, firewallVerdict: 'allow' })).toBeLessThanOrEqual(0.95);
	});
});

describe('makeThrottle', () => {
	it('allows everything when the rate is disabled (<= 0)', () => {
		const t = makeThrottle(0);
		for (let i = 0; i < 100; i++) expect(t.tryConsume()).toBe(true);
	});

	it('caps consumes within the sliding 60s window', () => {
		const t = makeThrottle(2);
		expect(t.tryConsume()).toBe(true);
		expect(t.tryConsume()).toBe(true);
		expect(t.tryConsume()).toBe(false);
	});

	it('frees slots once the window slides past old hits', () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(0);
			const t = makeThrottle(1);
			expect(t.tryConsume()).toBe(true);
			expect(t.tryConsume()).toBe(false);
			vi.setSystemTime(61_000); // > 60s later → old hit expires
			expect(t.tryConsume()).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('makeQueue', () => {
	it('reports in-flight as active + queued', async () => {
		const q = makeQueue(1, 10, {});
		let release;
		const gate = new Promise((r) => { release = r; });
		q.push(() => gate); // becomes active immediately
		q.push(() => Promise.resolve()); // waits
		expect(q.inFlight).toBe(2);
		release();
		await gate;
	});

	it('caps concurrency and runs queued jobs as slots free', async () => {
		let active = 0;
		let maxActive = 0;
		const q = makeQueue(2, 10, {});
		const run = () => new Promise((resolve) => {
			active++;
			maxActive = Math.max(maxActive, active);
			setTimeout(() => { active--; resolve(); }, 5);
		});
		for (let i = 0; i < 6; i++) q.push(run);
		await new Promise((r) => setTimeout(r, 60));
		expect(maxActive).toBeLessThanOrEqual(2);
		expect(q.inFlight).toBe(0);
	});

	it('drops a job and calls onDrop once maxDepth waiters are queued', () => {
		const onDrop = vi.fn();
		// concurrency 1, depth 1: first job runs (active), one may wait, the next is dropped.
		const q = makeQueue(1, 1, { onDrop });
		q.push(() => new Promise(() => {})); // active forever
		const accepted = q.push(() => new Promise(() => {})); // queued (depth 1)
		const rejected = q.push(() => new Promise(() => {})); // dropped
		expect(accepted).toBe(true);
		expect(rejected).toBe(false);
		expect(onDrop).toHaveBeenCalledTimes(1);
	});

	it('routes a thrown job error to onError', async () => {
		const onError = vi.fn();
		const q = makeQueue(1, 5, { onError });
		q.push(() => Promise.reject(new Error('boom')));
		await new Promise((r) => setTimeout(r, 10));
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0][0].message).toBe('boom');
	});
});
