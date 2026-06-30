// Unit tests for the pure exit decision (src/exit-logic.js). No I/O.
import { describe, it, expect } from 'vitest';
import { decideExit } from '../src/exit-logic.js';

const NOW = 1_700_000_000_000;

// Helper: a position entered at `entry` lamports with the given exit rules.
function pos(entry, rules = {}) {
	return { entry_quote_lamports: entry, opened_at_ms: NOW, ...rules };
}

describe('decideExit — guards', () => {
	it('holds (null) when entry is non-positive', () => {
		expect(decideExit(pos(0, { stop_loss_pct: 10 }), 1, 1, NOW)).toBe(null);
	});

	it('holds when no rule is breached', () => {
		const p = pos(1_000, { stop_loss_pct: 50, take_profit_pct: 50 });
		expect(decideExit(p, 1_010, 1_010, NOW)).toBe(null);
	});
});

describe('decideExit — stop_loss (highest priority)', () => {
	it('fires when down at least the stop-loss percent', () => {
		const p = pos(1_000, { stop_loss_pct: 20 });
		expect(decideExit(p, 800, 1_000, NOW)).toBe('stop_loss');
	});

	it('takes priority over take_profit and timeout when all breached', () => {
		// value below entry → stop_loss must win even with tp/timeout also set.
		const p = pos(1_000, { stop_loss_pct: 20, take_profit_pct: 10, max_hold_seconds: 1 });
		expect(decideExit(p, 700, 1_500, NOW + 10_000)).toBe('stop_loss');
	});
});

describe('decideExit — trailing_stop', () => {
	it('arms only after the peak exceeds entry', () => {
		// peak never beat entry → trailing stop does not arm even on a large drop.
		const p = pos(1_000, { trailing_stop_pct: 10 });
		expect(decideExit(p, 850, 950, NOW)).toBe(null);
	});

	it('fires when in profit and the drawdown from peak exceeds the trail', () => {
		// peak 1500 (> entry 1000), value 1300 → 13.3% drop from peak >= 10%.
		const p = pos(1_000, { trailing_stop_pct: 10 });
		expect(decideExit(p, 1_300, 1_500, NOW)).toBe('trailing_stop');
	});

	it('outranks take_profit when both apply', () => {
		const p = pos(1_000, { trailing_stop_pct: 10, take_profit_pct: 20 });
		// value 1300 is up 30% (tp) but also 13% off the 1500 peak (trail) → trail wins.
		expect(decideExit(p, 1_300, 1_500, NOW)).toBe('trailing_stop');
	});
});

describe('decideExit — take_profit', () => {
	it('fires when up at least the take-profit percent', () => {
		const p = pos(1_000, { take_profit_pct: 25 });
		expect(decideExit(p, 1_300, 1_300, NOW)).toBe('take_profit');
	});

	it('outranks timeout when both apply', () => {
		const p = pos(1_000, { take_profit_pct: 25, max_hold_seconds: 1 });
		expect(decideExit(p, 1_300, 1_300, NOW + 10_000)).toBe('take_profit');
	});
});

describe('decideExit — timeout', () => {
	it('fires once max_hold_seconds has elapsed', () => {
		const p = pos(1_000, { max_hold_seconds: 30 });
		expect(decideExit(p, 1_010, 1_010, NOW + 31_000)).toBe('timeout');
	});

	it('holds before the hold window elapses', () => {
		const p = pos(1_000, { max_hold_seconds: 30 });
		expect(decideExit(p, 1_010, 1_010, NOW + 5_000)).toBe(null);
	});
});

describe('decideExit — signal_flip (sentiment)', () => {
	const bearish = { signal: 'bearish', confidence: 0.9, minConfidence: 0.7 };

	it('fires when underwater, bearish, and confident enough', () => {
		const p = pos(1_000, { stop_loss_pct: 90 });
		// value 950 < entry, no other rule breached, bearish above min confidence.
		expect(decideExit(p, 950, 1_000, NOW, bearish)).toBe('signal_flip');
	});

	it('holds while in profit even on a bearish flip', () => {
		const p = pos(1_000, {});
		expect(decideExit(p, 1_100, 1_100, NOW, bearish)).toBe(null);
	});

	it('holds when confidence is below the minimum', () => {
		const p = pos(1_000, { stop_loss_pct: 90 });
		const weak = { signal: 'bearish', confidence: 0.5, minConfidence: 0.7 };
		expect(decideExit(p, 950, 1_000, NOW, weak)).toBe(null);
	});

	it('is lowest priority — stop_loss still wins', () => {
		const p = pos(1_000, { stop_loss_pct: 5 });
		expect(decideExit(p, 800, 1_000, NOW, bearish)).toBe('stop_loss');
	});
});
