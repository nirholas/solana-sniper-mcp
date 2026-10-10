// agent-sniper — exit decision. Pure, no I/O.
//
// Given a position, its current on-chain value, the high-water mark, the clock,
// and an optional sentiment read, decide whether to close — and why. Evaluated
// in a fixed priority order so the reason is deterministic and explainable:
//   stop-loss → trailing-stop → take-profit → timeout → sentiment-flip.
//
// Returns an exit-reason string, or null to hold.

function num(v, def = null) {
	if (v == null || v === '') return def;
	const n = Number(v);
	return Number.isFinite(n) ? n : def;
}

/**
 * @param {import('./types.js').Position} pos
 * @param {number} value   current value of the position in lamports
 * @param {number} peak    high-water mark in lamports (>= value seen so far)
 * @param {number} nowMs   Date.now()
 * @param {{ signal: string, confidence: number|null, minConfidence: number }|null} [sentiment]
 * @returns {string|null}
 */
export function decideExit(pos, value, peak, nowMs, sentiment = null) {
	const entry = num(pos.entry_quote_lamports, 0) || 0;
	if (entry <= 0) return null;

	const pnlPct = ((value - entry) / entry) * 100;

	// ── stop-loss (mandatory) ────────────────────────────────────────────────
	const stop = num(pos.stop_loss_pct);
	if (stop != null && pnlPct <= -Math.abs(stop)) return 'stop_loss';

	// ── trailing-stop: drawdown from the peak ────────────────────────────────
	const trail = num(pos.trailing_stop_pct);
	if (trail != null && peak > 0) {
		const dropFromPeakPct = ((peak - value) / peak) * 100;
		// Only arms once the position has been in profit at least the trail amount,
		// so a coin that never moves up can't trail-stop on entry noise.
		if (peak > entry && dropFromPeakPct >= Math.abs(trail)) return 'trailing_stop';
	}

	// ── take-profit ──────────────────────────────────────────────────────────
	const tp = num(pos.take_profit_pct);
	if (tp != null && pnlPct >= Math.abs(tp)) return 'take_profit';

	// ── timeout ──────────────────────────────────────────────────────────────
	const maxHold = num(pos.max_hold_seconds);
	const openedAt = num(pos.opened_at_ms);
	if (maxHold != null && openedAt != null && nowMs - openedAt >= maxHold * 1000) {
		return 'timeout';
	}

	// ── sentiment flip (opt-in, only meaningful while underwater) ─────────────
	if (sentiment && value < entry && sentiment.signal === 'bearish') {
		const conf = num(sentiment.confidence);
		if (conf != null && conf >= sentiment.minConfidence) return 'signal_flip';
	}

	return null;
}

/** The take-initials multiple (× entry) or null when the ladder is off (must be
 * > 1 — you can't recover initials below cost). */
export function ladderMultiple(v) {
	const x = num(v);
	return x != null && x > 1 ? x : null;
}

/** Moon-bag floor as a fraction of the position that must ALWAYS remain on the
 * take-initials event. Default 15%, clamped to [0, 0.95] so a sell can never be
 * the whole bag. */
export function moonbagFraction(v) {
	const x = num(v);
	const frac = x == null ? 15 : x;
	return Math.max(0, Math.min(0.95, frac / 100));
}

/**
 * Laddered exit: the reason AND what fraction of the CURRENT remaining position
 * to sell. Encodes the owner's rule: never cut 100% on the way up — at
 * `initials_out_multiple`× entry (e.g. 2×) sell just enough to recover the cost
 * basis (fraction = entry/value, capped at 1 − moonbag floor) and hold a moon bag
 * that rides on the trailing stop. Protective exits (stop-loss → signal-flip →
 * trailing-stop → timeout) are always FULL exits of the remainder, and stop-loss
 * wins every conflict.
 *
 * OPT-IN: with no `initials_out_multiple` set it is byte-for-byte the classic
 * full-exit `decideExit`, so existing strategies are unchanged.
 *
 * @returns {{ reason: string, sellFraction: number, recoversInitials?: boolean }|null}
 */
export function decideLadderedExit(pos, value, peak, nowMs, sentiment = null) {
	const mult = ladderMultiple(pos.initials_out_multiple);
	if (mult == null) {
		const reason = decideExit(pos, value, peak, nowMs, sentiment);
		return reason ? { reason, sellFraction: 1 } : null;
	}

	const entry = num(pos.entry_quote_lamports, 0) || 0;
	if (entry <= 0) return null;
	const pnlPct = ((value - entry) / entry) * 100;
	const moonbag = moonbagFraction(pos.moonbag_min_pct);
	const recovered = pos.initials_recovered === true;

	// Protective exits — full exit of the remainder; stop-loss wins.
	const stop = num(pos.stop_loss_pct);
	if (stop != null && pnlPct <= -Math.abs(stop)) return { reason: 'stop_loss', sellFraction: 1 };
	if (sentiment && value < entry && sentiment.signal === 'bearish') {
		const conf = num(sentiment.confidence);
		if (conf != null && conf >= sentiment.minConfidence) return { reason: 'signal_flip', sellFraction: 1 };
	}
	const trail = num(pos.trailing_stop_pct);
	if (trail != null && peak > 0 && peak > entry && ((peak - value) / peak) * 100 >= Math.abs(trail)) {
		return { reason: 'trailing_stop', sellFraction: 1 };
	}

	// Take-initials — first profit event, once, before initials are recovered.
	if (!recovered && value >= entry * mult) {
		const sellFraction = Math.max(0, Math.min(entry / value, 1 - moonbag));
		if (sellFraction > 0) return { reason: 'take_initials', sellFraction, recoversInitials: true };
	}

	// Moon-bag ceiling — optional classic take-profit, only AFTER initials are out.
	const tp = num(pos.take_profit_pct);
	if (recovered && tp != null && pnlPct >= Math.abs(tp)) return { reason: 'take_profit', sellFraction: 1 };

	// Timeout — full exit of the remainder.
	const maxHold = num(pos.max_hold_seconds);
	const openedAt = num(pos.opened_at_ms);
	if (maxHold != null && openedAt != null && nowMs - openedAt >= maxHold * 1000) {
		return { reason: 'timeout', sellFraction: 1 };
	}
	return null;
}
