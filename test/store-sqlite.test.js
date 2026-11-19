// The durable SQLite store against an in-memory database (better-sqlite3).
import { describe, it, expect, afterEach } from 'vitest';
import { createSqliteStore } from '../src/adapters/store/sqlite.js';

const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

const strategy = (over = {}) => ({
	id: 'strat_1',
	agent_id: 'agent_1',
	enabled: true,
	network: 'devnet',
	stop_loss_pct: 25,
	per_trade_lamports: '1000000',
	daily_budget_lamports: '5000000',
	...over,
});

let store;
afterEach(() => store?.close());

describe('createSqliteStore', () => {
	it('claims a slot once and frees it when the position is terminal', async () => {
		store = createSqliteStore({ path: ':memory:' });
		const first = await store.claimPosition({ strategy: strategy(), candidate: { mint: MINT }, network: 'devnet' });
		expect(first.status).toBe('opening');
		expect(await store.claimPosition({ strategy: strategy(), candidate: { mint: MINT }, network: 'devnet' })).toBeNull();
		await store.updatePosition(first.id, { status: 'failed' });
		expect(await store.claimPosition({ strategy: strategy(), candidate: { mint: MINT }, network: 'devnet' })).not.toBeNull();
	});

	it('copies the exit-ladder settings onto the position', async () => {
		store = createSqliteStore({ path: ':memory:' });
		const pos = await store.claimPosition({
			strategy: strategy({ initials_out_multiple: 2, moonbag_min_pct: 20 }),
			candidate: { mint: MINT },
			network: 'devnet',
		});
		const fresh = await store.getPosition(pos.id);
		expect(fresh.initials_out_multiple).toBe(2);
		expect(fresh.moonbag_min_pct).toBe(20);
		await store.updatePosition(pos.id, { initials_recovered: true, kill_switch: true });
		const patched = await store.getPosition(pos.id);
		expect(patched.initials_recovered).toBe(true);
		expect(patched.kill_switch).toBe(true);
		expect(patched.initials_out_multiple).toBe(2);
	});

	it('keeps lamport amounts exact above 2^53', async () => {
		store = createSqliteStore({ path: ':memory:' });
		const big = 2n ** 60n + 7n;
		await store.recordSpend({ agentId: 'agent_1', network: 'devnet', amountLamports: big, category: 'snipe' });
		await store.recordSpend({ agentId: 'agent_1', network: 'devnet', amountLamports: 1n, category: 'snipe' });
		expect(await store.getDailySpendLamports('agent_1', 'devnet')).toBe(big + 1n);
	});

	it('returns null for an unknown position id', async () => {
		store = createSqliteStore({ path: ':memory:' });
		expect(await store.getPosition('nope')).toBeNull();
	});
});
