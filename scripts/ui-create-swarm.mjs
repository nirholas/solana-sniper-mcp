// ui-create-swarm.mjs — create Swarm 1..N through the real three.ws 5-step wizard,
// signed in via the saved session, recorded (one continuous video). Idempotent:
// skips any Swarm already present in the dashboard. Rotates starter avatars for
// variety and enables the Pump.fun market-intel skill on each.
//
// Progress + results persist to ~/.three-ws-fleet/swarm-agents.json so a re-run
// resumes where it left off. Usage: COUNT=33 OUT=/path node scripts/ui-create-swarm.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'https://three.ws';
const OUT = process.env.OUT || '/tmp/ui-swarm';
const COUNT = Number(process.env.COUNT || 33);
const DIR = path.join(os.homedir(), '.three-ws-fleet');
const STATE = path.join(DIR, 'state.json');
const MANIFEST = path.join(DIR, 'swarm-agents.json');
const DESC = 'Autonomous pump.fun market scout — reads the tape, snipes fresh launches, skips Mayhem and the junk.';

function loadManifest() { try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return { created: [] }; } }
function saveManifest(m) { fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2)); }

fs.mkdirSync(OUT, { recursive: true });
if (!fs.existsSync(STATE)) { console.error('no session at', STATE); process.exit(1); }

const manifest = loadManifest();
const already = new Set(manifest.created.map((c) => c.name));

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: STATE, recordVideo: { dir: OUT, size: { width: 1280, height: 800 } } });
const page = await ctx.newPage();
const shot = (n) => page.screenshot({ path: path.join(OUT, `${n}.png`) }).catch(() => {});

async function existingSwarmNames() {
	try {
		await page.goto(`${BASE}/dashboard/agents`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
		await page.waitForTimeout(4000);
		return await page.evaluate(() => {
			const names = new Set();
			for (const h of document.querySelectorAll('h1,h2,h3,h4,[class*="name"],[class*="title"]')) {
				const t = (h.textContent || '').trim();
				const m = t.match(/^Swarm \d{1,2}\b/);
				if (m) names.add(m[0]);
			}
			return [...names];
		}).catch(() => []);
	} catch { return []; }
}

async function existsOnDashboard(name) {
	try {
		await page.goto(`${BASE}/dashboard/agents`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
		await page.waitForTimeout(3500);
		return await page.evaluate((nm) => [...document.querySelectorAll('h1,h2,h3,h4,[class*="name"],[class*="title"]')]
			.some((h) => (h.textContent || '').trim() === nm || new RegExp('^' + nm + '\\b').test((h.textContent || '').trim())), name).catch(() => false);
	} catch { return false; }
}

async function clickAdvance() {
	for (const sel of ['#btn-next', 'button:has-text("Continue")', 'button:has-text("Next")', 'button:has-text("Review")']) {
		for (const el of await page.$$(sel)) {
			if (await el.isVisible().catch(() => false) && !(await el.isDisabled().catch(() => false))) { await el.click().catch(() => {}); return true; }
		}
	}
	return false;
}

async function createOne(name, avatarIndex) {
	await page.goto(`${BASE}/create-agent`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
	await page.waitForTimeout(3000);
	for (let step = 1; step <= 8; step++) {
		if (!/\/create-agent/.test(page.url())) break;
		// step 1 basics
		const nameEl = await page.$('#f-name');
		if (nameEl && !(await nameEl.inputValue())) {
			await nameEl.fill(name);
			const d = await page.$('#f-description'); if (d) await d.fill(DESC);
			await page.waitForTimeout(300);
		}
		// avatar step: pick a rotating starter tile
		const tiles = await page.$$('#starter-grid img, #starter-grid button, [class*="starter"] img, [class*="starter"] button');
		if (tiles.length) { await tiles[avatarIndex % tiles.length].click().catch(() => {}); await page.waitForTimeout(600); }
		// skills step: enable Pump.fun market intel
		await page.evaluate(() => {
			for (const r of document.querySelectorAll('div, section, li, label')) {
				const t = (r.innerText || '').toLowerCase();
				if (t.includes('market intel') || (t.includes('pump.fun') && t.includes('market'))) {
					const sw = r.querySelector('input[type="checkbox"], [role="switch"], button[class*="toggle"], .toggle');
					if (sw) { const on = sw.getAttribute('aria-checked') === 'true' || sw.checked === true || (sw.className || '').includes('on'); if (!on) { sw.click(); return; } }
				}
			}
		}).catch(() => {});
		// review step: final Create
		const create = await page.$('#btn-create');
		if (create && await create.isVisible().catch(() => false) && !(await create.isDisabled().catch(() => false))) {
			await create.click().catch(() => {});
			await page.waitForURL((u) => !/\/create-agent/.test(u.toString()), { timeout: 30_000 }).catch(() => {});
			await page.waitForTimeout(2500);
			break;
		}
		if (!(await clickAdvance())) { await page.waitForTimeout(1500); }
		await page.waitForTimeout(2000);
	}
	// confirm via the success screen text
	const ok = await page.evaluate((nm) => document.body.innerText.includes(`${nm} is ready`), name).catch(() => false);
	return ok;
}

try {
	const present = new Set([...(await existingSwarmNames()), ...already]);
	console.log(`already present: ${[...present].sort().join(', ') || '(none)'}`);
	let made = 0;
	for (let i = 1; i <= COUNT; i++) {
		const name = `Swarm ${i}`;
		if (present.has(name)) { console.log(`skip ${name} (exists)`); continue; }
		process.stdout.write(`creating ${name} … `);
		let ok = false;
		for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
			// before any retry, confirm it wasn't actually created (avoid duplicates)
			if (attempt > 1 && await existsOnDashboard(name)) { ok = true; break; }
			try { ok = await createOne(name, i - 1); } catch (e) { console.log(`(attempt ${attempt} err: ${e.message.slice(0, 60)})`); }
		}
		// final safety: even if UI detection missed it, don't count as fail if it exists
		if (!ok && await existsOnDashboard(name)) ok = true;
		if (ok) {
			made++;
			manifest.created.push({ name, at: 'created' });
			saveManifest(manifest);
			await shot(`ready-${String(i).padStart(2, '0')}`);
			console.log('OK');
		} else {
			await shot(`fail-${String(i).padStart(2, '0')}`);
			console.log('FAILED');
		}
	}
	console.log(`\ncreated this run: ${made}. total in manifest: ${manifest.created.length}`);
} catch (err) {
	console.log('✗ fatal:', err.message.slice(0, 160));
	await shot('fatal');
} finally {
	await page.waitForTimeout(500);
	await ctx.close();
	const vid = fs.readdirSync(OUT).find((f) => f.endsWith('.webm'));
	await browser.close();
	console.log('out:', OUT, vid ? `(video: ${vid})` : '');
}
