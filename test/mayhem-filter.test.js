// Mayhem filter with the pump SDK mocked: no RPC.
import { describe, it, expect, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';

const curves = new Map(); // mint → bonding curve (or Error)
vi.mock('@nirholas/pump-sdk', () => ({
	OnlinePumpSdk: class {
		async fetchBondingCurve(mint) {
			const v = curves.get(mint.toBase58());
			if (v instanceof Error) throw v;
			return v;
		}
	},
}));

const { createMayhemFilter, retryWhileNull } = await import('../src/mayhem-filter.js');
const mint = () => Keypair.generate().publicKey.toBase58();
const quietLogger = () => ({ warn: vi.fn() });

describe('createMayhemFilter', () => {
	it('blocks Mayhem coins and passes normal ones', async () => {
		const [m1, m2] = [mint(), mint()];
		curves.set(m1, { isMayhemMode: true });
		curves.set(m2, { isMayhemMode: false });
		const f = createMayhemFilter({ connection: {}, logger: quietLogger(), retries: 0 });
		expect(await f.oracleGate({ candidate: { mint: m1 } })).toEqual({ pass: false, reason: 'mayhem_excluded' });
		expect(await f.oracleGate({ candidate: { mint: m2 } })).toEqual({ pass: true });
	});

	it('an unreadable curve allows by default and blocks when strict', async () => {
		const m = mint();
		curves.set(m, new Error('rpc 429'));
		expect(await createMayhemFilter({ connection: {}, logger: quietLogger(), retries: 0 }).oracleGate({ candidate: { mint: m } }))
			.toEqual({ pass: true, skipped: true });
		expect(await createMayhemFilter({ connection: {}, logger: quietLogger(), retries: 0, strictOnUnknown: true }).oracleGate({ candidate: { mint: m } }))
			.toEqual({ pass: false, reason: 'mayhem_unknown' });
	});

	it('warns through the logger (stderr), never stdout, when the SDK lacks the field', async () => {
		const m = mint();
		curves.set(m, {});
		const logger = quietLogger();
		const stdout = vi.spyOn(process.stdout, 'write');
		const consoleLog = vi.spyOn(console, 'log');
		await createMayhemFilter({ connection: {}, logger, retries: 0 }).isMayhem(m);
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(consoleLog).not.toHaveBeenCalled();
		expect(stdout).not.toHaveBeenCalled();
		stdout.mockRestore();
		consoleLog.mockRestore();
	});

	it('bounds its cache', async () => {
		const f = createMayhemFilter({ connection: {}, logger: quietLogger(), retries: 0, cacheLimit: 2 });
		const ms = [mint(), mint(), mint()];
		for (const m of ms) { curves.set(m, { isMayhemMode: false }); await f.isMayhem(m); }
		curves.set(ms[0], { isMayhemMode: true }); // only visible if ms[0] was evicted and re-read
		expect(await f.isMayhem(ms[0])).toBe(true);
		expect(await f.isMayhem(ms[2])).toBe(false);
	});
});

describe('retryWhileNull', () => {
	it('retries a null read and returns the first definitive answer', async () => {
		let n = 0;
		const v = await retryWhileNull(async () => (++n < 3 ? null : 'ok'), { retries: 3, delayMs: 1 });
		expect(v).toBe('ok');
		expect(n).toBe(3);
	});
});
