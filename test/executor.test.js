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

describe('executeBuy — live landing outcomes', () => {
	const liveCfg = () => loadConfig({ network: 'devnet', mode: 'live', rpcUrl: 'http://127.0.0.1:8899', confirmLive: true });

	it('an ambiguous landing keeps the slot held and counts the spend', async () => {
		const executor = {
			submit: vi.fn(async () => {
				throw Object.assign(new Error('landing ambiguous'), { code: 'landing_ambiguous', sentSignatures: ['sigA', 'sigB'] });
			}),
		};
		const p = ports({ executor });
		const strat = strategy();
		const res = await executeBuy({ cfg: liveCfg(), strat, candidate: { mint: THREE }, throttle: openThrottle, ports: p });
		expect(res).toMatchObject({ status: 'unknown', reason: 'landing_unknown', signatures: ['sigA', 'sigB'] });

		const pos = await p.store.getPosition(res.posId);
		expect(pos.status).toBe('opening');
		expect(pos.buy_sig).toBe('sigA');
		expect(pos.error).toMatch(/landing_unknown/);
		expect(await p.store.getDailySpendLamports('agent_1', 'devnet')).toBe(100_000_000n);
		expect(await p.store.countOpenPositions('agent_1', 'devnet')).toBe(1);

		// The same coin must not be bought again while its first buy is unresolved.
		const again = await executeBuy({ cfg: liveCfg(), strat, candidate: { mint: THREE }, throttle: openThrottle, ports: p });
		expect(again.reason).toBe('already_held');
		expect(executor.submit).toHaveBeenCalledTimes(1);
	});

	it('a definitive on-chain failure frees the slot and spends nothing', async () => {
		let n = 0;
		const executor = {
			submit: vi.fn(async () => {
				n++;
				if (n === 1) throw Object.assign(new Error('slippage'), { code: 'tx_err' });
				return { signature: 'sig_ok', route: 'standard' };
			}),
		};
		const p = ports({ executor });
		const strat = strategy();
		const first = await executeBuy({ cfg: liveCfg(), strat, candidate: { mint: THREE }, throttle: openThrottle, ports: p });
		expect(first).toMatchObject({ status: 'failed', reason: 'tx_err' });
		expect(await p.store.getDailySpendLamports('agent_1', 'devnet')).toBe(0n);

		const second = await executeBuy({ cfg: liveCfg(), strat, candidate: { mint: THREE }, throttle: openThrottle, ports: p });
		expect(second).toMatchObject({ status: 'open', sig: 'sig_ok' });
	});
});

describe('executeBuy — quote asset and tip ledger', () => {
	it('fails closed when a SOL-only strategy gets a quote without quoteMint', async () => {
		const { solana } = fakeSolana({ quoteForBuy: async () => ({ priceImpactPct: 1 }) });
		const p = ports({ solana });
		const res = await executeBuy({ cfg: simCfg(), strat: strategy(), candidate: { mint: THREE }, throttle: openThrottle, ports: p });
		expect(res).toMatchObject({ status: 'failed', reason: 'quote_mint_missing' });
	});

	it('rejects a non-SOL quote unless the strategy opts out', async () => {
		const usdc = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
		const { solana } = fakeSolana({ quoteForBuy: async () => ({ priceImpactPct: 1, quoteMint: usdc }) });
		const p = ports({ solana });
		const blocked = await executeBuy({ cfg: simCfg(), strat: strategy(), candidate: { mint: THREE }, throttle: openThrottle, ports: p });
		expect(blocked.reason).toBe('quote_not_sol');
		const allowed = await executeBuy({ cfg: simCfg(), strat: strategy({ require_sol_quote: false }), candidate: { mint: mints(1)[0] }, throttle: openThrottle, ports: p });
		expect(allowed.status).toBe('open');
	});

	it('records an MEV tip under the engine network, not a mainnet default', async () => {
		const executor = {
			submit: vi.fn(async ({ onTip }) => {
				await onTip(100_000n, 'jito');
				return { signature: 'sig_tip', route: 'jito', tipLamports: 100_000n };
			}),
		};
		const store = createMemoryStore();
		const p = ports({ store, executor });
		const strat = strategy({ network: undefined, mev_tip_mode: 'economy' });
		const cfg = loadConfig({ network: 'devnet', mode: 'live', rpcUrl: 'http://127.0.0.1:8899', confirmLive: true });
		await executeBuy({ cfg, strat, candidate: { mint: THREE }, throttle: openThrottle, ports: p });
		const tips = store._spend.filter((e) => e.category === 'mev_tip');
		expect(tips).toHaveLength(1);
		expect(tips[0].network).toBe('devnet');
	});
});
