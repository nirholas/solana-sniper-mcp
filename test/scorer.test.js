// Unit tests for the pure entry scorer (src/scorer.js). No I/O, no network.
import { describe, it, expect } from 'vitest';
import { scoreMint, scoreIntel, learnedScore } from '../src/scorer.js';

// A clearly-synthetic mint placeholder — never a real coin address.
const MINT = 'THREEsynthetic1111111111111111111111111111111';

describe('scoreMint — hard filters', () => {
	it('requires a SOL quote by default (rejects a USDC pair)', () => {
		const res = scoreMint({ mint: MINT, is_usdc_pair: true }, {});
		expect(res.pass).toBe(false);
		expect(res.reasons).toContain('quote_not_sol');
	});

	it('allows a USDC pair when require_sol_quote is explicitly false', () => {
		const res = scoreMint({ mint: MINT, is_usdc_pair: true }, { require_sol_quote: false });
		expect(res.pass).toBe(true);
	});

	it('rejects a market cap below the configured minimum', () => {
		const res = scoreMint({ mint: MINT, market_cap_usd: 5_000 }, { min_market_cap_usd: 10_000 });
		expect(res.pass).toBe(false);
		expect(res.reasons).toContain('mc_below_min');
	});

	it('rejects when min market cap is set but the candidate has no market cap', () => {
		const res = scoreMint({ mint: MINT }, { min_market_cap_usd: 10_000 });
		expect(res.pass).toBe(false);
		expect(res.reasons).toContain('mc_below_min');
	});

	it('rejects a market cap above the configured maximum', () => {
		const res = scoreMint({ mint: MINT, market_cap_usd: 5_000_000 }, { max_market_cap_usd: 1_000_000 });
		expect(res.pass).toBe(false);
		expect(res.reasons).toContain('mc_above_max');
	});

	it('rejects a creator with too many prior launches', () => {
		const res = scoreMint({ mint: MINT, creator_launches: 50 }, { max_creator_launches: 5 });
		expect(res.pass).toBe(false);
		expect(res.reasons).toContain('creator_too_many_launches');
	});

	it('rejects a creator with too few graduated coins', () => {
		const res = scoreMint({ mint: MINT, creator_graduated: 0 }, { min_creator_graduated: 1 });
		expect(res.pass).toBe(false);
		expect(res.reasons).toContain('creator_too_few_graduated');
	});

	it('rejects when socials are required but absent', () => {
		const res = scoreMint({ mint: MINT }, { require_socials: true });
		expect(res.pass).toBe(false);
		expect(res.reasons).toContain('no_socials');
	});

	it('passes when socials are required and present (twitter)', () => {
		const res = scoreMint({ mint: MINT, twitter: 'https://x.com/example' }, { require_socials: true });
		expect(res.pass).toBe(true);
		expect(res.reasons).toContain('has_socials');
	});
});

describe('scoreMint — soft scoring', () => {
	it('credits socials, graduated count, and a healthy initial buy', () => {
		const res = scoreMint(
			{ mint: MINT, twitter: 'x', creator_graduated: 3, initial_buy_sol: 2, market_cap_usd: 42_000 },
			{},
		);
		expect(res.pass).toBe(true);
		// 1 (socials) + 3 (graduated) + 1 (initial_buy >= 1) = 5
		expect(res.score).toBe(5);
		expect(res.reasons).toContain('has_socials');
		expect(res.reasons).toContain('creator_graduated:3');
		expect(res.reasons.some((r) => r.startsWith('initial_buy:'))).toBe(true);
		expect(res.reasons).toContain('mc_usd:42000');
	});

	it('does not credit an initial buy below 1 SOL', () => {
		const res = scoreMint({ mint: MINT, initial_buy_sol: 0.5 }, {});
		expect(res.pass).toBe(true);
		expect(res.score).toBe(0);
		expect(res.reasons.some((r) => r.startsWith('initial_buy:'))).toBe(false);
	});

	it('passes a bare candidate with zero score', () => {
		const res = scoreMint({ mint: MINT }, {});
		expect(res.pass).toBe(true);
		expect(res.score).toBe(0);
	});
});

