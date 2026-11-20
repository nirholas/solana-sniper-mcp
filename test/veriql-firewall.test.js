// Veriql firewall with fetch stubbed: no network, no payment.
import { describe, it, expect, vi } from 'vitest';

import { createVeriqlFirewall } from '../src/veriql-firewall.js';

const quietLogger = () => ({ warn: vi.fn() });
const answer = (result, status = 200) =>
	vi.fn(async () => new Response(JSON.stringify({ version: 1, endpoint: 'launch', result }), { status }));

describe('createVeriqlFirewall', () => {
	it('blocks a critical band and lists the penalties', async () => {
		const fetch = answer({ found: true, score: 4, band: 'critical', drivers: [{ label: 'Honeypot: sells revert', penalty: 96 }] });
		const f = createVeriqlFirewall({ fetch, logger: quietLogger() });
		expect(await f.assessSafety({ mint: 'M1' })).toEqual({ verdict: 'block', score: 4, reasons: ['Honeypot: sells revert (-96)'] });
		expect(fetch.mock.calls[0][0]).toBe('https://veriql.app/api/v1/launch?address=M1&chainId=solana');
	});

	it('warns on danger, partial, inconclusive or an unread mint, and allows the rest', async () => {
		const cases = [
			[{ found: true, score: 30, band: 'danger', drivers: [] }, 'warn'],
			[{ found: true, score: 80, band: 'safe', partial: true, drivers: [] }, 'warn'],
			[{ found: true, score: 80, band: 'safe', inconclusive: true, drivers: [] }, 'warn'],
			[{ found: false }, 'warn'],
			[{ found: true, score: 72, band: 'caution', drivers: [] }, 'allow'],
		];
		for (const [result, verdict] of cases) {
			const f = createVeriqlFirewall({ fetch: answer(result), logger: quietLogger() });
			expect((await f.assessSafety({ mint: 'M' }))?.verdict, JSON.stringify(result)).toBe(verdict);
		}
	});

	it('no answer is no verdict, never allow', async () => {
		const unpaid = createVeriqlFirewall({ fetch: answer({}, 402), logger: quietLogger() });
		expect(await unpaid.assessSafety({ mint: 'M' })).toBeNull();
		const down = createVeriqlFirewall({ fetch: vi.fn(async () => { throw new Error('ECONNRESET'); }), logger: quietLogger() });
		expect(await down.assessSafety({ mint: 'M' })).toBeNull();
	});

	it('one paid read per mint per minute, shared by every caller', async () => {
		const fetch = answer({ found: true, score: 72, band: 'caution', drivers: [] });
		const f = createVeriqlFirewall({ fetch, logger: quietLogger() });
		await f.assessSafety({ mint: 'M' });
		await f.assessSafety({ mint: 'M' });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('a failed read is not cached', async () => {
		const fetch = vi.fn()
			.mockResolvedValueOnce(new Response('{}', { status: 503 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ result: { found: true, score: 72, band: 'caution', drivers: [] } }), { status: 200 }));
		const f = createVeriqlFirewall({ fetch, logger: quietLogger() });
		expect(await f.assessSafety({ mint: 'M' })).toBeNull();
		expect((await f.assessSafety({ mint: 'M' }))?.verdict).toBe('allow');
	});

	it('refuses to start without a paying fetch', () => {
		expect(() => createVeriqlFirewall({})).toThrow(/fetch that pays x402/);
	});
});
