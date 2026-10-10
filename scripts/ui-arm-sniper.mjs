// ui-arm-sniper.mjs — capture (and, with ARM=1, drive) the /dashboard/sniper arming
// UI for one agent, signed in via the saved session, recorded.
// CAPTURE mode (default): screenshot + dump the controls so we build the click-path.
// Usage: NAME="Scout 01" node scripts/ui-arm-sniper.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'https://three.ws';
const OUT = process.env.OUT || '/tmp/ui-arm';
const NAME = process.env.NAME || 'Scout 01';
const STATE = path.join(os.homedir(), '.three-ws-fleet', 'state.json');

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, storageState: STATE, recordVideo: { dir: OUT, size: { width: 1280, height: 900 } } });
const page = await ctx.newPage();
const shot = (n) => page.screenshot({ path: path.join(OUT, `${n}.png`), fullPage: true }).catch(() => {});

try {
	await page.goto(`${BASE}/dashboard/sniper`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
	await page.waitForTimeout(5000);
	await shot('sniper-page');

	const map = await page.evaluate((name) => {
		const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none'; };
		// does a card for this agent exist?
		let card = null;
		for (const h of document.querySelectorAll('h1,h2,h3,h4,[class*="name"],[class*="title"],[class*="agent"]')) {
			if ((h.textContent || '').trim().startsWith(name)) { card = h.closest('article,li,section,[class*="card"],[class*="strategy"]') || h.parentElement; break; }
		}
		const scope = card || document;
		const controls = [];
		for (const el of scope.querySelectorAll('button, input, select, [role="switch"], [class*="toggle"]')) {
			if (!vis(el)) continue;
			const t = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
			controls.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.name ? '[' + el.name + ']' : ''}${t ? ' · "' + t + '"' : ''}`);
		}
		// page-level buttons too (e.g. "Add strategy")
		const pageBtns = [...document.querySelectorAll('button')].filter(vis).map((b) => b.innerText.trim().replace(/\s+/g, ' ').slice(0, 30)).filter(Boolean);
		return { hasCard: !!card, controls: [...new Set(controls)].slice(0, 40), pageBtns: [...new Set(pageBtns)].slice(0, 25), heading: document.querySelector('h1,h2')?.innerText?.slice(0, 60) || '' };
	}, NAME).catch((e) => ({ error: e.message }));

	console.log(`heading: ${map.heading}`);
	console.log(`Scout card present: ${map.hasCard}`);
	console.log('\npage buttons:'); for (const b of map.pageBtns || []) console.log('  ' + b);
	fs.writeFileSync(path.join(OUT, 'sniper-map.json'), JSON.stringify(map, null, 2));

	// open the "Arm an agent +" flow and capture its controls
	const armBtn = await page.$('#sn-arm-btn') || await page.$('button:has-text("Arm an agent")');
	if (armBtn) {
		await armBtn.click().catch(() => {});
		await page.waitForTimeout(3000);
		await shot('arm-modal');
		const modal = await page.evaluate(() => {
			const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none'; };
			const out = [];
			for (const el of document.querySelectorAll('button, input, select, option, [role="switch"], label, [class*="agent"]')) {
				if (!vis(el)) continue;
				const t = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.name || '').trim().replace(/\s+/g, ' ').slice(0, 44);
				if (!t && el.tagName !== 'INPUT' && el.tagName !== 'SELECT') continue;
				out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.name ? '[' + el.name + ']' : ''}${el.type ? '(' + el.type + ')' : ''}${t ? ' · "' + t + '"' : ''}`);
			}
			return [...new Set(out)].slice(0, 60);
		}).catch(() => []);
		console.log('\narm-modal controls:'); for (const c of modal) console.log('  ' + c);
		fs.writeFileSync(path.join(OUT, 'arm-modal-controls.json'), JSON.stringify(modal, null, 2));

		if (process.env.ARM === '1') {
			const budget = process.env.DAILY || '0.02';
			const perTrade = process.env.PER_TRADE || '0.002';
			const oracle = process.env.ORACLE || '55';
			// select the agent option whose label contains NAME (or "Scout")
			const val = await page.evaluate((name) => {
				const sel = document.querySelector('#sn-arm-agent'); if (!sel) return null;
				const key = name.split(' ')[0];
				for (const o of sel.options) { if ((o.textContent || '').includes(name) || (o.textContent || '').trim().startsWith(key)) return o.value; }
				return null;
			}, NAME).catch(() => null);
			if (!val) { console.log('  ✗ Scout option not found in agent select'); }
			else {
				await page.selectOption('#sn-arm-agent', val).catch(() => {});
				await page.fill('#sn-arm-budget', budget).catch(() => {});
				await page.fill('#sn-arm-per-trade', perTrade).catch(() => {});
				const orc = await page.$('#sn-arm-oracle'); if (orc) await orc.fill(oracle).catch(() => {});
				await page.waitForTimeout(600);
				await shot('arm-filled');
				console.log(`  arming ${NAME}: budget=${budget} perTrade=${perTrade} oracle=${oracle}`);
				const confirm = await page.$('#sn-arm-confirm');
				if (confirm) { await confirm.click().catch(() => {}); await page.waitForTimeout(4000); await shot('armed'); }
				// verify: armed-agents count or a Scout strategy card
				const verify = await page.evaluate((name) => {
					const body = document.body.innerText;
					const armedM = body.match(/ARMED AGENTS\s*(\d+)/i);
					return { armed: armedM ? armedM[1] : '?', hasScoutCard: [...document.querySelectorAll('h1,h2,h3,h4,[class*="name"],[class*="title"]')].some((h) => (h.textContent || '').trim().startsWith(name)) };
				}, NAME).catch(() => ({}));
				console.log(`  RESULT: armed agents=${verify.armed}, Scout card present=${verify.hasScoutCard}`);
			}
		}
	} else { console.log('no Arm button found'); }
} catch (err) {
	console.log('✗', err.message.slice(0, 160));
	await shot('error');
} finally {
	await page.waitForTimeout(300);
	await ctx.close();
	await browser.close();
	console.log('out:', OUT);
}
