// executeBuy / executeSell against the in-memory store and mocked chain
// adapters. No network: the SolanaClient, Wallet and Executor are fakes, so
// these tests pin the guard ordering, the per-agent lock and the ledger writes.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';

import { executeBuy, executeSell, pendingAgentLocks } from '../src/executor.js';
import { createMemoryStore } from '../src/adapters/store/memory.js';
import { createSniper } from '../src/engine.js';
import { loadConfig } from '../src/config.js';

const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const THREE = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const mints = (n) => Array.from({ length: n }, () => Keypair.generate().publicKey.toBase58());

const silentLog = { debug() {}, info() {}, warn() {}, error() {}, trade() {} };

function strategy(over = {}) {
	return {
		id: 'strat_1',
		agent_id: 'agent_1',
		enabled: true,
		network: 'devnet',
		per_trade_lamports: '100000000', // 0.1 SOL
		daily_budget_lamports: '300000000', // 0.3 SOL
		max_concurrent_positions: 50,
		stop_loss_pct: 30,
		max_price_impact_pct: 10,
		...over,
	};
}

function fakeSolana(over = {}) {
	const calls = { quoteForBuy: 0, buildBuy: 0, quoteForSell: 0, buildSell: 0 };
	const solana = {
		connection: { getBalance: async () => 10_000_000_000 },
		async quoteForBuy() {
			calls.quoteForBuy++;
			await Promise.resolve();
			return { priceImpactPct: 1, quoteMint: WSOL };
		},
		async buildBuyInstructions() {
			calls.buildBuy++;
			return { instructions: [], expectedBaseTokens: 1_000_000n };
		},
		async quoteForSell() {
			calls.quoteForSell++;
			return { priceImpactPct: 1, expectedQuoteOut: 120_000_000n, quoteMint: WSOL };
		},
		async buildSellInstructions() {
			calls.buildSell++;
			return { instructions: [], expectedQuoteOut: 120_000_000n };
		},
		...over,
	};
	return { solana, calls };
}

function ports({ store = createMemoryStore(), solana = fakeSolana().solana, executor, hooks = {} } = {}) {
	const kp = Keypair.generate();
	return {
		store,
		wallet: { loadKeypair: async () => ({ keypair: kp, address: kp.publicKey.toBase58() }) },
		solana,
		executor: executor || { submit: vi.fn(async () => ({ signature: 'sig_live', route: 'standard' })) },
		hooks,
		log: silentLog,
	};
}

const simCfg = () => loadConfig({ network: 'devnet', mode: 'simulate' });
const openThrottle = { tryConsume: () => true };

afterEach(() => {
	vi.useRealTimers();
});

describe('executeBuy — per-agent serialization', () => {
	it('concurrent buys never overspend the daily budget', async () => {
		const p = ports();
		const strat = strategy(); // budget covers exactly 3 trades
		const results = await Promise.all(
			mints(8).map((mint) => executeBuy({ cfg: simCfg(), strat, candidate: { mint }, throttle: openThrottle, ports: p })),
		);
		const opened = results.filter((r) => r.status === 'open');
		expect(opened).toHaveLength(3);
		expect(results.filter((r) => r.reason === 'daily_budget_exceeded')).toHaveLength(5);
		expect(await p.store.getDailySpendLamports('agent_1', 'devnet')).toBe(300_000_000n);
	});

	it('concurrent buys never exceed max_concurrent_positions', async () => {
		const p = ports();
		const strat = strategy({ daily_budget_lamports: '10000000000', max_concurrent_positions: 2 });
		const results = await Promise.all(
			mints(6).map((mint) => executeBuy({ cfg: simCfg(), strat, candidate: { mint }, throttle: openThrottle, ports: p })),
		);
		expect(results.filter((r) => r.status === 'open')).toHaveLength(2);
		expect(results.filter((r) => r.reason === 'max_concurrency')).toHaveLength(4);
	});

	it('the same mint is bought once even when submitted concurrently', async () => {
		const p = ports();
		const strat = strategy({ daily_budget_lamports: '10000000000' });
		const results = await Promise.all(
			[1, 2, 3].map(() => executeBuy({ cfg: simCfg(), strat, candidate: { mint: THREE }, throttle: openThrottle, ports: p })),
		);
		expect(results.filter((r) => r.status === 'open')).toHaveLength(1);
		expect(results.filter((r) => r.reason === 'already_held')).toHaveLength(2);
	});

	it('releases every per-agent lock once the work is done', async () => {
		const p = ports();
		await Promise.all(
			['a', 'b', 'c'].map((agent) =>
				executeBuy({ cfg: simCfg(), strat: strategy({ agent_id: agent }), candidate: { mint: THREE }, throttle: openThrottle, ports: p }),
			),
		);
		expect(pendingAgentLocks()).toBe(0);
	});
});

describe('executeSell — stale snapshots', () => {
	async function openPosition(p) {
		const res = await executeBuy({ cfg: simCfg(), strat: strategy(), candidate: { mint: THREE }, throttle: openThrottle, ports: p });
		expect(res.status).toBe('open');
		return p.store.getPosition(res.posId);
	}

	it('two sells racing on the same snapshot close the position once', async () => {
		const { solana, calls } = fakeSolana();
		const p = ports({ solana });
		const snapshot = await openPosition(p);
		const results = await Promise.all([
			executeSell({ cfg: simCfg(), position: snapshot, reason: 'kill_switch', ports: p }),
			executeSell({ cfg: simCfg(), position: snapshot, reason: 'take_profit', ports: p }),
		]);
		expect(results.map((r) => r.status).sort()).toEqual(['closed', 'skip']);
		expect(calls.buildSell).toBe(1);
		expect((await p.store.getPosition(snapshot.id)).status).toBe('closed');
	});

	it('a partial exit sizes itself from the remaining bag, not the snapshot', async () => {
		const p = ports();
		const snapshot = await openPosition(p);
		await executeSell({ cfg: simCfg(), position: snapshot, reason: 'take_initials', ports: p, fraction: 0.5, recoversInitials: true });
		const afterFirst = await p.store.getPosition(snapshot.id);
		expect(BigInt(afterFirst.base_amount)).toBe(500_000n);

		// A second ladder decision computed from the stale snapshot must not sell
		// half of the original 1,000,000 again.
		await executeSell({ cfg: simCfg(), position: snapshot, reason: 'take_initials', ports: p, fraction: 0.5 });
		expect(BigInt((await p.store.getPosition(snapshot.id)).base_amount)).toBe(250_000n);
	});
});

describe('engine — position sweep', () => {
	it('does not start a new sweep while the previous one is still running', async () => {
		vi.useFakeTimers();
		const store = createMemoryStore();
		let quoteCalls = 0;
		const { solana } = fakeSolana({
			quoteForSell: () => {
				quoteCalls++;
				return new Promise(() => {}); // a hung RPC
			},
		});
		const p = ports({ store, solana });
		const claimed = await store.claimPosition({ strategy: strategy(), candidate: { mint: THREE }, network: 'devnet' });
		await store.updatePosition(claimed.id, { status: 'open', base_amount: '1000', entry_quote_lamports: '100000000' });

		const sniper = createSniper({
			config: { network: 'devnet', mode: 'simulate', pollMs: 1000 },
			store,
			wallet: p.wallet,
			solana,
			executor: p.executor,
			feed: { start: async () => () => {} },
			logger: silentLog,
		});
		await sniper.start();
		await vi.advanceTimersByTimeAsync(5_500);
		expect(quoteCalls).toBe(1);
		vi.useRealTimers();
		await sniper.stop({ timeoutMs: 10 });
	});
});
