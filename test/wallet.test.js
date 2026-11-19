// Unit tests for the wallet adapters (self-custody + custodial). No network.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

describe('createSelfCustodyWallet — keystore and secret hygiene', () => {
	function keystore() {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sniper-ks-'));
		const dir = path.join(root, 'keys');
		fs.mkdirSync(dir);
		return { root, dir };
	}
	const writeKey = (file, kp) => fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));

	it('loads <agentId>.json from the keystore directory', async () => {
		const { root, dir } = keystore();
		try {
			const kp = Keypair.generate();
			writeKey(path.join(dir, 'scout-1.json'), kp);
			const wallet = createSelfCustodyWallet({ keystoreDir: dir });
			expect((await wallet.loadKeypair('scout-1')).address).toBe(kp.publicKey.toBase58());
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it('refuses agent ids that would escape the keystore directory', async () => {
		const { root, dir } = keystore();
		try {
			writeKey(path.join(root, 'operator.json'), Keypair.generate());
			const wallet = createSelfCustodyWallet({ keystoreDir: dir });
			for (const id of ['../operator', '..\\operator', '/etc/operator', 'a/../../operator', '..']) {
				expect(await wallet.loadKeypair(id)).toBe(null);
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it('a malformed secret error never quotes the secret', async () => {
		const secret = '[1,2,3,SECRETBYTES';
		const wallet = createSelfCustodyWallet({ secrets: { agent_1: secret } });
		await expect(wallet.loadKeypair('agent_1')).rejects.toThrow(/could not decode/);
		await wallet.loadKeypair('agent_1').catch((err) => {
			expect(err.message).not.toContain('SECRETBYTES');
		});
	});
});

describe('createCustodialWallet — per-user isolation', () => {
	it('does not serve one user a keypair resolved for another', async () => {
		const kp = Keypair.generate();
		const resolve = vi.fn(async (_agentId, ctx) => (ctx.userId === 'owner' ? kp : null));
		const wallet = createCustodialWallet({ resolve, ttlMs: 60_000 });
		expect((await wallet.loadKeypair('agent_1', { userId: 'owner' })).address).toBe(kp.publicKey.toBase58());
		expect(await wallet.loadKeypair('agent_1', { userId: 'intruder' })).toBe(null);
		expect(resolve).toHaveBeenCalledTimes(2);
	});

	it('evicts expired entries instead of holding keys past the TTL', async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(0);
			const resolve = vi.fn(async () => Keypair.generate());
			const wallet = createCustodialWallet({ resolve, ttlMs: 1_000 });
			await wallet.loadKeypair('a');
			await wallet.loadKeypair('b');
			vi.setSystemTime(5_000);
			await wallet.loadKeypair('c');
			// a and b were re-resolvable only by calling resolve again
			await wallet.loadKeypair('a');
			expect(resolve).toHaveBeenCalledTimes(4);
		} finally {
			vi.useRealTimers();
		}
	});

	it('ttlMs: 0 disables caching', async () => {
		const resolve = vi.fn(async () => Keypair.generate());
		const wallet = createCustodialWallet({ resolve, ttlMs: 0 });
		await wallet.loadKeypair('a');
		await wallet.loadKeypair('a');
		expect(resolve).toHaveBeenCalledTimes(2);
	});
});
