// ui-login.mjs — sign in to three.ws through the REAL UI, recorded.
// First step of the human-on-three.ws automation. Reads creds from
// ~/.three-ws-fleet/env, records video + a screenshot, and reports whether we
// actually landed signed-in (honest verdict — no assuming).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'https://three.ws';
const OUT = process.env.OUT || '/tmp/ui-login';

function env() {
	const f = path.join(os.homedir(), '.three-ws-fleet', 'env');
	const o = {};
	for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
		if (!line || line.startsWith('#')) continue;
		const i = line.indexOf('='); if (i < 0) continue;
		o[line.slice(0, i)] = line.slice(i + 1);
	}
	return o;
}

const e = env();
const LOGIN = e.THREEWS_LOGIN, PASS = e.THREEWS_PASSWORD;
if (!LOGIN || !PASS) { console.error('no THREEWS_LOGIN/PASSWORD in env'); process.exit(1); }

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
	args: ['--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: OUT, size: { width: 1280, height: 720 } } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (ev) => errors.push(ev.message.slice(0, 120)));

async function shot(name) { await page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {}); }

try {
	console.log(`→ ${BASE}/login`);
	await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
	await page.waitForTimeout(2500);
	await shot('01-login-page');

	// Fill the identifier + password. Try the documented ids, then generic fallbacks.
	const idSel = ['#email', 'input[type="email"]', 'input[name="email"]', 'input[name="username"]', '#username'];
	const pwSel = ['#password', 'input[type="password"]', 'input[name="password"]'];
	let filledId = false, filledPw = false;
	for (const s of idSel) { const el = await page.$(s); if (el) { await el.fill(LOGIN); filledId = true; break; } }
	for (const s of pwSel) { const el = await page.$(s); if (el) { await el.fill(PASS); filledPw = true; break; } }
	console.log(`  filled identifier=${filledId} password=${filledPw}`);
	await shot('02-filled');
	if (!filledId || !filledPw) { console.log('  ✗ could not find the email/password inputs on /login'); }

	// Submit: documented #submit, else a submit button / Enter.
	const submit = await page.$('#submit') || await page.$('button[type="submit"]')
		|| await page.$('button:has-text("Sign in")') || await page.$('button:has-text("Log in")');
	if (submit) { await submit.click(); } else { await page.keyboard.press('Enter'); }
	console.log('  submitted, waiting for result…');

	// Success ≈ navigation away from /login (to /dashboard, /, etc.). Also capture any error text.
	await page.waitForTimeout(6000);
	const url = page.url();
	const signedIn = !/\/login/.test(url);
	await shot('03-after-submit');

	// Look for a visible error banner if still on /login.
	let errText = '';
	if (!signedIn) {
		errText = await page.evaluate(() => {
			const el = document.querySelector('.error, .alert, [role="alert"], .form-error, #error');
			return el ? el.textContent.trim().slice(0, 200) : '';
		}).catch(() => '');
	}

	console.log(`\n  RESULT: ${signedIn ? 'SIGNED IN ✓' : 'still on /login ✗'}`);
	console.log(`  final url: ${url}`);
	if (errText) console.log(`  error on page: ${errText}`);
	if (errors.length) console.log(`  page errors: ${errors.slice(0, 3).join(' | ')}`);

	fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ signedIn, url, errText, pageErrors: errors }, null, 2));
} catch (err) {
	console.log('  ✗ exception:', err.message.slice(0, 160));
	await shot('99-error');
} finally {
	await page.waitForTimeout(500);
	await ctx.close();
	const vid = fs.readdirSync(OUT).find((f) => f.endsWith('.webm'));
	await browser.close();
	console.log(`\n  Out: ${OUT}  ${vid ? `(video: ${vid})` : ''}`);
}
