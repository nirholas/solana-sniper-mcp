// agent-sniper — HTTP API face (sniper-as-a-service).
//
// Exposes the engine over HTTP so other agents/users can pay to arm strategies
// and trigger snipes. Reads are free; the four MUTATING endpoints (arm, snipe,
// disarm, close) are gated behind x402 USDC micropayments via
// @three-ws/x402-server's `paid()` middleware — verify the X-PAYMENT header
// against the facilitator, run the work, settle on-chain, emit the receipt.
//
// Paid callers are untrusted, so the API, not the payer, decides what a paid
// request may touch:
//   - Input is validated (shared strategy schema, base58 mints) BEFORE the 402
//     challenge, so nobody is asked to pay for a request that cannot succeed.
//   - A paid request that is rejected after verification throws, which makes
//     paid() skip settlement: the payer is never charged for a refusal.
//   - Everything a payer creates is owned by that payer. Paid strategies live
//     under a payer-scoped agent id (x402:<payer>:<agent>), a paid snipe only
//     uses the payer's own strategies, and a payer can only disarm or close
//     what it owns. Operator strategies are reachable only with the admin token.
//   - The same X-PAYMENT header is processed once per process (replay guard),
//     an arm is idempotent per payment, and an arm whose settlement fails is
//     rolled back.
//   - In live mode paid callers cannot arm or snipe at all unless the operator
//     opts in with allowPaidLive / SNIPER_API_ALLOW_PAID_LIVE=yes, because every
//     paid strategy spends from wallets the operator holds.
//
//   import { createSniperApi, serve } from '@three-ws/agent-sniper/api';
//   await serve({ payTo: { solana: '<merchant>' } }, { port: 8787 });
//
// Zero three.ws backend imports — only local package files, express (optional),
// and the published @three-ws/x402-server SDK.

import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { paid } from '@three-ws/x402-server';
import { presets, createMemoryStore } from '../index.js';
import { buildStrategy, idSchema, mintSchema, strategyFieldShapes } from '../strategy-input.js';

// The web console is a single self-contained HTML file shipped with the package.
// Read it once, lazily, and cache it — a serve() that never gets a browser hit
// pays nothing; one that does serves from memory.
const CONSOLE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'console.html');
let _consoleHtml = null;
function consoleHtml() {
	if (_consoleHtml == null) {
		try { _consoleHtml = readFileSync(CONSOLE_PATH, 'utf8'); }
		catch { _consoleHtml = ''; }
	}
	return _consoleHtml;
}

