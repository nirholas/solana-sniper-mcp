// veriql-firewall.js — an optional `assessSafety` firewall backed by Veriql's
// launch check (https://veriql.app/api), paid per call over x402.
//
// Veriql scores a Solana mint from chain reads: mint and freeze authority,
// Token-2022 traps (permanent delegate, transfer hook, transfer fee), top-10
// holder share, LP lock, pool liquidity and pump.fun bonding curves, with every
// penalty itemised. A read that could not run is marked partial, never clean.
//
// No dependency is added: pass any fetch that pays an x402 402, for example
// @three-ws/agent-payments or @x402/fetch's wrapFetchWithPayment. Each call
// costs $0.005 in USDC. Answers are cached per mint for a minute, so every
// agent of a fleet evaluating the same launch shares one paid read.
//
// Verdict mapping, so a firewall never cancels a trade on an opinion:
//   band 'critical' (honeypot, live mint authority and the like) → block
//   'danger', a partial or inconclusive read, or an unread mint → warn
//   anything else                                                 → allow
//   no answer at all (network, payment refused, 5xx)               → null
// A null is "no verdict", which the executor already treats as not blocking.

import { log as defaultLog } from './log.js';

const CACHE_LIMIT = 5_000;

/**
 * @param {object} o
 * @param {typeof fetch} o.fetch           a fetch that pays x402 402s
 * @param {string} [o.baseUrl]             default https://veriql.app
 * @param {number} [o.cacheMs]             per-mint answer reuse, default 60s
 * @param {{ warn: Function }} [o.logger]
 * @returns {{ assessSafety: (p: { mint: string }) => Promise<{ verdict: 'allow'|'warn'|'block', score: number, reasons: string[] }|null> }}
 */
export function createVeriqlFirewall({ fetch: payFetch, baseUrl = 'https://veriql.app', cacheMs = 60_000, logger = defaultLog } = {}) {
	if (typeof payFetch !== 'function') throw new Error('createVeriqlFirewall needs a fetch that pays x402');
	const base = baseUrl.replace(/\/+$/, '');
	const cache = new Map(); // mint → { at, value }

	async function read(mint) {
		const url = `${base}/api/v1/launch?address=${encodeURIComponent(mint)}&chainId=solana`;
		let res;
		try {
			res = await payFetch(url);
		} catch (e) {
			logger.warn('veriql firewall: request failed', { mint, error: String(e?.message ?? e) });
			return null;
		}
		if (!res.ok) {
			logger.warn('veriql firewall: no answer', { mint, status: res.status });
			return null;
		}
		const body = await res.json().catch(() => null);
		const r = body?.result;
		if (!r || typeof r !== 'object') return null;
		const reasons = (Array.isArray(r.drivers) ? r.drivers : []).map((d) => `${d.label} (-${d.penalty})`);
		if (r.found !== true) return { verdict: 'warn', score: 0, reasons: ['veriql could not read this mint'] };
		const score = Number(r.score) || 0;
		if (r.band === 'critical') return { verdict: 'block', score, reasons };
		if (r.band === 'danger' || r.partial === true || r.inconclusive === true) return { verdict: 'warn', score, reasons };
		return { verdict: 'allow', score, reasons };
	}

	return {
		async assessSafety({ mint } = {}) {
			if (!mint) return null;
			const hit = cache.get(mint);
			if (hit && Date.now() - hit.at < cacheMs) return hit.value;
			const value = await read(mint);
			// Only real answers are kept: a failed read is retried next time.
			if (value) {
				if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
				cache.set(mint, { at: Date.now(), value });
			}
			return value;
		},
	};
}
