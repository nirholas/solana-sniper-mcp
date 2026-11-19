// The x402 HTTP API end to end: a real Express server on an ephemeral port, a
// simulate-mode engine with fake chain adapters, and a stubbed x402 facilitator
// (/verify, /settle). Nothing leaves the machine.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';

import { createSniperApi } from '../src/faces/api.js';
import { createSniper } from '../src/engine.js';
import { createMemoryStore } from '../src/adapters/store/memory.js';

const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const THREE = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const FACILITATOR = 'https://facilitator.test';
const BASE_NETWORK = 'eip155:8453';
const ADMIN = 'admin-token-for-tests';
const silentLog = { debug() {}, info() {}, warn() {}, error() {}, trade() {} };
const realFetch = globalThis.fetch;

let facilitator;
let server;
let base;
let sniper;
let store;

function stubFacilitator() {
	const state = { verify: 0, settle: 0, settleFails: false };
	globalThis.fetch = async (url, init) => {
		const u = String(url);
		if (!u.startsWith(FACILITATOR)) return realFetch(url, init);
		const body = JSON.parse(init.body);
		const payer = body.paymentPayload.payer;
		const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
		if (u.endsWith('/verify')) {
			state.verify++;
			return json({ isValid: true, payer });
		}
		if (u.endsWith('/settle')) {
			state.settle++;
			return state.settleFails ? json({ success: false, errorReason: 'insufficient_funds' }) : json({ success: true, payer, transaction: `tx_${state.settle}`, network: BASE_NETWORK });
		}
		return new Response('not found', { status: 404 });
	};
	return state;
}

let nonce = 0;
const payment = (payer) => Buffer.from(JSON.stringify({ x402Version: 2, network: BASE_NETWORK, payer, nonce: ++nonce })).toString('base64');

