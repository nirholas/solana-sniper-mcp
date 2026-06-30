// agent-sniper — entry scoring. Pure, no I/O.
//
// Given an enriched candidate (from a Feed) and a Strategy, decide whether to
// snipe. Returns { pass, score, reasons }. `reasons` always explains the verdict
// — kept on skipped events too so logs show WHY a mint was passed over, which is
// what you stare at when tuning a strategy.

function n(v) {
	if (v == null) return null;
	const x = Number(v);
	return Number.isFinite(x) ? x : null;
}

/**
 * Optional learned model: `weights` is a flat map of signal-key → coefficient.
 * Contribution is the dot product of present numeric signals with their weights,
 * squashed into a small bounded range so it nudges rather than dominates the
 * deterministic gates. Returns null when no weights are supplied.
 *
 * @param {object} signals
 * @param {Record<string, number>|null} weights
 * @returns {number|null}
 */
export function learnedScore(signals, weights) {
	if (!weights || typeof weights !== 'object') return null;
	let acc = 0;
	let used = 0;
	for (const [k, w] of Object.entries(weights)) {
		const v = n(signals?.[k]);
		if (v == null || !Number.isFinite(w)) continue;
		acc += v * w;
		used++;
	}
	if (!used) return null;
	// bound to ±0.5 so the learned term can't swamp the quality baseline.
	return Number(Math.max(-0.5, Math.min(0.5, acc)).toFixed(4));
}

/**
 * Score a fresh launch for a `new_mint` strategy. Fires blind on the create
 * event, so it leans on hard creator/market filters.
 *
 * @param {import('./types.js').Candidate} mint
 * @param {import('./types.js').Strategy} strat
 * @returns {{ pass: boolean, score: number, reasons: string[] }}
 */
export function scoreMint(mint, strat) {
	const reasons = [];
	let score = 0;

	// ── hard filters (any failure → skip) ────────────────────────────────────
	if (strat.require_sol_quote !== false && mint.is_usdc_pair) {
		return { pass: false, score: 0, reasons: ['quote_not_sol'] };
	}

	const mcUsd = n(mint.market_cap_usd);
	const minMc = n(strat.min_market_cap_usd);
	const maxMc = n(strat.max_market_cap_usd);
	if (minMc != null && (mcUsd == null || mcUsd < minMc)) {
		return { pass: false, score: 0, reasons: ['mc_below_min'] };
	}
	if (maxMc != null && mcUsd != null && mcUsd > maxMc) {
		return { pass: false, score: 0, reasons: ['mc_above_max'] };
	}

	const launches = n(mint.creator_launches);
	const graduated = n(mint.creator_graduated);
	const maxLaunches = n(strat.max_creator_launches);
	const minGrad = n(strat.min_creator_graduated);
	if (maxLaunches != null && launches != null && launches > maxLaunches) {
		return { pass: false, score: 0, reasons: ['creator_too_many_launches'] };
	}
	if (minGrad != null && (graduated == null || graduated < minGrad)) {
		return { pass: false, score: 0, reasons: ['creator_too_few_graduated'] };
	}

	const hasSocials = !!(mint.twitter || mint.telegram || mint.website);
	if (strat.require_socials && !hasSocials) {
		return { pass: false, score: 0, reasons: ['no_socials'] };
	}

	// ── soft signals (contribute to score; tie-break / future ranking) ───────
	if (hasSocials) { score += 1; reasons.push('has_socials'); }
	if (graduated != null && graduated > 0) { score += graduated; reasons.push(`creator_graduated:${graduated}`); }
	const initBuy = n(mint.initial_buy_sol);
	if (initBuy != null && initBuy >= 1) { score += 1; reasons.push(`initial_buy:${initBuy.toFixed(2)}sol`); }
	if (mcUsd != null) reasons.push(`mc_usd:${Math.round(mcUsd)}`);

	return { pass: true, score, reasons };
}

/**
 * Score a coin AFTER an intelligence pass has observed it (`intel_confirmed`).
 * Has the full picture — bundle likelihood, organic score, concentration, dev
 * behaviour, classification — so it can afford to be picky.
 *
 * @param {import('./types.js').Candidate} rec
 * @param {import('./types.js').Strategy} strat
 * @param {Record<string, number>|null} [weights]
 * @returns {{ pass: boolean, score: number, reasons: string[] }}
 */
export function scoreIntel(rec, strat, weights = null) {
	const reasons = [];
	const s = rec?.signals || {};

	// ── hard gates ───────────────────────────────────────────────────────────
	const minQ = n(strat.min_quality_score);
	if (minQ != null && (rec.quality_score == null || rec.quality_score < minQ)) {
		return { pass: false, score: 0, reasons: [`quality_below_min:${rec.quality_score}`] };
	}
	const maxBundle = n(strat.max_bundle_score);
	if (maxBundle != null && s.bundle_score != null && s.bundle_score > maxBundle) {
		return { pass: false, score: 0, reasons: [`bundle_above_max:${s.bundle_score}`] };
	}
	const maxConc = n(strat.max_concentration_top1);
	if (maxConc != null && s.concentration_top1 != null && s.concentration_top1 > maxConc) {
		return { pass: false, score: 0, reasons: [`whale_concentration:${s.concentration_top1}`] };
	}
	if (strat.avoid_dev_dump !== false && s.dev_sold) {
		return { pass: false, score: 0, reasons: ['dev_dumped'] };
	}
	const cats = Array.isArray(strat.allowed_categories) ? strat.allowed_categories.filter(Boolean) : [];
	if (cats.length && rec.category && !cats.includes(rec.category)) {
		return { pass: false, score: 0, reasons: [`category_excluded:${rec.category}`] };
	}
	if (strat.require_socials && !(rec.twitter || rec.telegram || rec.website)) {
		return { pass: false, score: 0, reasons: ['no_socials'] };
	}

	// ── score: baseline quality + learned model + organic, minus risk ─────────
	let score = (rec.quality_score ?? 0) / 100;
	reasons.push(`quality:${rec.quality_score}`);
	if (s.organic_score != null) { score += s.organic_score * 0.5; reasons.push(`organic:${s.organic_score}`); }
	if (s.bundle_score != null) { score -= s.bundle_score * 0.5; if (s.bundle_score >= 0.4) reasons.push(`bundle:${s.bundle_score}`); }

	const learned = learnedScore(s, weights);
	if (learned != null) { score += learned; reasons.push(`learned:${learned}`); }

	if (rec.category) reasons.push(`cat:${rec.category}`);
	for (const flag of rec.risk_flags || []) reasons.push(`flag:${flag}`);

	return { pass: true, score: Number(score.toFixed(4)), reasons };
}
