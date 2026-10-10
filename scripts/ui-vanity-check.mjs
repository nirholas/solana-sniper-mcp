// ui-vanity-check.mjs — open the dashboard "+ Vanity" flow and capture what it
// accepts (prefix? suffix? length limit?), WITHOUT committing a grind. Safe:
// opens the modal on the first agent, screenshots + dumps controls, then cancels.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'https://three.ws';
const OUT = process.env.OUT || '/tmp/ui-vanity';
const STATE = path.join(os.homedir(), '.three-ws-fleet', 'state.json');

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, storageState: STATE });
const page = await ctx.newPage();
const shot = (n) => page.screenshot({ path: path.join(OUT, `${n}.png`), fullPage: true }).catch(() => {});

try {
	await page.goto(`${BASE}/dashboard/agents`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
	await page.waitForTimeout(4500);
	const vbtn = page.getByText('Vanity', { exact: false }).first();
	if (!(await vbtn.count().catch(() => 0))) { console.log('no "+ Vanity" element found'); await shot('no-vanity'); throw new Error('no vanity element'); }
	await vbtn.click().catch(() => {});
	await page.waitForTimeout(2500);
	await shot('vanity-open');
	const map = await page.evaluate(() => {
		const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none'; };
		const out = [];
		for (const el of document.querySelectorAll('input, select, button, [role="radio"], [class*="option"], label')) {
			if (!vis(el)) continue;
			const t = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
			if (!t && el.tagName !== 'INPUT') continue;
			out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.type ? '(' + el.type + ')' : ''}${t ? ' · "' + t + '"' : ''}`);
		}
		// grab any helper/hint text mentioning prefix/suffix/base58/character
		const hints = [];
		for (const el of document.querySelectorAll('p, span, small, [class*="hint"], [class*="help"], [class*="note"]')) {
			const t = (el.innerText || '').trim();
			if (/prefix|suffix|base58|character|end|start|vanity/i.test(t) && t.length < 160) hints.push(t.replace(/\s+/g, ' '));
		}
		return { controls: [...new Set(out)].slice(0, 40), hints: [...new Set(hints)].slice(0, 12) };
	}).catch(() => ({}));
	console.log('vanity controls:'); for (const c of map.controls || []) console.log('  ' + c);
	console.log('\nvanity hints:'); for (const h of map.hints || []) console.log('  ' + h);
	fs.writeFileSync(path.join(OUT, 'vanity-map.json'), JSON.stringify(map, null, 2));
	// cancel/close without committing
	const cancel = await page.$('button:has-text("Cancel"), button:has-text("Close"), [aria-label="Close"], button:has-text("×")');
	if (cancel) await cancel.click().catch(() => {});
} catch (err) {
	console.log('✗', err.message.slice(0, 160));
	await shot('error');
} finally {
	await page.waitForTimeout(300);
	await ctx.close();
	await browser.close();
	console.log('out:', OUT);
}