describe('learnedScore', () => {
	it('returns null without weights', () => {
		expect(learnedScore({ a: 1 }, null)).toBe(null);
	});

	it('returns null when no weighted signal is present', () => {
		expect(learnedScore({ b: 1 }, { a: 0.2 })).toBe(null);
	});

	it('computes a bounded dot product of present signals', () => {
		// 0.5*0.2 + 1*0.1 = 0.2
		expect(learnedScore({ a: 0.5, b: 1 }, { a: 0.2, b: 0.1 })).toBe(0.2);
	});

	it('clamps the contribution to +/-0.5', () => {
		expect(learnedScore({ a: 10 }, { a: 10 })).toBe(0.5);
		expect(learnedScore({ a: 10 }, { a: -10 })).toBe(-0.5);
	});
});

describe('scoreIntel — gates', () => {
	const base = { mint: MINT, quality_score: 80, signals: {} };

	it('rejects quality below the minimum', () => {
		const res = scoreIntel({ ...base, quality_score: 40 }, { min_quality_score: 70 });
		expect(res.pass).toBe(false);
		expect(res.reasons[0]).toContain('quality_below_min');
	});

	it('rejects a bundle score above the maximum', () => {
		const res = scoreIntel({ ...base, signals: { bundle_score: 0.8 } }, { max_bundle_score: 0.5 });
		expect(res.pass).toBe(false);
		expect(res.reasons[0]).toContain('bundle_above_max');
	});

	it('rejects top-1 holder concentration above the maximum', () => {
		const res = scoreIntel({ ...base, signals: { concentration_top1: 0.6 } }, { max_concentration_top1: 0.3 });
		expect(res.pass).toBe(false);
		expect(res.reasons[0]).toContain('whale_concentration');
	});

	it('rejects a dev dump by default', () => {
		const res = scoreIntel({ ...base, signals: { dev_sold: true } }, {});
		expect(res.pass).toBe(false);
		expect(res.reasons).toContain('dev_dumped');
	});

	it('allows a dev dump when avoid_dev_dump is explicitly false', () => {
		const res = scoreIntel({ ...base, signals: { dev_sold: true } }, { avoid_dev_dump: false });
		expect(res.pass).toBe(true);
	});

	it('rejects a category outside the allowlist', () => {
		const res = scoreIntel({ ...base, category: 'meme' }, { allowed_categories: ['ai', 'defi'] });
		expect(res.pass).toBe(false);
		expect(res.reasons[0]).toContain('category_excluded');
	});

	it('allows a category inside the allowlist', () => {
		const res = scoreIntel({ ...base, category: 'ai' }, { allowed_categories: ['ai', 'defi'] });
		expect(res.pass).toBe(true);
		expect(res.reasons).toContain('cat:ai');
	});

	it('rejects when socials are required but absent', () => {
		const res = scoreIntel({ ...base }, { require_socials: true });
		expect(res.pass).toBe(false);
		expect(res.reasons).toContain('no_socials');
	});
});

describe('scoreIntel — scoring', () => {
	it('combines quality baseline, organic boost, and bundle penalty', () => {
		const res = scoreIntel(
			{ mint: MINT, quality_score: 80, signals: { organic_score: 0.6, bundle_score: 0.2 } },
			{},
		);
		expect(res.pass).toBe(true);
		// 80/100 + 0.6*0.5 - 0.2*0.5 = 0.8 + 0.3 - 0.1 = 1.0
		expect(res.score).toBe(1);
		expect(res.reasons).toContain('quality:80');
		expect(res.reasons).toContain('organic:0.6');
	});

	it('adds the learned-model dot product when weights are supplied', () => {
		const noWeights = scoreIntel({ mint: MINT, quality_score: 50, signals: { foo: 1 } }, {});
		const withWeights = scoreIntel({ mint: MINT, quality_score: 50, signals: { foo: 1 } }, {}, { foo: 0.4 });
		expect(withWeights.score).toBeCloseTo(noWeights.score + 0.4, 4);
		expect(withWeights.reasons).toContain('learned:0.4');
	});

	it('surfaces risk flags in reasons', () => {
		const res = scoreIntel({ mint: MINT, quality_score: 70, signals: {}, risk_flags: ['fresh_wallet'] }, {});
		expect(res.reasons).toContain('flag:fresh_wallet');
	});
});
