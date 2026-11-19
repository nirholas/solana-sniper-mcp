// agent-sniper — orchestrator.
//
// Wires a Feed → scorer → bounded buy queue, plus a position sweep on an
// interval, all over the injected adapters. createSniper() is the single public
// constructor: pass the adapters you want (or accept the defaults), call
// start(), get back a handle with stop() + introspection.

import { loadConfig } from './config.js';
import { log as defaultLog } from './log.js';
import { scoreMint, scoreIntel } from './scorer.js';
import { makeThrottle, makeQueue } from './guards.js';
import { executeBuy } from './executor.js';
import { runPositionSweep } from './positions.js';

/**
 * @param {object} deps
 * @param {Partial<ReturnType<typeof loadConfig>>} [deps.config]
 * @param {import('./types.js').Store} deps.store
 * @param {import('./types.js').Wallet} deps.wallet
 * @param {import('./types.js').SolanaClient} deps.solana
 * @param {import('./types.js').Executor} deps.executor
 * @param {import('./types.js').Feed} deps.feed
 * @param {import('./types.js').Hooks} [deps.hooks]
 * @param {Record<string, number>|null} [deps.intelWeights]
 * @param {typeof defaultLog} [deps.logger]
 */
export function createSniper(deps) {
	const cfg = loadConfig(deps.config || {});
	const log = deps.logger || defaultLog;

	// Ring buffer of recent screen events so any face (web console, API) can render
	// a live activity feed. Wrap the caller's onScreen (copied so we never mutate
	// their object) — this way events from the engine AND the executor/position
	// sweep are captured here, then forwarded on to whatever hook they passed.
	const ACTIVITY_CAP = 250;
	const activity = [];
	const hooks = { ...(deps.hooks || {}) };
	const callerOnScreen = hooks.onScreen;
	hooks.onScreen = (evt) => {
		if (evt && typeof evt.text === 'string') {
			activity.push({ at: Date.now(), text: evt.text, kind: evt.kind || 'info' });
			if (activity.length > ACTIVITY_CAP) activity.shift();
		}
		try { callerOnScreen?.(evt); } catch { /* best-effort */ }
	};

	const ports = { store: deps.store, wallet: deps.wallet, solana: deps.solana, executor: deps.executor, hooks, log };
	if (!ports.store || !ports.wallet || !ports.solana || !ports.executor || !deps.feed) {
		throw new Error('[agent-sniper] createSniper requires store, wallet, solana, executor, and feed adapters');
	}

	const throttle = makeThrottle(cfg.maxGlobalBuysPerMin);
	let strategies = [];
	let stopFeed = null;
	let sweepTimer = null;
	let refreshTimer = null;
	let draining = false;
	let lastEventAt = Date.now();
	const stats = { events: 0, candidates: 0, buys: 0, sells: 0, errors: 0 };

	const queue = makeQueue(cfg.buyConcurrency, cfg.buyQueueDepth, {
		onError: (err) => { stats.errors++; log.error('buy job crashed', { err: err?.message }); },
		onDrop: () => log.warn('buy queue full — dropping snipe'),
	});

	async function refreshStrategies() {
		try {
			strategies = await ports.store.getArmedStrategies(cfg.network);
		} catch (err) {
			log.error('strategy refresh failed', { err: err?.message });
		}
	}

	function screen(text, kind) { try { hooks.onScreen?.({ text, kind }); } catch { /* best-effort */ } }

	function enqueueBuy(strat, candidate) {
		return queue.push(async () => {
			const res = await executeBuy({ cfg, strat, candidate, throttle, ports });
			if (res?.status === 'open') stats.buys++;
		});
	}

	/** Armed strategies, optionally narrowed to one agent. */
	const targetStrategies = (agentId) => (agentId ? strategies.filter((s) => s.agent_id === agentId) : strategies);

	function onEvent({ kind, data }, targets = strategies) {
		lastEventAt = Date.now();
		stats.events++;
		if (draining || cfg.globalKill || typeof data?.mint !== 'string' || !data.mint) return 0;
		const sym = (data.symbol || data.mint.slice(0, 6)).toUpperCase();
		let queued = 0;

		for (const strat of targets) {
			const trig = strat.trigger || 'new_mint';
			// Route the event to strategies whose trigger matches its kind.
			if (kind === 'mint' && trig !== 'new_mint') continue;
			if (kind === 'intel' && trig !== 'intel_confirmed') continue;
			if (kind === 'claim' && trig !== 'first_claim') continue;
			if (!['mint', 'intel', 'claim'].includes(kind)) continue;

			const { pass, score, reasons } = trig === 'intel_confirmed'
				? scoreIntel(data, strat, deps.intelWeights || null)
				: scoreMint(data, strat);
			if (!pass) continue;

			stats.candidates++;
			log.info('candidate', { agent: strat.agent_id, mint: data.mint, symbol: data.symbol, score, reasons });
			screen(`$${sym} scored ${score} — BUYING`, 'trade');
			if (enqueueBuy(strat, data)) queued++;
		}
		return queued;
	}

	// One sweep at a time. setInterval keeps firing while a slow sweep (many
	// positions, a lagging RPC) is still running; overlapping sweeps would value
	// and exit the same positions twice.
	/** @type {Promise<void>|null} */
	let sweeping = null;
	function sweep() {
		if (!sweeping) {
			sweeping = runPositionSweep(cfg, ports).finally(() => { sweeping = null; });
		}
		return sweeping;
	}

	let started = false;

	return {
		config: cfg,
		/** The Store this engine reads and writes, so faces share one source of truth. */
		store: ports.store,
		stats: () => ({ ...stats, strategies: strategies.length, queued: queue.inFlight, lastEventAt }),
		strategies: () => strategies.slice(),
		/** Most-recent screen events (newest last), for a live activity feed. */
		activity: (limit = 50) => activity.slice(-Math.max(1, Math.min(Number(limit) || 50, ACTIVITY_CAP))),

		/** Start the feed, sweep and strategy refresh. Calling it again is a no-op. */
		async start() {
			if (started) return this;
			started = true;
			log.info('boot', { network: cfg.network, mode: cfg.mode, globalKill: cfg.globalKill, pollMs: cfg.pollMs });
			screen(`Sniper online — ${cfg.network} / ${cfg.mode} mode`, 'activity');
			await refreshStrategies();
			refreshTimer = setInterval(refreshStrategies, cfg.strategyRefreshMs);
			refreshTimer.unref?.();
			sweepTimer = setInterval(() => { sweep().catch((err) => log.error('sweep failed', { err: err?.message })); }, cfg.pollMs);
			sweepTimer.unref?.();
			stopFeed = await deps.feed.start(onEvent);
			return this;
		},

		/**
		 * Score + (queue) a single candidate by hand — drives the `manual` trigger /
		 * MCP snipe_now. `candidate.agent_id` narrows it to that agent's strategies,
		 * and `filter` narrows it further (the HTTP API uses it to restrict a paid
		 * snipe to the payer's own strategies); otherwise every armed strategy is
		 * considered. `force` skips the scorer (every pre-trade guard in executeBuy
		 * still applies). Returns how many buys were queued.
		 *
		 * @param {import('./types.js').Candidate & { agent_id?: string }} candidate
		 * @param {{ force?: boolean, filter?: (s: import('./types.js').Strategy) => boolean }} [opts]
		 * @returns {number}
		 */
		submitCandidate(candidate, { force = false, filter } = {}) {
			if (draining || cfg.globalKill || typeof candidate?.mint !== 'string' || !candidate.mint) return 0;
			const byAgent = targetStrategies(candidate.agent_id);
			const targets = typeof filter === 'function' ? byAgent.filter(filter) : byAgent;
			if (!force) {
				return onEvent({ kind: candidate.entry_trigger === 'intel_confirmed' ? 'intel' : 'mint', data: candidate }, targets);
			}
			let queued = 0;
			for (const strat of targets) if (enqueueBuy(strat, candidate)) queued++;
			return queued;
		},

		/**
		 * Stop taking new work, drop buys that have not started, and wait (up to
		 * `timeoutMs`) for in-flight buys and the current sweep to finish, so a
		 * shutdown never abandons a trade between broadcast and bookkeeping.
		 *
		 * @param {{ timeoutMs?: number }} [opts]
		 */
		async stop({ timeoutMs = 30_000 } = {}) {
			if (draining) return;
			draining = true;
			try { stopFeed?.(); } catch { /* feed already closed */ }
			if (sweepTimer) clearInterval(sweepTimer);
			if (refreshTimer) clearInterval(refreshTimer);
			const dropped = queue.clear();
			if (dropped) log.warn('shutdown: dropped queued buys that had not started', { dropped });

			let timer;
			const timedOut = await Promise.race([
				Promise.all([queue.idle(), sweeping || Promise.resolve()]).then(() => false),
				new Promise((resolve) => { timer = setTimeout(() => resolve(true), timeoutMs); timer.unref?.(); }),
			]);
			clearTimeout(timer);
			if (timedOut) log.warn('shutdown: timed out with work still in flight', { inFlight: queue.inFlight, sweeping: Boolean(sweeping) });
			log.info('shutdown', stats);
		},
	};
}
