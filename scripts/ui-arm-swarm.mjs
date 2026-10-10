// ui-arm-swarm.mjs — arm every Swarm agent's pump.fun sniper through the real
// /dashboard/sniper "Arm an agent +" modal, signed in via the saved session,
// recorded. Per agent: select it, set daily budget / per-trade / oracle-conviction,
// confirm. Run AFTER funding (the platform keeps an unfunded agent disarmed).
//
// Env from ~/.three-ws-fleet/env. Usage: DAILY=0.02 PER_TRADE=0.002 ORACLE=55 node scripts/ui-arm-swarm.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'https://three.ws';
const OUT = process.env.OUT || '/tmp/ui-arm-swarm';
const STATE = path.join(os.homedir(), '.three-ws-fleet', 'state.json');
const DAILY = process.env.DAILY || '0.02';
const PER_TRADE = process.env.PER_TRADE || '0.002';
const ORACLE = process.env.ORACLE || '55';

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, storageState: STATE, recordVideo: { dir: OUT, size: { width: 1280, height: 900 } } });
const page = await ctx.newPage();
const shot = (n) => page.screenshot({ path: path.join(OUT, `${n}.png`) }).catch(() => {});

async function armOne(name) {
	await page.goto(`${BASE}/dashboard/sniper`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
	await page.waitForTimeout(3500);
	// already armed? a strategy card with this name means done
	const has = await page.evaluate((nm) => [...document.querySelectorAll('h1,h2,h3,h4,[class*="name"],[class*="title"]')].some((h) => (h.textContent || '').trim().startsWith(nm)), name).catch(() => false);
	if (has) return 'exists';
	const armBtn = await page.$('#sn-arm-btn') || await page.$('button:has-text("Arm an agent")');
	if (!armBtn) return 'no-arm-btn';
	await armBtn.click().catch(() => {});
	await page.waitForTimeout(2000);
	// select the agent option matching this name
	const val = await page.evaluate((nm) => {
		const sel = document.querySelector('#sn-arm-agent'); if (!sel) return null;
		for (const o of sel.options) if ((o.textContent || '').trim() === nm || (o.textContent || '').includes(nm)) return o.value;
		return null;
	}, name).catch(() => null);
	if (!val) return 'not-in-dropdown';
	await page.selectOption('#sn-arm-agent', val).catch(() => {});
	await page.fill('#sn-arm-budget', DAILY).catch(() => {});
	await page.fill('#sn-arm-per-trade', PER_TRADE).catch(() => {});
	const orc = await page.$('#sn-arm-oracle'); if (orc) await orc.fill(ORACLE).catch(() => {});
	await page.waitForTimeout(400);
	const confirm = await page.$('#sn-arm-confirm');
	if (!confirm) return 'no-confirm';
	await confirm.click().catch(() => {});
	await page.waitForTimeout(3500);
	return 'armed';
}

try {
	let armed = 0;
	for (let i = 1; i <= 33; i++) {
		const name = `Swarm ${i}`;
		process.stdout.write(`arming ${name} … `);
		let r = '';
		try { r = await armOne(name); } catch (e) { r = 'err:' + e.message.slice(0, 50); }
		if (r === 'armed' || r === 'exists') armed++;
		console.log(r);
	}
	await shot('final');
	console.log(`\narmed/exists: ${armed}/33`);
} catch (err) {
	console.log('✗', err.message.slice(0, 160)); await shot('error');
} finally {
	await page.waitForTimeout(400); await ctx.close();
	const vid = fs.readdirSync(OUT).find((f) => f.endsWith('.webm')); await browser.close();
	console.log('out:', OUT, vid ? `(video: ${vid})` : '');
}
