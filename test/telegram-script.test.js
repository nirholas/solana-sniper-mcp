// scripts/telegram.js (fleet tooling, not shipped): untrusted text is escaped.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTelegramTracker, escapeTelegramHtml } from '../scripts/telegram.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('telegram tracker', () => {
	it('escapes HTML in token symbols and agent ids', async () => {
		const sent = [];
		globalThis.fetch = vi.fn(async (_url, init) => { sent.push(JSON.parse(init.body)); return new Response('{}'); });
		const tg = createTelegramTracker({ token: 't', chatId: '1', network: 'devnet' });
		tg.hooks.onBuy({
			candidate: { symbol: '<a href="https://evil.example">CLAIM</a>', mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump' },
			strategy: { agent_id: '<b>x</b>' }, sig: 'SIMULATED', solSpent: 0.1, mode: 'simulate',
		});
		await new Promise((r) => setTimeout(r, 0));
		expect(sent[0].text).not.toContain('<a href="https://evil.example">');
		expect(sent[0].text).toContain('&lt;a href=&quot;https://evil.example&quot;&gt;CLAIM&lt;/a&gt;');
		expect(sent[0].text).toContain('&lt;b&gt;x&lt;/b&gt;');
	});

	it('escapeTelegramHtml handles the reserved characters', () => {
		expect(escapeTelegramHtml('a & b < c > "d"')).toBe('a &amp; b &lt; c &gt; &quot;d&quot;');
		expect(escapeTelegramHtml(null)).toBe('');
	});
});
