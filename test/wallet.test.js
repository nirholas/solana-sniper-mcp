// Unit tests for the wallet adapters (self-custody + custodial). No network.
import { describe, it, expect, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58Mod from 'bs58';
import { createSelfCustodyWallet } from '../src/adapters/wallet/self-custody.js';
import { createCustodialWallet } from '../src/adapters/wallet/custodial.js';

const bs58 = bs58Mod.default || bs58Mod;

describe('createSelfCustodyWallet', () => {
	it('decodes a base58 secret', async () => {
		const kp = Keypair.generate();
		const wallet = createSelfCustodyWallet({ secrets: { agent_1: bs58.encode(kp.secretKey) } });
		const loaded = await wallet.loadKeypair('agent_1');
		expect(loaded).not.toBe(null);
		expect(loaded.address).toBe(kp.publicKey.toBase58());
	});

	it('decodes a JSON-array secret', async () => {
		const kp = Keypair.generate();
		const json = JSON.stringify(Array.from(kp.secretKey));
		const wallet = createSelfCustodyWallet({ secrets: { agent_1: json } });
		const loaded = await wallet.loadKeypair('agent_1');
		expect(loaded).not.toBe(null);
		expect(loaded.address).toBe(kp.publicKey.toBase58());
	});

	it('returns null when no secret is provisioned for the agent', async () => {
		const wallet = createSelfCustodyWallet({ secrets: {} });
		expect(await wallet.loadKeypair('unknown_agent')).toBe(null);
	});

	it('caches the resolved keypair (same instance across loads)', async () => {
		const kp = Keypair.generate();
		const wallet = createSelfCustodyWallet({ secrets: { agent_1: bs58.encode(kp.secretKey) } });
		const a = await wallet.loadKeypair('agent_1');
		const b = await wallet.loadKeypair('agent_1');
		expect(a.keypair).toBe(b.keypair);
	});
});

describe('createCustodialWallet', () => {
	it('throws without a resolve callback', () => {
		expect(() => createCustodialWallet({})).toThrow(/resolve/);
	});

	it('resolves a keypair through the callback', async () => {
		const kp = Keypair.generate();
		const wallet = createCustodialWallet({ resolve: async () => kp });
		const loaded = await wallet.loadKeypair('agent_1');
		expect(loaded.address).toBe(kp.publicKey.toBase58());
	});

	it('caches within the TTL — resolve is called once', async () => {
		const kp = Keypair.generate();
		const resolve = vi.fn(async () => kp);
		const wallet = createCustodialWallet({ resolve, ttlMs: 60_000 });
		await wallet.loadKeypair('agent_1');
		await wallet.loadKeypair('agent_1');
		await wallet.loadKeypair('agent_1');
		expect(resolve).toHaveBeenCalledTimes(1);
	});

	it('re-resolves after the TTL expires', async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(0);
			const kp = Keypair.generate();
			const resolve = vi.fn(async () => kp);
			const wallet = createCustodialWallet({ resolve, ttlMs: 1_000 });
			await wallet.loadKeypair('agent_1');
			vi.setSystemTime(2_000); // past the TTL
			await wallet.loadKeypair('agent_1');
			expect(resolve).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('returns null when the resolver has no wallet for the agent', async () => {
		const wallet = createCustodialWallet({ resolve: async () => null });
		expect(await wallet.loadKeypair('agent_1')).toBe(null);
	});

	it('clearCache forces a re-resolve', async () => {
		const kp = Keypair.generate();
		const resolve = vi.fn(async () => kp);
		const wallet = createCustodialWallet({ resolve, ttlMs: 60_000 });
		await wallet.loadKeypair('agent_1');
		wallet.clearCache();
		await wallet.loadKeypair('agent_1');
		expect(resolve).toHaveBeenCalledTimes(2);
	});
});
