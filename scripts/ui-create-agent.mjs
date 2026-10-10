// ui-create-agent.mjs — create ONE agent through the real three.ws 5-step wizard,
// signed in via the saved session, recorded. Walks each step, fills the basics,
// picks a starter (rigged) avatar, and completes — screenshotting + dumping the
// visible controls at every step so the exact click-path is captured for the
// batch-of-33 automation. Reports the new agent id/url.
//
// Usage: NAME="Scout 01" DESC="..." OUT=/path node scripts/ui-create-agent.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'https://three.ws';
const OUT = process.env.OUT || '/tmp/ui-create';
const NAME = process.env.NAME || 'Scout 01';
const DESC = process.env.DESC || 'Autonomous pump.fun market scout — reads the tape, snipes fresh launches, skips the junk.';
const STATE = path.join(os.homedir(), '.three-ws-fleet', 'state.json');

fs.mkdirSync(OUT, { recursive: true });
if (!fs.existsSync(STATE)) { console.error('no saved session at', STATE, '— run ui-session.mjs first'); process.exit(1); }

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: STATE, recordVideo: { dir: OUT, size: { width: 1280, height: 800 } } });
const page = await ctx.newPage();
const shot = (n) => page.screenshot({ path: path.join(OUT, `${n}.png`) }).catch(() => {});

async function dumpControls(label) {
	const controls = await page.evaluate(() => {
		const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none'; };
		const out = [];
		for (const el of document.querySelectorAll('button, a[role="button"], input, textarea, [data-step], [class*="chip"], [class*="tab"], [class*="starter"], [class*="avatar"]')) {
			if (!vis(el)) continue;
			const t = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 44);
			out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '')}${t ? ' · "' + t + '"' : ''}`);
		}
		const heading = document.querySelector('h1, h2, [class*="step"]')?.innerText?.replace(/\s+/g, ' ').slice(0, 60) || '';
		return { heading, controls: [...new Set(out)].slice(0, 45) };
	}).catch(() => ({ heading: '', controls: [] }));
	console.log(`\n── ${label} ── ${controls.heading}`);
	for (const c of controls.controls) console.log('  ' + c);
	return controls;
}

async function firstVisible(sels) {
	for (const s of sels) {
		for (const el of await page.$$(s)) {
			if (await el.isVisible().catch(() => false)) return el;
		}
	}
	return null;
}

async function clickAdvance() {
	// only VISIBLE, enabled advance buttons (the wizard keeps hidden step panels in
	// the DOM, so #btn-next from a prior step lingers — don't click stale ones).
	const el = await firstVisible(['#btn-next',
		'button:has-text("Continue")', 'button:has-text("Next")', 'button:has-text("Review")']);
	if (!el) return false;
	const label = (await el.innerText().catch(() => '')).trim();
	if (await el.isDisabled().catch(() => false)) { console.log(`  advance "${label}" disabled`); return false; }
	await el.click().catch(() => {});
	console.log(`  → clicked "${label}"`);
	return true;
}

try {
	await page.goto(`${BASE}/create-agent`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
	await page.waitForTimeout(3500);

	for (let step = 1; step <= 7; step++) {
		await shot(`step${step}`);
		await dumpControls(`step ${step} (${page.url().replace(BASE, '')})`);

		// success: wizard finished → we're on an agent page, not /create-agent
		if (!/\/create-agent/.test(page.url())) { console.log('\n  wizard left /create-agent →', page.url()); break; }

		// Step 1 basics: fill name + description if the field is present + empty.
		const nameEl = await page.$('#f-name');
		if (nameEl && !(await nameEl.inputValue())) {
			await nameEl.fill(NAME);
			const d = await page.$('#f-description'); if (d) await d.fill(DESC);
			console.log(`  filled name="${NAME}"`);
			await page.waitForTimeout(400);
		}

		// Avatar step: pick the first starter tile if a gallery is present.
		const av = await page.$('#starter-grid img, #starter-grid button, [class*="starter"] img, [class*="starter"] button, [class*="avatar-grid"] button');
		if (av) { await av.click().catch(() => {}); console.log('  picked a starter avatar'); await page.waitForTimeout(800); }

		// Skills step: enable "Pump.fun market intel" (market data for trading decisions).
		const enabledIntel = await page.evaluate(() => {
			const rows = [...document.querySelectorAll('div, section, li, label')];
			for (const r of rows) {
				const txt = (r.innerText || '').toLowerCase();
				if (txt.includes('market intel') || (txt.includes('pump.fun') && txt.includes('market'))) {
					const t = r.querySelector('input[type="checkbox"], [role="switch"], button[class*="toggle"], .toggle');
					if (t) {
						const on = t.getAttribute('aria-checked') === 'true' || t.checked === true || (t.className || '').includes('on');
						if (!on) { t.click(); return true; }
					}
				}
			}
			return false;
		}).catch(() => false);
		if (enabledIntel) { console.log('  enabled Pump.fun market intel skill'); await page.waitForTimeout(500); }

		// Review step: the real submit is #btn-create ("Create agent"). Click it and
		// wait to leave /create-agent (the agent gets written here, not before).
		const createBtn = await page.$('#btn-create');
		if (createBtn && await createBtn.isVisible().catch(() => false) && !(await createBtn.isDisabled().catch(() => false))) {
			console.log('  → clicking "Create agent" (final submit)');
			await createBtn.click().catch(() => {});
			await page.waitForURL((u) => !/\/create-agent/.test(u.toString()), { timeout: 30_000 }).catch(() => {});
			await page.waitForTimeout(2500);
			break;
		}

		const advanced = await clickAdvance();
		await page.waitForTimeout(2500);
		if (!advanced) { console.log('  no advance possible — stopping to inspect'); break; }
	}

	await shot('final');
	const finalUrl = page.url();
	const m = finalUrl.match(/\/agent\/([0-9a-f-]{36})|\/a\/[^/]+\/([0-9a-f-]{36})|agentId=([0-9a-f-]{36})/i);
	const agentId = m ? (m[1] || m[2] || m[3]) : null;
	console.log(`\n  RESULT url: ${finalUrl}`);
	console.log(`  agent id: ${agentId || '(not detected — check final.png)'}`);
	fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ finalUrl, agentId, name: NAME }, null, 2));
} catch (err) {
	console.log('  ✗ exception:', err.message.slice(0, 160));
	await shot('error');
} finally {
	await page.waitForTimeout(400);
	await ctx.close();
	const vid = fs.readdirSync(OUT).find((f) => f.endsWith('.webm'));
	await browser.close();
	console.log(`\n  out: ${OUT} ${vid ? '(video: ' + vid + ')' : ''}`);
}
