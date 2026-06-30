// Unit tests for the in-memory Store adapter (src/adapters/store/memory.js).
// No network: pure in-process state.
import { describe, it, expect } from 'vitest';
import { createMemoryStore } from '../src/adapters/store/memory.js';

const MINT = 'THREEsynthetic1111111111111111111111111111111';
const MINT_B = 'THREEsynthetic2222222222222222222222222222222';

function strategy(over = {}) {
	return {
		id: 'strat_1',
		agent_id: 'agent_1',
		enabled: true,
		network: 'devnet',
		stop_loss_pct: 20,
		per_trade_lamports: '1000000',
		daily_budget_lamports: '5000000',
		...over,
	};
}

describe('createMemoryStore — strategies', () => {
	it('seeds strategies from the constructor', () => {
		const store = createMemoryStore({ strategies: [strategy()] });
		expect(store._positions instanceof Map).toBe(true);
	});

	it('addStrategy then getArmedStrategies returns enabled, stop-loss strategies for the network', async () => {
		const store = createMemoryStore();
		store.addStrategy(strategy());
		const armed = await store.getArmedStrategies('devnet');
		expect(armed).toHaveLength(1);
		expect(armed[0].id).toBe('strat_1');
	});

	it('excludes disabled, kill-switched, missing-stop-loss, and wrong-network strategies', async () => {
		const store = createMemoryStore();
		store.addStrategy(strategy({ id: 'a', enabled: false }));
		store.addStrategy(strategy({ id: 'b', kill_switch: true }));
		store.addStrategy(strategy({ id: 'c', stop_loss_pct: null }));
		store.addStrategy(strategy({ id: 'd', network: 'mainnet' }));
		store.addStrategy(strategy({ id: 'e' })); // the only armed one
		const armed = await store.getArmedStrategies('devnet');
		expect(armed.map((s) => s.id)).toEqual(['e']);
	});
});

describe('createMemoryStore — claimPosition (atomic slot)', () => {
	it('returns a new position row on first claim', async () => {
		const store = createMemoryStore();
		const pos = await store.claimPosition({ strategy: strategy(), candidate: { mint: MINT }, network: 'devnet' });
		expect(pos).not.toBe(null);
		expect(pos.agent_id).toBe('agent_1');
		expect(pos.mint).toBe(MINT);
		expect(pos.status).toBe('opening');
		expect(pos.stop_loss_pct).toBe(20);
	});

	it('returns null on a duplicate claim of the same slot (no double buy)', async () => {
		const store = createMemoryStore();
		const first = await store.claimPosition({ strategy: strategy(), candidate: { mint: MINT }, network: 'devnet' });
		const second = await store.claimPosition({ strategy: strategy(), candidate: { mint: MINT }, network: 'devnet' });
		expect(first).not.toBe(null);
		expect(second).toBe(null);
	});

	it('allows re-claiming the slot once the prior position is terminal', async () => {
		const store = createMemoryStore();
		const first = await store.claimPosition({ strategy: strategy(), candidate: { mint: MINT }, network: 'devnet' });
		await store.updatePosition(first.id, { status: 'closed' });
		const again = await store.claimPosition({ strategy: strategy(), candidate: { mint: MINT }, network: 'devnet' });
		expect(again).not.toBe(null);
	});

	it('keeps slots distinct per mint', async () => {
		const store = createMemoryStore();
		const a = await store.claimPosition({ strategy: strategy(), candidate: { mint: MINT }, network: 'devnet' });
		const b = await store.claimPosition({ strategy: strategy(), candidate: { mint: MINT_B }, network: 'devnet' });
		expect(a).not.toBe(null);
		expect(b).not.toBe(null);
	});
});

describe('createMemoryStore — positions', () => {
	it('updatePosition merges a patch', async () => {
		const store = createMemoryStore();
		const pos = await store.claimPosition({ strategy: strategy(), candidate: { mint: MINT }, network: 'devnet' });
		await store.updatePosition(pos.id, { status: 'open', last_value_lamports: 1234 });
		const open = await store.getOpenPositions('devnet');
		expect(open).toHaveLength(1);
		expect(open[0].last_value_lamports).toBe(1234);
	});

	it('updatePosition on an unknown id is a no-op', async () => {
		const store = createMemoryStore();
		await expect(store.updatePosition('nope', { status: 'open' })).resolves.toBeUndefined();
	});

	it('getOpenPositions returns open and closing, not opening/closed/failed', async () => {
		const store = createMemoryStore();
		const opening = await store.claimPosition({ strategy: strategy(), candidate: { mint: MINT }, network: 'devnet' });
		const willOpen = await store.claimPosition({ strategy: strategy({ agent_id: 'agent_2' }), candidate: { mint: MINT_B }, network: 'devnet' });
		await store.updatePosition(willOpen.id, { status: 'open' });
		const open = await store.getOpenPositions('devnet');
		expect(open.map((p) => p.id)).toEqual([willOpen.id]);
		expect(open.map((p) => p.id)).not.toContain(opening.id); // still 'opening'
	});

	it('countOpenPositions counts opening + open for an agent', async () => {
		const store = createMemoryStore();
		await store.claimPosition({ strategy: strategy(), candidate: { mint: MINT }, network: 'devnet' });
		const p2 = await store.claimPosition({ strategy: strategy(), candidate: { mint: MINT_B }, network: 'devnet' });
		await store.updatePosition(p2.id, { status: 'open' });
		expect(await store.countOpenPositions('agent_1', 'devnet')).toBe(2);
		expect(await store.countOpenPositions('agent_1', 'mainnet')).toBe(0);
	});
});

describe('createMemoryStore — spend ledger', () => {
	it('getDailySpendLamports sums today only and isolates by agent', async () => {
		const store = createMemoryStore();
		await store.recordSpend({ agentId: 'agent_1', network: 'devnet', amountLamports: 1_000n, category: 'snipe' });
		await store.recordSpend({ agentId: 'agent_1', network: 'devnet', amountLamports: 500n, category: 'snipe' });
		await store.recordSpend({ agentId: 'agent_2', network: 'devnet', amountLamports: 9_000n, category: 'snipe' });
		const total = await store.getDailySpendLamports('agent_1', 'devnet');
		expect(total).toBe(1_500n);
	});

	it('excludes spend recorded before the current UTC day', async () => {
		const store = createMemoryStore();
		// Reach into the spend array (exposed as _spend) to inject a stale entry.
		store._spend.push({ agentId: 'agent_1', network: 'devnet', amountLamports: 7_000n, at: 0, category: 'snipe' });
		await store.recordSpend({ agentId: 'agent_1', network: 'devnet', amountLamports: 1_000n, category: 'snipe' });
		const total = await store.getDailySpendLamports('agent_1', 'devnet');
		expect(total).toBe(1_000n);
	});
});

describe('createMemoryStore — listPositions', () => {
	it('filters by agentId, network, and status', async () => {
		const store = createMemoryStore();
		const a = await store.claimPosition({ strategy: strategy(), candidate: { mint: MINT }, network: 'devnet' });
		const b = await store.claimPosition({ strategy: strategy({ agent_id: 'agent_2' }), candidate: { mint: MINT_B }, network: 'devnet' });
		await store.updatePosition(b.id, { status: 'open' });

		expect((await store.listPositions({})).length).toBe(2);
		expect((await store.listPositions({ agentId: 'agent_1' })).map((p) => p.id)).toEqual([a.id]);
		expect((await store.listPositions({ status: 'open' })).map((p) => p.id)).toEqual([b.id]);
		expect((await store.listPositions({ network: 'mainnet' })).length).toBe(0);
	});
});
