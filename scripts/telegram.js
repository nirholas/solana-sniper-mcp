// telegram.js — live trade tracker for the throwaway sniper fleet.
//
// Posts a message on every BUY and SELL (with agent, archetype, symbol, size,
// PnL, and a Solscan tx link) plus a periodic portfolio summary, to a Telegram
// chat or channel. Self-contained — only needs a bot token + chat id; no
// three.ws backend. Wires into the engine via its onBuy/onSell hooks.
//
// Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (or pass token/chatId to the factory).
// Make a channel, add your bot as an admin, and use the channel id (e.g. -100…)
// or a numeric user/group chat id.

const api = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

async function send(token, chatId, text) {
	try {
		const res = await fetch(api(token, 'sendMessage'), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
		});
		if (!res.ok) {
			const b = await res.json().catch(() => ({}));
			console.log(`  [tg] ${res.status} ${b.description || ''}`);
		}
	} catch (e) { console.log('  [tg]', e.message.slice(0, 80)); }
}

const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '');
const txLink = (sig, network) =>
	sig && sig !== 'SIMULATED' ? `https://solscan.io/tx/${sig}${network === 'devnet' ? '?cluster=devnet' : ''}` : null;
const num = (v, d = 4) => Number(v || 0).toFixed(d);

/**
 * @param {object} o
 * @param {string} o.token                 Telegram bot token
 * @param {string|number} o.chatId         chat/channel id
 * @param {string} o.network               'mainnet' | 'devnet'
 * @param {Record<string,string>} [o.archetypeByAgent]  agentId → archetype label
 * @param {number} [o.summaryMs]           portfolio-summary cadence (default 15 min)
 * @returns {{hooks: object, startSummary: Function, stop: Function, announce: Function, enabled: boolean}}
 */
export function createTelegramTracker({ token, chatId, network, archetypeByAgent = {}, summaryMs = 900_000 }) {
	if (!token || !chatId) return { hooks: {}, startSummary() {}, stop() {}, async announce() {}, enabled: false };
	const tag = (id) => (archetypeByAgent[id] ? ` [${archetypeByAgent[id]}]` : '');

	const hooks = {
		onBuy: (p) => {
			const c = p.candidate || {};
			const sym = c.symbol ? `$${c.symbol}` : short(c.mint);
			const tx = txLink(p.sig, network);
			const sim = p.mode === 'simulate' ? ' <i>(sim)</i>' : '';
			send(token, chatId,
				`🟢 <b>BUY</b> · ${p.strategy?.agent_id || ''}${tag(p.strategy?.agent_id)}${sim}\n`
				+ `${sym} · ${num(p.solSpent)} SOL\n`
				+ `<code>${short(c.mint)}</code>${tx ? ` · <a href="${tx}">tx</a>` : ''}`);
		},
		onSell: (p) => {
			const pos = p.position || {};
			const id = pos.agentId || pos.agent_id || '';
			const sym = pos.symbol ? `$${pos.symbol}` : short(pos.mint);
			const up = Number(p.pnlPct) >= 0;
			const tx = txLink(p.sig, network);
			const sim = p.mode === 'simulate' ? ' <i>(sim)</i>' : '';
			send(token, chatId,
				`${up ? '🟩' : '🟥'} <b>SELL</b> · ${id}${tag(id)}${sim}\n`
				+ `${sym} · <b>${up ? '+' : ''}${num(p.pnlPct, 1)}%</b> (${up ? '+' : ''}${num(p.pnlSol)} SOL)\n`
				+ `${p.exitReason || ''}${tx ? ` · <a href="${tx}">tx</a>` : ''}`);
		},
	};

	let timer = null;
	function startSummary(sniper, store) {
		const tick = async () => {
			const s = (sniper.stats && sniper.stats()) || {};
			let open = 0;
			try { open = (store.listPositions ? await store.listPositions({ status: 'open' }) : []).length; } catch {}
			send(token, chatId,
				`📊 <b>Fleet</b> · ${s.strategies || 0} agents · ${network}\n`
				+ `Open ${open} · Buys ${s.buys || 0} · Sells ${s.sells || 0} · Errors ${s.errors || 0}\n`
				+ `Candidates seen: ${s.candidates || 0}`);
		};
		timer = setInterval(tick, summaryMs);
		tick();
	}
	function stop() { if (timer) clearInterval(timer); }
	async function announce(text) { await send(token, chatId, text); }

	return { hooks, startSummary, stop, announce, enabled: true };
}

export default createTelegramTracker;
