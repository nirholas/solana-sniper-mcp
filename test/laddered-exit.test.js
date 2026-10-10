import { describe, it, expect } from 'vitest';
import { decideLadderedExit, moonbagFraction, ladderMultiple } from '../src/exit-logic.js';

// The owner's rules, pinned for the fleet engine: buy nothing outside 10k–100k
// (scorer, tested elsewhere) and NEVER cut 100% on the way up — take initials at
// 2×, hold a moon bag, protect it with the trailing stop; stop-loss always wins.

const ENTRY = 1_000_000_000;
const pos = (over = {}) => ({
	entry_quote_lamports: String(ENTRY),
	stop_loss_pct: 30,
	trailing_stop_pct: 20,
	take_profit_pct: null,
	max_hold_seconds: null,
	opened_at_ms: 1_000_000_000_000,
	initials_out_multiple: 2,
	moonbag_min_pct: 15,
	initials_recovered: false,
	...over,
});
const NOW = 1_000_000_000_000 + 60_000;

describe('fleet ladder helpers', () => {
	it('ladderMultiple requires > 1', () => {
		expect(ladderMultiple(2)).toBe(2);
		expect(ladderMultiple(1)).toBe(null);
		expect(ladderMultiple(null)).toBe(null);
	});
	it('moonbagFraction defaults 15%, clamps [0,0.95]', () => {
		expect(moonbagFraction(null)).toBeCloseTo(0.15);
		expect(moonbagFraction(200)).toBe(0.95);
	});
});

describe('fleet decideLadderedExit', () => {
	it('holds under 2× (no premature take)', () => {
		expect(decideLadderedExit(pos(), 1.7 * ENTRY, 1.7 * ENTRY, NOW)).toBe(null);
	});
	it('at 2× sells half (recovers initials), keeps a moon bag, never 100%', () => {
		const d = decideLadderedExit(pos(), 2 * ENTRY, 2 * ENTRY, NOW);
		expect(d.reason).toBe('take_initials');
		expect(d.sellFraction).toBeCloseTo(0.5);
		expect(d.sellFraction).toBeLessThan(1);
		expect(d.recoversInitials).toBe(true);
	});
	it('at 5× keeps 80% moon bag', () => {
		expect(decideLadderedExit(pos(), 5 * ENTRY, 5 * ENTRY, NOW).sellFraction).toBeCloseTo(0.2);
	});
	it('never breaches the moonbag floor', () => {
		const d = decideLadderedExit(pos({ initials_out_multiple: 1.05, moonbag_min_pct: 90 }), 1.05 * ENTRY, 1.05 * ENTRY, NOW);
		expect(d.sellFraction).toBeCloseTo(0.1);
	});
	it('stop-loss is a full exit and wins', () => {
		const d = decideLadderedExit(pos(), 0.6 * ENTRY, 2.5 * ENTRY, NOW);
		expect(d.reason).toBe('stop_loss');
		expect(d.sellFraction).toBe(1);
	});
	it('moon bag exits fully on the trailing stop after initials', () => {
		const d = decideLadderedExit(pos({ initials_recovered: true }), 3 * ENTRY, 4 * ENTRY, NOW);
		expect(d.reason).toBe('trailing_stop');
		expect(d.sellFraction).toBe(1);
	});
	it('ladder off (no multiple) = classic full exit', () => {
		const d = decideLadderedExit(pos({ initials_out_multiple: null, take_profit_pct: 60 }), 2 * ENTRY, 2 * ENTRY, NOW);
		expect(d.reason).toBe('take_profit');
		expect(d.sellFraction).toBe(1);
	});
});