// Constant-time string compare for the admin token — avoids leaking length/prefix
// through response timing.
function safeEqual(a, b) {
	const ab = Buffer.from(String(a));
	const bb = Buffer.from(String(b));
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

// Default per-endpoint prices in USDC atomic units (6 decimals): 10000 = $0.01,
// 50000 = $0.05, 5000 = $0.005. Overridable via deps.prices.
const DEFAULT_PRICES = {
	arm: '10000',     // POST /strategies      → $0.01
	snipe: '50000',   // POST /snipe           → $0.05
	disarm: '5000',   // POST /strategies/:id/disarm → $0.005
	close: '5000',    // POST /positions/:id/close   → $0.005
};

// How long a processed X-PAYMENT header is remembered, and how many are kept.
const REPLAY_TTL_MS = 60 * 60_000;
const REPLAY_MAX_ENTRIES = 50_000;

/**
 * Lazily resolve express (an optional dependency). A deployment that never
 * mounts the HTTP face shouldn't have to install it; one that does gets a clear
 * instruction instead of an opaque module-not-found.
 */
async function loadExpress() {
	try {
		const mod = await import('express');
		return mod.default || mod;
	} catch {
		throw new Error('express is required for the HTTP API face — install it');
	}
}

/** An error carrying an HTTP status; paid() and the error handler both honour it. */
function httpError(status, message, code = 'request_rejected') {
	return Object.assign(new Error(message), { status, code });
}

// POST /strategies body: every caller-settable strategy field, plus the agent
// and strategy ids. Unknown keys (user_id, kill_switch, owner, ...) are dropped.
const armBodySchema = z.object({
	...strategyFieldShapes,
	per_trade_sol: z.coerce.number().pipe(strategyFieldShapes.per_trade_sol),
	daily_budget_sol: z.coerce.number().pipe(strategyFieldShapes.daily_budget_sol),
	agent_id: idSchema.optional(),
	id: idSchema.optional(),
	enabled: z.boolean().optional(),
});

const snipeBodySchema = z.object({
	mint: mintSchema,
	symbol: z.string().max(32).optional(),
	agentId: idSchema.optional(),
});

/** Zod issues as one readable line. */
function describeIssues(error) {
	return error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
}

function parseBody(schema, body) {
	const res = schema.safeParse(body ?? {});
	if (!res.success) throw httpError(400, describeIssues(res.error), 'invalid_input');
	return res.data;
}

const ownerKey = (payer) => `x402:${payer}`;
const paidAgentId = (payer, agentId) => `${ownerKey(payer)}:${agentId || 'default'}`;

/**
 * Remembers X-PAYMENT headers that are being processed or were settled, so a
 * payment cannot buy the same work twice in this process. Facilitators reject a
 * reused authorization at settlement, but the work would already have run.
 */
function createReplayGuard({ ttlMs = REPLAY_TTL_MS, maxEntries = REPLAY_MAX_ENTRIES } = {}) {
	/** @type {Map<string, number>} hash → expiry (ms) */
	const seen = new Map();
	const prune = (now) => {
		for (const [k, exp] of seen) {
			if (exp > now && seen.size <= maxEntries) break; // insertion order ≈ expiry order
			seen.delete(k);
		}
	};
	return {
		/** @returns {boolean} false when this payment was already used */
		begin(hash) {
			const now = Date.now();
			prune(now);
			const exp = seen.get(hash);
			if (exp && exp > now) return false;
			seen.set(hash, now + ttlMs);
			return true;
		},
		release(hash) { seen.delete(hash); },
	};
}

/** Redact credentials from an RPC URL before it is shown on a free endpoint. */
function redactUrl(raw) {
	if (!raw) return raw;
	try {
		const u = new URL(raw);
		return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : '/…'}`;
	} catch {
		return '[redacted]';
	}
}

/**
 * Build the Express router that mounts every sniper endpoint. Free reads mount
 * directly; the mutating routes are wrapped in `paid()` when payTo is
 * configured, or a 503 guard when it is not (so the server still boots for
 * local/dev without payment config).
 *
 * @param {object} deps
 * @param {ReturnType<import('../engine.js').createSniper>} [deps.sniper]  started/unstarted handle; built from presets.local when omitted.
 * @param {import('../types.js').Store & { addStrategy?: Function, removeStrategy?: Function, getStrategy?: Function, listPositions?: Function }} [deps.store]  defaults to the sniper's own store.
 * @param {{ solana?: string, base?: string }} [deps.payTo]  merchant wallet(s); env fallback X402_PAY_TO_SOLANA / X402_PAY_TO_BASE.
 * @param {Record<string,string>} [deps.prices]  per-endpoint USDC atomic prices ({ arm, snipe, disarm, close }).
 * @param {string} [deps.facilitatorUrl]  x402 facilitator base URL for /verify + /settle.
 * @param {string} [deps.feePayer]  Solana facilitator sponsor fee-payer; env fallback X402_FEE_PAYER_SOLANA. The Solana lane self-disables without it.
 * @param {string} [deps.adminToken]  operator token; env fallback SNIPER_ADMIN_TOKEN. A request carrying it (Authorization: Bearer / X-Admin-Token) bypasses x402 — the owner's own console mutates free while external agents still pay.
 * @param {boolean} [deps.allowPaidLive]  let paid callers arm and snipe in live mode (spending the operator's wallets); env fallback SNIPER_API_ALLOW_PAID_LIVE=yes. Off by default.
 */
export async function createSniperApiRouter(deps = {}) {
	const express = await loadExpress();

	const sniper = deps.sniper || (await presets.local());
	// One store for the engine and the API: a strategy armed here must be the one
	// the engine evaluates, and /positions must list the engine's positions.
	const store = deps.store || sniper.store || createMemoryStore();

	const payTo = {
		solana: deps.payTo?.solana || process.env.X402_PAY_TO_SOLANA || null,
		base: deps.payTo?.base || process.env.X402_PAY_TO_BASE || null,
	};
	// PayAI's Solana facilitator rejects an accept without a sponsor fee-payer, and
	// paid() throws a 500 at challenge time if asked to advertise a Solana lane it
	// can't honor. Resolve the fee-payer first so we can actually self-disable the
	// Solana lane when it's absent — dropping to the Base lane (or the 503 guard)
	// instead of 500-ing every paid request.
	const feePayer = deps.feePayer || process.env.X402_FEE_PAYER_SOLANA || undefined;

	const lanes = {};
	if (payTo.solana && feePayer) {
		lanes.solana = payTo.solana;
	} else if (payTo.solana && !feePayer) {
		console.warn(
			'[agent-sniper] X402_PAY_TO_SOLANA is set but X402_FEE_PAYER_SOLANA is not — ' +
			'the Solana lane needs a facilitator sponsor fee-payer and has been disabled. ' +
			'Set X402_FEE_PAYER_SOLANA to enable it; the Base lane (if configured) is unaffected.',
		);
	}
	if (payTo.base) lanes.base = payTo.base;
	const x402Configured = Object.keys(lanes).length > 0;

	const prices = { ...DEFAULT_PRICES, ...(deps.prices || {}) };
	for (const [key, value] of Object.entries(prices)) {
		// Atomic USDC units: a positive integer string. A price of "0", "0.01" or
		// a number would advertise a challenge the facilitator settles wrongly.
		if (typeof value !== 'string' || !/^[1-9]\d{0,17}$/.test(value)) {
			throw new Error(`[agent-sniper] prices.${key} must be a positive integer string of USDC atomic units, got ${JSON.stringify(value)}`);
		}
	}
	const facilitator = deps.facilitatorUrl || process.env.X402_FACILITATOR_URL || undefined;
	const live = sniper.config.mode === 'live';
	const allowPaidLive = deps.allowPaidLive ?? process.env.SNIPER_API_ALLOW_PAID_LIVE === 'yes';
	const replay = createReplayGuard();

	// Operator token. When set, a request presenting it bypasses the x402 gate —
	// the owner's own web console can arm/snipe/disarm without paying itself, while
	// unauthenticated external agents still hit the paid path.
	const adminToken = deps.adminToken || process.env.SNIPER_ADMIN_TOKEN || null;
	const isAdmin = (req) => {
		if (!adminToken) return false;
		const auth = req.headers.authorization;
		const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
		const hdr = typeof req.headers['x-admin-token'] === 'string' ? req.headers['x-admin-token'].trim() : null;
		const provided = bearer || hdr;
		return Boolean(provided) && safeEqual(provided, adminToken);
	};

	const router = express.Router();
	router.use(express.json({ limit: '64kb' }));

	// Permissive CORS so any agent/browser can call the service; preflight is
	// answered here before any route runs.
	router.use((req, res, next) => {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-PAYMENT, Authorization, X-Admin-Token');
		res.setHeader('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED, X-PAYMENT-RESPONSE');
		if (req.method === 'OPTIONS') return res.status(204).end();
		return next();
	});

	/**
	 * Wrap a mutating route. Per request:
	 *   1. `validate(req, { admin })` runs first for everyone and returns the
	 *      parsed input or throws an httpError, so a bad request gets its 4xx
	 *      before any 402 challenge.
	 *   2. admin token → `handler(req, res, { admin: true, input })` directly;
	 *   3. x402 configured → paid(); the handler gets `{ payer, paymentHash,
	 *      input }`. A throw inside it makes paid() skip settlement;
	 *   4. neither → 503.
	 * `onUnsettled(req)` undoes the work when a paid request ends without a
	 * settled payment (e.g. the facilitator's /settle fails after the work ran).
	 *
	 * @param {keyof typeof DEFAULT_PRICES} priceKey
	 * @param {{
	 *   validate: (req: any, ctx: { admin: boolean }) => unknown,
	 *   handler: (req: any, res: any, ctx: { admin?: boolean, payer?: string, paymentHash?: string, input: any }) => Promise<unknown>,
	 *   onUnsettled?: (req: any) => Promise<void>,
	 * }} route
	 */
	function gate(priceKey, { validate, handler, onUnsettled }) {
		const paidPath = x402Configured
			? paid(
				{
					price: prices[priceKey],
					asset: 'usdc',
					payTo: lanes,
					facilitator,
					feePayer,
					description: 'agent-sniper paid endpoint',
					serviceName: 'agent-sniper',
				},
				// Errors propagate on purpose: paid() then skips settlement and
				// answers with the error's status, so a refusal is never charged.
				async (req, res, payment) => {
					if (!payment?.payer) throw httpError(402, 'the facilitator did not identify the payer', 'payer_unknown');
					return handler(req, res, { payer: String(payment.payer), paymentHash: req._paymentHash, input: req._input });
				},
			)
			: null;

		return async (req, res, next) => {
			try {
				const admin = isAdmin(req);
				req._input = await validate(req, { admin });
				if (admin) return await handler(req, res, { admin: true, input: req._input });
				if (!paidPath) {
					return res.status(503).json({
						error: adminToken
							? 'payment required: send the admin token (Authorization: Bearer / X-Admin-Token) or configure x402 (X402_PAY_TO_SOLANA).'
							: 'x402 not configured: set payTo.solana or X402_PAY_TO_SOLANA (or SNIPER_ADMIN_TOKEN for an operator console).',
					});
				}

				const header = req.headers['x-payment'];
				if (typeof header !== 'string' || !header) return await paidPath(req, res);
				const hash = createHash('sha256').update(header).digest('hex');
				if (!replay.begin(hash)) throw httpError(409, 'this payment has already been used', 'payment_replayed');
				req._paymentHash = hash;
				let settled = false;
				// paid() buffers the response by swapping these methods; if /settle
				// throws it never swaps them back, and the error response would sit
				// in the buffer forever.
				const original = { write: res.write, end: res.end, writeHead: res.writeHead };
				try {
					await paidPath(req, res);
					settled = res.statusCode < 400 && Boolean(res.getHeader('X-PAYMENT-RESPONSE'));
				} catch (err) {
					Object.assign(res, original);
					throw err;
				} finally {
					if (!settled) {
						replay.release(hash);
						try { await onUnsettled?.(req); } catch { /* rollback is best-effort */ }
					}
				}
			} catch (err) {
				next(err);
			}
		};
	}

	/** Refuse paid spending in live mode unless the operator opted in. */
	function assertPaidSpendingAllowed(admin) {
		if (!admin && live && !allowPaidLive) {
			throw httpError(403, 'this sniper trades live funds; paid callers cannot arm or snipe (operator: set allowPaidLive / SNIPER_API_ALLOW_PAID_LIVE=yes to allow it)', 'paid_live_disabled');
		}
	}

	async function findStrategy(id) {
		if (typeof store.getStrategy === 'function') return store.getStrategy(id);
		return sniper.strategies().find((s) => s.id === id) || null;
	}

	async function findPosition(id) {
		if (typeof store.getPosition === 'function') return store.getPosition(id);
		if (typeof store.listPositions !== 'function') return null;
		return (await store.listPositions({ network: sniper.config.network })).find((p) => p.id === id) || null;
	}

	function assertOwner(ctx, owner, what) {
		if (ctx.admin) return;
		if (!owner || owner !== ownerKey(ctx.payer)) throw httpError(403, `this ${what} belongs to another account`, 'not_owner');
	}

	// ── Web console ───────────────────────────────────────────────────────────────
	// The operator dashboard, served from the same origin as the API it drives.
	// GET / and GET /console both return it; every fetch it makes is same-origin.
	const serveConsole = (req, res) => {
		const html = consoleHtml();
		if (!html) return res.status(404).json({ error: 'web console asset not found' });
		res.setHeader('Content-Type', 'text/html; charset=utf-8');
		res.setHeader('Cache-Control', 'no-cache');
		return res.send(html);
	};
	router.get('/', serveConsole);
	router.get('/console', serveConsole);

	// ── Free reads ──────────────────────────────────────────────────────────────

	// What the console needs to render the right controls: is there a paid lane,
	// and is an operator token configured (so mutations are reachable at all).
	const capabilities = () => ({ paid: x402Configured, adminAuth: Boolean(adminToken), prices, paidLive: live && allowPaidLive });

	// GET /health — liveness + a snapshot of network/mode/stats.
	router.get('/health', (req, res) => {
		res.json({
			ok: true,
			network: sniper.config.network,
			mode: sniper.config.mode,
			stats: sniper.stats(),
			capabilities: capabilities(),
		});
	});

	// GET /status — full stats plus the runtime config. The RPC URL often embeds
	// a provider API key, so only its origin is shown on this free endpoint.
	router.get('/status', (req, res) => {
		res.json({
			stats: sniper.stats(),
			config: { ...sniper.config, rpcUrl: redactUrl(sniper.config.rpcUrl) },
			capabilities: capabilities(),
		});
	});

	// GET /activity?limit= — recent engine screen events (newest last) for the feed.
	router.get('/activity', (req, res) => {
		const limit = Math.max(1, Math.min(Number(req.query.limit) || 60, 250));
		const events = typeof sniper.activity === 'function' ? sniper.activity(limit) : [];
		res.json({ events });
	});

	// GET /strategies — the armed strategy set the engine is evaluating.
	router.get('/strategies', (req, res) => {
		res.json({ strategies: sniper.strategies() });
	});

	// GET /positions?agentId=&status= — list positions from the store.
	router.get('/positions', (req, res, next) => {
		const query = {};
		if (typeof req.query.agentId === 'string') query.agentId = req.query.agentId;
		if (typeof req.query.status === 'string') query.status = req.query.status;
		Promise.resolve(
			typeof store.listPositions === 'function'
				? store.listPositions(query)
				: [],
		)
			.then((positions) => res.json({ positions }))
			.catch(next);
	});

	// ── Paid mutations ───────────────────────────────────────────────────────────

	// POST /strategies — arm a strategy. SOL budgets convert to lamports; a
	// stop-loss is mandatory. Paid callers get a payer-scoped agent id and a
	// strategy id derived from the payment (so a replayed request upserts the
	// same row); the admin may choose both and update existing strategies.
	router.post('/strategies', gate('arm', {
		validate: (req, { admin }) => {
			if (typeof store.addStrategy !== 'function') throw httpError(501, 'store does not support arming strategies');
			const input = parseBody(armBodySchema, req.body);
			assertPaidSpendingAllowed(admin);
			// Build once with placeholder ids so every row-level problem is a 400
			// before the caller is asked to pay.
			buildStrategy(input, { id: 'validate', agentId: 'validate', network: sniper.config.network });
			return input;
		},
		handler: async (req, res, ctx) => {
			const { input } = ctx;
			const strategy = ctx.admin
				? buildStrategy(input, {
					id: input.id || `strat_${randomUUID()}`,
					agentId: input.agent_id || `agent_${randomUUID().slice(0, 8)}`,
					network: sniper.config.network,
					extra: { enabled: input.enabled !== false },
				})
				: buildStrategy(input, {
					id: `strat_x402_${ctx.paymentHash.slice(0, 24)}`,
					agentId: paidAgentId(ctx.payer, input.agent_id),
					network: sniper.config.network,
					extra: { enabled: input.enabled !== false, owner: ownerKey(ctx.payer) },
				});
			req._armedStrategyId = ctx.admin ? null : strategy.id;
			const stored = (await store.addStrategy(strategy)) || strategy;
			return res.status(201).json({ strategy: stored });
		},
		onUnsettled: async (req) => {
			if (req._armedStrategyId && typeof store.removeStrategy === 'function') await store.removeStrategy(req._armedStrategyId);
		},
	}));

	// POST /snipe — force a snipe on { mint, symbol?, agentId? }. Bypasses the
	// scorer (every pre-trade guard still applies). A paid snipe only uses the
	// payer's own strategies; the admin may target any agent, or all of them.
	router.post('/snipe', gate('snipe', {
		validate: (req, { admin }) => {
			const input = parseBody(snipeBodySchema, req.body);
			assertPaidSpendingAllowed(admin);
			return input;
		},
		handler: async (req, res, ctx) => {
			const { input } = ctx;
			const candidate = { mint: input.mint, entry_trigger: 'manual' };
			if (input.symbol) candidate.symbol = input.symbol;
			let filter;
			if (ctx.admin) {
				if (input.agentId) candidate.agent_id = input.agentId;
			} else {
				const owner = ownerKey(ctx.payer);
				const agent = input.agentId ? paidAgentId(ctx.payer, input.agentId) : null;
				filter = (s) => s.owner === owner && (!agent || s.agent_id === agent);
			}
			const queued = sniper.submitCandidate(candidate, { force: true, filter });
			if (!queued) {
				throw httpError(409, ctx.admin
					? 'no armed strategy matched (or the engine is stopped / kill-switched)'
					: 'no armed strategy owned by this payer matched; arm one first (new strategies are picked up on the next refresh)', 'nothing_to_snipe');
			}
			return res.status(202).json({ ok: true, queued, mint: input.mint });
		},
	}));

	// POST /strategies/:id/disarm — flip a strategy off (enabled=false). The
	// engine drops it on the next strategy-cache refresh.
	router.post('/strategies/:id/disarm', gate('disarm', {
		validate: async (req) => {
			const id = parseBody(idSchema, req.params.id);
			if (typeof store.addStrategy !== 'function') throw httpError(501, 'store does not support disarming strategies');
			const strategy = await findStrategy(id);
			if (!strategy) throw httpError(404, 'strategy not found', 'not_found');
			return { id, strategy };
		},
		handler: async (req, res, ctx) => {
			const { id, strategy } = ctx.input;
			assertOwner(ctx, strategy.owner, 'strategy');
			if (typeof store.disableStrategy === 'function') await store.disableStrategy(id);
			else await store.addStrategy({ ...strategy, enabled: false });
			return res.status(200).json({ ok: true, id, enabled: false });
		},
	}));

	// POST /positions/:id/close — schedule an exit. Flips the position's kill switch;
	// the next position sweep sells it through the normal exit path (same as the MCP
	// close_position tool), so the response is { scheduled: true } — the sell lands shortly.
	router.post('/positions/:id/close', gate('close', {
		validate: async (req) => {
			const id = parseBody(idSchema, req.params.id);
			if (typeof store.updatePosition !== 'function') throw httpError(501, 'store does not support closing positions');
			const pos = await findPosition(id);
			if (!pos || pos.network !== sniper.config.network) throw httpError(404, 'position not found', 'not_found');
			if (pos.status === 'closed' || pos.status === 'failed') throw httpError(409, `position is already ${pos.status}`, 'position_terminal');
			return { id, pos };
		},
		handler: async (req, res, ctx) => {
			const { id, pos } = ctx.input;
			if (!ctx.admin) {
				const strategy = pos.strategy_id ? await findStrategy(pos.strategy_id) : null;
				assertOwner(ctx, strategy?.owner, 'position');
			}
			await store.updatePosition(id, { kill_switch: true });
			return res.status(202).json({ ok: true, scheduled: true, id });
		},
	}));

	return router;
}

/**
 * Build a complete Express app exposing the sniper API. Mounts the router at the
 * root and attaches a JSON error handler.
 *
 * @param {Parameters<typeof createSniperApiRouter>[0]} [deps]
 */
export async function createSniperApi(deps = {}) {
	const express = await loadExpress();
	const app = express();
	app.disable('x-powered-by');

	const router = await createSniperApiRouter(deps);
	app.use(router);

	// 404 for anything unmatched.
	app.use((req, res) => {
		res.status(404).json({ error: 'not found' });
	});

	// Boundary error handler: 4xx carry their message; 5xx are logged and
	// answered generically so internals do not leak to callers.
	// Express identifies error handlers by arity, so `next` must stay declared.
	app.use((err, req, res, _next) => {
		const status = Number(err?.status) >= 400 && Number(err?.status) < 600 ? Number(err.status) : 500;
		if (status >= 500) console.error('[agent-sniper] request failed:', err?.message || err);
		if (!res.headersSent) {
			res.status(status).json(status >= 500
				? { error: 'internal error', code: err?.code || 'internal_error' }
				: { error: err?.message || 'bad request', code: err?.code || 'request_rejected' });
		}
	});

	// Stash the resolved handle so serve() can start it without rebuilding.
	app.locals.sniper = deps.sniper;
	return app;
}

/**
 * Build the app, start the sniper (idempotent), and listen.
 *
 * @param {Parameters<typeof createSniperApiRouter>[0] & { port?: number }} [deps]
 * @param {object} [opts]
 * @param {number} [opts.port]  default deps.port, then $PORT, then 8787
 */
export async function serve(deps = {}, { port = Number(deps.port) || Number(process.env.PORT) || 8787 } = {}) {
	// Resolve the sniper once so the API and the start() call share one handle.
	const sniper = deps.sniper || (await presets.local());
	const app = await createSniperApi({ ...deps, sniper });
	await sniper.start();

	return await new Promise((resolve, reject) => {
		const server = app.listen(port, () => {
			console.log(`[agent-sniper] HTTP API + console on http://localhost:${port}  (${sniper.config.network}/${sniper.config.mode})`);
			resolve({ app, server, sniper });
		});
		server.once('error', reject);
	});
}

// Runnable as an entry point: `node src/faces/api.js`. The pathToFileURL compare
// is the ESM equivalent of `require.main === module` — true only when this file
// is the process entry, not when it's imported.
const isProcessEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isProcessEntryPoint) {
	serve().catch((err) => {
		console.error(`[agent-sniper] failed to start HTTP API: ${err?.message || err}`);
		process.exitCode = 1;
	});
}

export default { createSniperApi, createSniperApiRouter, serve };
