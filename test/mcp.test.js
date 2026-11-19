// The MCP face over an in-memory transport, with a simulate-mode engine whose
// chain adapters are fakes. No network.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Keypair, PublicKey } from '@solana/web3.js';

import { createSniperMcpServer } from '../src/faces/mcp.js';
import { createSniper } from '../src/engine.js';
import { createMemoryStore } from '../src/adapters/store/memory.js';

const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const THREE = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const silentLog = { debug() {}, info() {}, warn() {}, error() {}, trade() {} };

let client;
let sniper;
let store;

async function call(name, args = {}) {
	const res = await client.callTool({ name, arguments: args });
	const text = res.content[0].text;
	let body;
	try { body = JSON.parse(text); } catch { body = text; } // schema errors are plain text
	return { isError: Boolean(res.isError), body };
}

const seeded = (id, agent) => ({
	id, agent_id: agent, enabled: true, network: 'devnet', stop_loss_pct: 30,
	per_trade_lamports: '100000000', daily_budget_lamports: '1000000000',
});

beforeEach(async () => {
	store = createMemoryStore({ strategies: [seeded('sa', 'alice'), seeded('sb', 'bob')] });
	const kp = Keypair.generate();
	sniper = createSniper({
		config: { network: 'devnet', mode: 'simulate', strategyRefreshMs: 5_000 },
		store,
		wallet: { loadKeypair: async () => ({ keypair: kp, address: kp.publicKey.toBase58() }) },
		solana: {
			connection: { getBalance: async () => 10_000_000_000 },
			quoteForBuy: async () => ({ priceImpactPct: 1, quoteMint: WSOL }),
			buildBuyInstructions: async () => ({ instructions: [], expectedBaseTokens: 1_000n }),
			quoteForSell: async () => ({ priceImpactPct: 1, expectedQuoteOut: 1n, quoteMint: WSOL }),
			buildSellInstructions: async () => ({ instructions: [], expectedQuoteOut: 1n }),
		},
		executor: { submit: async () => { throw new Error('simulate mode must not broadcast'); } },
		feed: { start: async () => () => {} },
		logger: silentLog,
	});
	await sniper.start();
	const server = await createSniperMcpServer({ sniper, store });
	const [a, b] = InMemoryTransport.createLinkedPair();
	client = new Client({ name: 'test', version: '0.0.0' });
	await Promise.all([server.connect(a), client.connect(b)]);
});

afterEach(async () => {
	await client.close();
	await sniper.stop({ timeoutMs: 1_000 });
});

describe('MCP arm_strategy', () => {
	it('stores an exact lamport row', async () => {
		const { isError, body } = await call('arm_strategy', { agentId: 'scout', per_trade_sol: 0.1, daily_budget_sol: 0.5, stop_loss_pct: 30 });
		expect(isError).toBe(false);
		expect(body.strategy.per_trade_lamports).toBe('100000000');
		expect(body.strategy.network).toBe('devnet');
	});

	it('rejects a zero stop-loss, an out-of-range slippage and per-trade above budget', async () => {
		for (const args of [
			{ agentId: 'scout', per_trade_sol: 0.1, daily_budget_sol: 1, stop_loss_pct: 0 },
			{ agentId: 'scout', per_trade_sol: 0.1, daily_budget_sol: 1, stop_loss_pct: 30, slippage_bps: 20_000 },
			{ agentId: 'scout', per_trade_sol: 2, daily_budget_sol: 1, stop_loss_pct: 30 },
			{ agentId: '../escape', per_trade_sol: 0.1, daily_budget_sol: 1, stop_loss_pct: 30 },
		]) {
			const { isError } = await call('arm_strategy', args);
			expect(isError, JSON.stringify(args)).toBe(true);
		}
		expect((await store.getArmedStrategies('devnet')).map((x) => x.id).sort()).toEqual(['sa', 'sb']);
	});
});

describe('MCP snipe_now', () => {
	it('rejects an invalid mint before anything is queued', async () => {
		const { isError } = await call('snipe_now', { mint: 'not-a-mint' });
		expect(isError).toBe(true);
	});

	it('honours agentId and reports how many buys were queued', async () => {
		const { isError, body } = await call('snipe_now', { mint: THREE, agentId: 'bob' });
		expect(isError).toBe(false);
		expect(body).toMatchObject({ ok: true, scheduled: true, queued: 1, agentId: 'bob' });
		await sniper.stop({ timeoutMs: 2_000 });
		const positions = await store.listPositions({});
		expect(positions.map((p) => p.agent_id)).toEqual(['bob']);
	});

	it('without agentId it queues one buy per armed strategy', async () => {
		const { body } = await call('snipe_now', { mint: THREE });
		expect(body.queued).toBe(2);
	});
});
