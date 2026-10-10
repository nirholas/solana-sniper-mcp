// ui-agent-info.mjs — find an agent by name in the signed-in UI and read its id +
// Solana wallet address (from /agent/{id}/edit → Wallet panel). Recorded.
// Usage: NAME="Scout 01" node scripts/ui-agent-info.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'https://three.ws';
const OUT = process.env.OUT || '/tmp/ui-agent-info';
const NAME = process.env.NAME || 'Scout 01';
const STATE = path.join(os.homedir(), '.three-ws-fleet', 'state.json');

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: STATE });
const page = await ctx.newPage();
const shot = (n) => page.screenshot({ path: path.join(OUT, `${n}.png`) }).catch(() => {});

try {
	await page.goto(`${BASE}/dashboard/agents`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
	await page.waitForTimeout(4000);
	await shot('agents-list');

	// find the card whose heading is NAME, then any uuid in that card's links/attrs
	const info = await page.evaluate((name) => {
		const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
		let card = null;
		for (const h of document.querySelectorAll('h1,h2,h3,h4,[class*="name"],[class*="title"],[class*="heading"]')) {
			if ((h.textContent || '').trim().startsWith(name)) { card = h.closest('article,li,section,[class*="card"],[class*="row"]') || h.parentElement; break; }
		}
		const scope = card || document.body;
		for (const a of scope.querySelectorAll('a[href]')) { const m = (a.getAttribute('href') || '').match(UUID); if (m) return { id: m[0], href: a.getAttribute('href') }; }
		for (const el of scope.querySelectorAll('[data-agent-id],[data-id],[data-agent]')) { const v = el.getAttribute('data-agent-id') || el.getAttribute('data-id') || el.getAttribute('data-agent') || ''; if (UUID.test(v)) return { id: v.match(UUID)[0], href: '' }; }
		const m2 = scope.innerHTML.match(UUID); if (m2) return { id: m2[0], href: '' };
		return null;
	}, NAME).catch(() => null);

	if (!info) { console.log(`✗ could not find agent "${NAME}" in /agents`); await shot('not-found'); throw new Error('agent not found in UI'); }
	console.log(`agent "${NAME}" id: ${info.id}`);

	// open its edit page → Wallet panel → read the Solana address
	await page.goto(`${BASE}/agent/${info.id}/edit`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
	await page.waitForTimeout(3500);
	// try to click a "Wallet" tab/panel if present
	const walletTab = await page.$('text=Wallet');
	if (walletTab) { await walletTab.click().catch(() => {}); await page.waitForTimeout(1500); }
	await shot('agent-wallet');

	const addr = await page.evaluate(() => {
		const el = document.querySelector('#wallet-sol-address, [id*="sol-address"], [class*="sol-address"]');
		let a = el ? el.textContent.trim() : '';
		if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) {
			// scan for a base58-looking pubkey on the page
			const m = document.body.innerText.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/);
			a = m ? m[0] : '';
		}
		return a;
	}).catch(() => '');
	console.log(`solana wallet: ${addr || '(not found on page — check agent-wallet.png)'}`);

	fs.writeFileSync(path.join(OUT, 'info.json'), JSON.stringify({ name: NAME, id: info.id, wallet: addr }, null, 2));
} catch (err) {
	console.log('✗', err.message.slice(0, 160));
	await shot('error');
} finally {
	await page.waitForTimeout(300);
	await ctx.close();
	await browser.close();
	console.log('out:', OUT);
}
