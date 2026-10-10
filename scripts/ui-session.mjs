// ui-session.mjs — sign in once, SAVE the session (storageState), and capture the
// real /create-agent wizard signed-in so the automation is built from the live UI.
// Session is reused by later steps so we never re-login mid-flow.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'https://three.ws';
const OUT = process.env.OUT || '/tmp/ui-session';
const DIR = path.join(os.homedir(), '.three-ws-fleet');
const STATE = path.join(DIR, 'state.json');

function env() {
	const o = {};
	for (const line of fs.readFileSync(path.join(DIR, 'env'), 'utf8').split('\n')) {
		if (!line || line.startsWith('#')) continue;
		const i = line.indexOf('='); if (i < 0) continue;
		o[line.slice(0, i)] = line.slice(i + 1);
	}
	return o;
}
const e = env();

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const shot = (n) => page.screenshot({ path: path.join(OUT, `${n}.png`) }).catch(() => {});

try {
	// sign in — wait for the real form field before touching it (the login page
	// paints late; filling too early is what silently failed before).
	await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
	const pwEl = await page.waitForSelector('#password, input[type="password"]', { timeout: 25_000, state: 'visible' });
	const idEl = await page.$('#email') || await page.$('input[type="email"]') || await page.$('input[name="username"]');
	if (!idEl) throw new Error('identifier field not found on /login');
	await idEl.fill(e.THREEWS_LOGIN);
	await pwEl.fill(e.THREEWS_PASSWORD);
	await shot('login-filled');
	const sub = await page.$('#submit') || await page.$('button[type="submit"]');
	if (sub) await sub.click(); else await page.keyboard.press('Enter');
	// success = navigation off /login
	let signedIn = false;
	try { await page.waitForURL((u) => !/\/login/.test(u.toString()), { timeout: 20_000 }); signedIn = true; } catch {}
	console.log('signed in:', signedIn, '→', page.url());
	if (!signedIn) { await shot('login-failed'); throw new Error('login failed'); }

	// persist the session for later steps
	await ctx.storageState({ path: STATE });
	fs.chmodSync(STATE, 0o600);
	console.log('saved session →', STATE);

	// open the real create-agent wizard and capture it
	await page.goto(`${BASE}/create-agent`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
	await page.waitForTimeout(3500);
	await shot('create-agent-01');

	// enumerate the visible interactive controls so we can script the exact click-path
	const controls = await page.evaluate(() => {
		const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
		const out = [];
		for (const el of document.querySelectorAll('button, a[role="button"], input, textarea, [data-step], [class*="chip"], [class*="tab"]')) {
			if (!vis(el)) continue;
			const t = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().slice(0, 40);
			if (!t) continue;
			out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} · "${t}"`);
		}
		return [...new Set(out)].slice(0, 40);
	}).catch(() => []);
	console.log('\n/create-agent visible controls:');
	for (const c of controls) console.log('  ' + c);
	fs.writeFileSync(path.join(OUT, 'create-agent-controls.json'), JSON.stringify(controls, null, 2));
} catch (err) {
	console.log('✗', err.message.slice(0, 160));
	await shot('error');
} finally {
	await page.waitForTimeout(300);
	await ctx.close();
	await browser.close();
	console.log('\nout:', OUT);
}
