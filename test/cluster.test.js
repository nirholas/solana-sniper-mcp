// Network/RPC consistency: every adapter must talk to the cluster the config
// names. The pump client is mocked so no Connection or RPC is created.
import { describe, it, expect, vi, afterEach } from 'vitest';

const pumpClientCalls = [];
vi.mock('../src/adapters/solana/pump-client.js', () => ({
	createPumpClient: async (opts) => {
		pumpClientCalls.push(opts);
		return { connection: {} };
	},
}));

const { presets } = await import('../src/index.js');
const { loadConfig, GENESIS_HASHES } = await import('../src/config.js');
const { createSniper } = await import('../src/engine.js');
const { createMemoryStore } = await import('../src/adapters/store/memory.js');

const ENV_KEYS = ['SNIPER_NETWORK', 'SNIPER_MODE', 'SOLANA_RPC_URL', 'HELIUS_API_KEY', 'SNIPER_CONFIRM_LIVE'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
	pumpClientCalls.length = 0;
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe('HELIUS_API_KEY', () => {
	it('becomes the Helius endpoint for the configured cluster', () => {
		for (const k of ENV_KEYS) delete process.env[k];
		process.env.HELIUS_API_KEY = 'k/1';
		expect(loadConfig({ network: 'devnet' }).rpcUrl).toBe('https://devnet.helius-rpc.com/?api-key=k%2F1');
		expect(loadConfig({ network: 'mainnet', mode: 'live', confirmLive: true }).rpcUrl).toBe('https://mainnet.helius-rpc.com/?api-key=k%2F1');
	});

	it('an explicit rpcUrl still wins', () => {
		process.env.HELIUS_API_KEY = 'k';
		expect(loadConfig({ rpcUrl: 'https://my.rpc' }).rpcUrl).toBe('https://my.rpc');
	});
});

describe('presets.local', () => {
	it('hands the pump client the same network and RPC the engine uses', async () => {
		for (const k of ENV_KEYS) delete process.env[k];
		process.env.SNIPER_NETWORK = 'devnet';
		process.env.HELIUS_API_KEY = 'k';
		const sniper = await presets.local({});
		expect(sniper.config.network).toBe('devnet');
		expect(pumpClientCalls).toEqual([{ network: 'devnet', rpcUrl: 'https://devnet.helius-rpc.com/?api-key=k' }]);
	});
});

describe('engine start — live cluster guard', () => {
	const build = (genesis, network = 'devnet') => createSniper({
		config: { network, mode: 'live', confirmLive: true, rpcUrl: 'https://rpc.test' },
		store: createMemoryStore(),
		wallet: { loadKeypair: async () => null },
		solana: { connection: { getGenesisHash: async () => genesis } },
		executor: { submit: async () => ({}) },
		feed: { start: async () => () => {} },
		logger: { debug() {}, info() {}, warn() {}, error() {}, trade() {} },
	});

	it('refuses to trade live when the RPC serves another cluster', async () => {
		await expect(build(GENESIS_HASHES.mainnet, 'devnet').start()).rejects.toThrow(/not on devnet/);
	});

	it('starts when the cluster matches', async () => {
		const sniper = build(GENESIS_HASHES.devnet, 'devnet');
		await sniper.start();
		await sniper.stop();
	});
});
