#!/usr/bin/env node
// reel.js — a scene-driven Playwright recorder that films the three.ws UI while
// the throwaway sniper fleet funds itself and trades live. Produces one webm of
// the full run plus a screenshot per scene. Pairs with fleet.js: fleet.js does
// the real on-chain work, reel.js films the platform surfaces that visualize it.
//
// Each SCENE is { url, caption, waitFor?, dwellMs?, act? }. A fixed caption bar
// is injected into every page so the recording narrates itself. WebGL/3D pages
// render via swiftshader (same flags the repo's other browser scripts use).
//
//   node scripts/reel.js                       # film the default fleet story vs production
//   BASE=http://localhost:3000 node scripts/reel.js
//   OUT=/path node scripts/reel.js             # video + shots dir
//   SCENES=theater,arena,trades node scripts/reel.js   # subset by key
//
// It films whatever the pages show; to film THIS fleet's trades by name you must
// either run the standalone console (packages/agent-sniper/web/console.html) or
// provision the 33 as platform agents. See fleet.js and the README.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { chromium } from 'playwright';

const BASE = (process.env.BASE || 'https://three.ws').replace(/\/$/, '');
const OUT = process.env.OUT || path.join(os.tmpdir(), 'three-reel', String(Date.now?.() ?? 'run'));
const VIEWPORT = { width: 1280, height: 720 };

// ── the story ─────────────────────────────────────────────────────────────────
// Ordered beats over real, live three.ws surfaces. `waitFor` is a selector that
// proves real data rendered before we start the dwell; `dwellMs` is on-camera
// hold time; `act` is an optional async (page) => {} for interaction.
const STORY = [
	{ key: 'theater', url: '/theater', caption: '33 autonomous agents. 3 SOL. One live sniper fleet.',
		waitFor: 'canvas, .theater-stage, main', dwellMs: 6000 },
	{ key: 'arena', url: '/play/arena', caption: 'The Sniper Arena — agents trade pump.fun in real time.',
		waitFor: 'canvas, main', dwellMs: 7000 },
	{ key: 'terminal', url: '/terminal', caption: 'Mission Control — live launches, intel scores, streaming PnL.',
		waitFor: 'main, .terminal, body', dwellMs: 6000 },
	{ key: 'trades', url: '/trades', caption: 'Live Trade Feed — every fill is a real on-chain buy.',
		waitFor: 'main, body', dwellMs: 6000 },
	{ key: 'pulse', url: '/pulse', caption: 'Money Pulse — the fleet’s heartbeat, on-chain.',
		waitFor: 'canvas, main', dwellMs: 6000 },
];

