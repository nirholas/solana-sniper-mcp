// loadConfig: live trading needs a separately named confirmation.
import { describe, it, expect, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';

const ENV_KEYS = ['SNIPER_MODE', 'SNIPER_CONFIRM_LIVE', 'SOLANA_RPC_URL', 'HELIUS_API_KEY'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

const RPC = 'http://127.0.0.1:8899';

describe('loadConfig — live opt-in', () => {
	it('defaults to simulate', () => {
		for (const k of ENV_KEYS) delete process.env[k];
		expect(loadConfig().mode).toBe('simulate');
	});

	it('refuses mode live without confirmLive', () => {
		expect(() => loadConfig({ mode: 'live', rpcUrl: RPC })).toThrow(/confirmLive/);
	});

	it('refuses a stray SNIPER_MODE=live on its own', () => {
		process.env.SNIPER_MODE = 'live';
		delete process.env.SNIPER_CONFIRM_LIVE;
		expect(() => loadConfig({ rpcUrl: RPC })).toThrow(/confirmLive/);
	});

	it('only the exact value "yes" confirms through the env', () => {
		process.env.SNIPER_MODE = 'live';
		for (const v of ['1', 'true', 'YES', 'y']) {
			process.env.SNIPER_CONFIRM_LIVE = v;
			expect(() => loadConfig({ rpcUrl: RPC })).toThrow(/confirmLive/);
		}
		process.env.SNIPER_CONFIRM_LIVE = 'yes';
		expect(loadConfig({ rpcUrl: RPC }).mode).toBe('live');
	});

	it('an explicit confirmLive: false beats the env', () => {
		process.env.SNIPER_CONFIRM_LIVE = 'yes';
		expect(() => loadConfig({ mode: 'live', rpcUrl: RPC, confirmLive: false })).toThrow(/confirmLive/);
	});

	it('accepts mode live with confirmLive: true and an RPC', () => {
		expect(loadConfig({ mode: 'live', rpcUrl: RPC, confirmLive: true }).mode).toBe('live');
	});

	it('still requires a non-public RPC in live mode', () => {
		delete process.env.SOLANA_RPC_URL;
		delete process.env.HELIUS_API_KEY;
		expect(() => loadConfig({ mode: 'live', confirmLive: true })).toThrow(/rpcUrl/);
	});
});