async function request(method, path, { body, headers = {} } = {}) {
	const res = await realFetch(`${base}${path}`, {
		method,
		headers: { 'content-type': 'application/json', ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let json;
	try { json = JSON.parse(text); } catch { json = text; }
	return { status: res.status, body: json, headers: res.headers };
}

const armBody = (over = {}) => ({ per_trade_sol: 0.1, daily_budget_sol: 1, stop_loss_pct: 30, ...over });

async function startApi({ mode = 'simulate', strategies = [], deps = {} } = {}) {
	store = createMemoryStore({ strategies });
	const kp = Keypair.generate();
	sniper = createSniper({
		config: mode === 'live'
			? { network: 'devnet', mode, confirmLive: true, rpcUrl: 'https://rpc.example.com/?api-key=SECRET123' }
			: { network: 'devnet', mode, rpcUrl: 'https://rpc.example.com/?api-key=SECRET123' },
		store,
		wallet: { loadKeypair: async () => ({ keypair: kp, address: kp.publicKey.toBase58() }) },
		solana: {
			connection: { getBalance: async () => 10_000_000_000 },
			quoteForBuy: async () => ({ priceImpactPct: 1, quoteMint: WSOL }),
			buildBuyInstructions: async () => ({ instructions: [], expectedBaseTokens: 1_000n }),
			quoteForSell: async () => ({ priceImpactPct: 1, expectedQuoteOut: 1n, quoteMint: WSOL }),
			buildSellInstructions: async () => ({ instructions: [], expectedQuoteOut: 1n }),
		},
		executor: { submit: async () => { throw new Error('tests never broadcast'); } },
		feed: { start: async () => () => {} },
		logger: silentLog,
	});
	await sniper.start();
	const app = await createSniperApi({
		sniper,
		payTo: { base: '0x1111111111111111111111111111111111111111' },
		facilitatorUrl: FACILITATOR,
		adminToken: ADMIN,
		...deps,
	});
	await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
	base = `http://127.0.0.1:${server.address().port}`;
}

const operatorStrategy = { id: 'op1', agent_id: 'operator', enabled: true, network: 'devnet', stop_loss_pct: 30, per_trade_lamports: '100000000', daily_budget_lamports: '1000000000' };
const payerStrategy = (payer) => ({ ...operatorStrategy, id: `own_${payer}`, agent_id: `x402:${payer}:default`, owner: `x402:${payer}` });

beforeEach(() => { facilitator = stubFacilitator(); });

afterEach(async () => {
	if (server) await new Promise((resolve) => server.close(resolve));
	await sniper?.stop({ timeoutMs: 1_000 });
	server = null;
	sniper = null;
	globalThis.fetch = realFetch;
});

describe('validation happens before the 402 challenge', () => {
	it('an invalid strategy gets a 400, not a payment request', async () => {
		await startApi();
		const res = await request('POST', '/strategies', { body: armBody({ stop_loss_pct: 0 }) });
		expect(res.status).toBe(400);
		expect(facilitator.verify).toBe(0);
	});

	it('a valid unpaid request gets the 402 challenge', async () => {
		await startApi();
		const res = await request('POST', '/strategies', { body: armBody() });
		expect(res.status).toBe(402);
		expect(res.headers.get('payment-required')).toBeTruthy();
	});

	it('an invalid mint gets a 400', async () => {
		await startApi();
		const res = await request('POST', '/snipe', { body: { mint: 'nope' } });
		expect(res.status).toBe(400);
	});
});

describe('paid POST /strategies', () => {
	it('arms a payer-owned strategy in the engine store and drops privileged fields', async () => {
		await startApi({ strategies: [operatorStrategy] });
		const res = await request('POST', '/strategies', {
			body: armBody({ id: 'op1', agent_id: 'operator', user_id: 'victim', kill_switch: false, owner: 'x402:someone-else' }),
			headers: { 'x-payment': payment('PAYER_A') },
		});
		expect(res.status).toBe(201);
		expect(res.headers.get('x-payment-response')).toBeTruthy();
		const s = res.body.strategy;
		expect(s.id).not.toBe('op1'); // cannot overwrite the operator's strategy
		expect(s.agent_id).toBe('x402:PAYER_A:operator'); // cannot borrow the operator's agent
		expect(s.owner).toBe('x402:PAYER_A');
		expect(s.user_id).toBeUndefined();
		expect(s.per_trade_lamports).toBe('100000000');
		expect(await store.getStrategy('op1')).toMatchObject({ agent_id: 'operator' });
		expect(await store.getStrategy(s.id)).toMatchObject({ owner: 'x402:PAYER_A' });
		expect(facilitator.settle).toBe(1);
	});

	it('the same payment cannot be used twice', async () => {
		await startApi();
		const header = payment('PAYER_A');
		const first = await request('POST', '/strategies', { body: armBody(), headers: { 'x-payment': header } });
		const second = await request('POST', '/strategies', { body: armBody(), headers: { 'x-payment': header } });
		expect(first.status).toBe(201);
		expect(second.status).toBe(409);
		expect(facilitator.settle).toBe(1);
	});

	it('rolls the strategy back when settlement fails, and the response still arrives', async () => {
		await startApi();
		facilitator.settleFails = true;
		const res = await request('POST', '/strategies', { body: armBody(), headers: { 'x-payment': payment('PAYER_A') } });
		expect(res.status).toBeGreaterThanOrEqual(500);
		expect(await store.getArmedStrategies('devnet')).toHaveLength(0);
	});

	it('in live mode paid callers cannot arm, and are refused before paying', async () => {
		await startApi({ mode: 'live' });
		const res = await request('POST', '/strategies', { body: armBody(), headers: { 'x-payment': payment('PAYER_A') } });
		expect(res.status).toBe(403);
		expect(res.body.code).toBe('paid_live_disabled');
		expect(facilitator.verify).toBe(0);
		const admin = await request('POST', '/strategies', { body: armBody({ agent_id: 'scout' }), headers: { 'x-admin-token': ADMIN } });
		expect(admin.status).toBe(201);
		expect(admin.body.strategy.agent_id).toBe('scout');
	});

	it('the operator can opt paid callers into live mode', async () => {
		await startApi({ mode: 'live', deps: { allowPaidLive: true } });
		const res = await request('POST', '/strategies', { body: armBody(), headers: { 'x-payment': payment('PAYER_A') } });
		expect(res.status).toBe(201);
	});
});

describe('paid ownership checks are never charged', () => {
	it('a payer cannot disarm the operator strategy', async () => {
		await startApi({ strategies: [operatorStrategy] });
		const res = await request('POST', '/strategies/op1/disarm', { headers: { 'x-payment': payment('PAYER_A') } });
		expect(res.status).toBe(403);
		expect(facilitator.settle).toBe(0);
		expect((await store.getStrategy('op1')).enabled).toBe(true);
	});

	it('a payer can disarm its own strategy', async () => {
		await startApi({ strategies: [payerStrategy('PAYER_A')] });
		const res = await request('POST', '/strategies/own_PAYER_A/disarm', { headers: { 'x-payment': payment('PAYER_A') } });
		expect(res.status).toBe(200);
		expect((await store.getStrategy('own_PAYER_A')).enabled).toBe(false);
		expect(facilitator.settle).toBe(1);
	});

	it('a paid snipe uses only the payer strategies', async () => {
		await startApi({ strategies: [operatorStrategy, payerStrategy('PAYER_A'), payerStrategy('PAYER_B')] });
		const res = await request('POST', '/snipe', { body: { mint: THREE }, headers: { 'x-payment': payment('PAYER_A') } });
		expect(res.status).toBe(202);
		expect(res.body.queued).toBe(1);
		await sniper.stop({ timeoutMs: 2_000 });
		const held = await store.listPositions({});
		expect(held.map((p) => p.agent_id)).toEqual(['x402:PAYER_A:default']);
	});

	it('a paid snipe with no owned strategy is refused and not charged', async () => {
		await startApi({ strategies: [operatorStrategy] });
		const res = await request('POST', '/snipe', { body: { mint: THREE }, headers: { 'x-payment': payment('PAYER_A') } });
		expect(res.status).toBe(409);
		expect(facilitator.settle).toBe(0);
	});

	it('a payer cannot close a position opened by the operator strategy', async () => {
		await startApi({ strategies: [operatorStrategy] });
		const pos = await store.claimPosition({ strategy: operatorStrategy, candidate: { mint: THREE }, network: 'devnet' });
		await store.updatePosition(pos.id, { status: 'open' });
		const res = await request('POST', `/positions/${pos.id}/close`, { headers: { 'x-payment': payment('PAYER_A') } });
		expect(res.status).toBe(403);
		expect((await store.getPosition(pos.id)).kill_switch).toBeUndefined();
		const admin = await request('POST', `/positions/${pos.id}/close`, { headers: { authorization: `Bearer ${ADMIN}` } });
		expect(admin.status).toBe(202);
	});

	it('closing an unknown position is a 404 before any payment', async () => {
		await startApi();
		const res = await request('POST', '/positions/pos_missing/close', { headers: { 'x-payment': payment('PAYER_A') } });
		expect(res.status).toBe(404);
		expect(facilitator.verify).toBe(0);
	});
});

describe('free reads and configuration', () => {
	it('/status does not leak the RPC API key', async () => {
		await startApi();
		const res = await request('GET', '/status');
		expect(res.status).toBe(200);
		expect(JSON.stringify(res.body)).not.toContain('SECRET123');
		expect(res.body.config.rpcUrl).toBe('https://rpc.example.com');
	});

	it('rejects a malformed price at startup', async () => {
		await expect(createSniperApi({ sniper: { config: { mode: 'simulate' } }, store: createMemoryStore(), prices: { snipe: '0.05' } }))
			.rejects.toThrow(/prices\.snipe/);
	});
});