// A scene's `url` may be an absolute URL (filmed as-is, e.g. a localhost console
// or Solscan) or a path (joined to BASE). SCENE_FILE=<path.json> replaces STORY
// entirely with a custom array so each recording cut ships its own story.
function resolveUrl(u) { return /^https?:\/\//i.test(u) ? u : BASE + u; }
function loadStory() {
	const f = process.env.SCENE_FILE;
	if (!f) return STORY;
	const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
	if (!Array.isArray(arr) || !arr.length) throw new Error(`SCENE_FILE ${f} must be a non-empty JSON array`);
	return arr;
}

const CAPTION_CSS = `
#__reel_bar{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;
 font:600 22px/1.35 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
 color:#fff;background:linear-gradient(0deg,rgba(6,8,15,.92),rgba(6,8,15,0));
 padding:44px 40px 24px;letter-spacing:.2px;text-shadow:0 2px 12px rgba(0,0,0,.6);
 opacity:0;transition:opacity .5s ease}
#__reel_bar.on{opacity:1}
#__reel_bar b{color:#7cf6c8}
#__reel_dot{display:inline-block;width:10px;height:10px;border-radius:50%;
 background:#ff4d5e;margin-right:12px;box-shadow:0 0 12px #ff4d5e;
 animation:__reel_pulse 1.4s ease-in-out infinite;vertical-align:middle}
@keyframes __reel_pulse{0%,100%{opacity:1}50%{opacity:.35}}`;

async function caption(page, text) {
	await page.evaluate(({ text, css }) => {
		let bar = document.getElementById('__reel_bar');
		if (!bar) {
			const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
			bar = document.createElement('div'); bar.id = '__reel_bar'; document.body.appendChild(bar);
		}
		bar.innerHTML = `<span id="__reel_dot"></span>${text}`;
		requestAnimationFrame(() => bar.classList.add('on'));
	}, { text, css: CAPTION_CSS }).catch(() => {});
}

// ── optional live cast: screenshot this browser → three.ws agent-screen ─────────
// When CAST=1 (with AGENT_JWT + AGENT_ID), every ~5s we POST a base64 PNG of the
// current page to /api/agent-screen-push, so the exact browser being filmed also
// streams live at /agent-screen?agentId=<AGENT_ID>. Contract: JSON body
// { agentId, frame:{ data, activity, type } }, Bearer auth, <=6fps, 90s frame TTL.
function startCaster(page, getCaption) {
	const agentId = process.env.AGENT_ID;
	const jwt = process.env.AGENT_JWT;
	const pushUrl = process.env.PUSH_URL || 'https://three.ws/api/agent-screen-push';
	if (!process.env.CAST || !agentId || !jwt) return () => {};
	const everyMs = Math.max(5000, Number(process.env.CAST_INTERVAL_MS) || 6000);
	let stopped = false;
	console.log(`  ⇉ casting live to /agent-screen?agentId=${agentId} every ${everyMs}ms`);
	const tick = async () => {
		if (stopped) return;
		try {
			const buf = await page.screenshot({ type: 'png', fullPage: false });
			const body = JSON.stringify({
				agentId,
				frame: { data: 'data:image/png;base64,' + buf.toString('base64'),
					activity: (getCaption() || 'Working').slice(0, 320), type: 'screenshot' },
			});
			const res = await fetch(pushUrl, { method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` }, body });
			if (!res.ok) console.log(`  [cast] push ${res.status}`);
		} catch (e) { console.log('  [cast]', e.message.slice(0, 80)); }
	};
	const id = setInterval(tick, everyMs);
	tick();
	return () => { stopped = true; clearInterval(id); };
}

async function main() {
	fs.mkdirSync(OUT, { recursive: true });
	const story = loadStory();
	const only = (process.env.SCENES || '').split(',').map((s) => s.trim()).filter(Boolean);
	const scenes = only.length ? story.filter((s) => only.includes(s.key)) : story;

	const browser = await chromium.launch({
		args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl',
			'--ignore-gpu-blocklist', '--no-sandbox', '--disable-dev-shm-usage'],
	});
	const context = await browser.newContext({
		viewport: VIEWPORT,
		recordVideo: { dir: OUT, size: VIEWPORT },
		deviceScaleFactor: 1,
	});
	const page = await context.newPage();
	page.on('pageerror', (e) => console.log('  [pageerror]', e.message.slice(0, 120)));

	let currentCaption = 'Starting the fleet';
	const stopCaster = startCaster(page, () => currentCaption);

	const log = [];
	for (const scene of scenes) {
		currentCaption = scene.caption;
		const url = resolveUrl(scene.url);
		process.stdout.write(`  ▸ ${scene.key.padEnd(9)} ${url} … `);
		const t0 = Date.now?.() ?? 0;
		try {
			await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
			if (scene.waitFor) await page.waitForSelector(scene.waitFor, { timeout: 20_000 }).catch(() => {});
			// let live feeds / 3D settle a beat before the caption
			await page.waitForTimeout(2500);
			await caption(page, scene.caption);
			if (scene.act) await scene.act(page).catch((e) => console.log('act:', e.message));
			await page.waitForTimeout(scene.dwellMs ?? 5000);
			// The scene is captured in the video by this point (the dwell already ran).
			// The per-scene PNG is a bonus still — never let it fail the scene. Live 3D /
			// feed pages render continuously, so a default screenshot never reaches a
			// stable frame; freeze animations, hide the caret, and cap the wait.
			const shot = path.join(OUT, `${scene.key}.png`);
			let shotOk = false;
			try {
				await page.screenshot({ path: shot, animations: 'disabled', caret: 'hide', timeout: 15_000 });
				shotOk = true;
			} catch (shotErr) {
				console.log(`\n    (still skipped: ${shotErr.message.split('\n')[0].slice(0, 60)})`);
			}
			console.log(`ok (${((Date.now?.() ?? 0) - t0) / 1000 | 0}s)${shotOk ? '' : ' — video only'}`);
			log.push({ key: scene.key, url, ok: true, shot: shotOk ? shot : null });
		} catch (e) {
			console.log(`FAIL ${e.message.slice(0, 80)}`);
			log.push({ key: scene.key, url, ok: false, error: e.message });
		}
	}

	stopCaster();
	await page.waitForTimeout(500);
	await context.close(); // flushes the video file
	const video = fs.readdirSync(OUT).find((f) => f.endsWith('.webm'));
	await browser.close();

	fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ base: BASE, video, scenes: log }, null, 2));
	console.log(`\n  Reel → ${OUT}`);
	if (video) console.log(`  Video: ${path.join(OUT, video)}`);
	console.log(`  Scenes ok: ${log.filter((s) => s.ok).length}/${log.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
