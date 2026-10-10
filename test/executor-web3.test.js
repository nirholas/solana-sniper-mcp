// executor-web3 — duplicate-broadcast safety.
//
// Found live on 2026-07-03 with real funds, TWICE: 2–3 buys landed for a single
// order under a degraded public RPC. Root cause: the retry loop minted a FRESH-
// blockhash transaction on each attempt — a new signature the chain executes
// ALONGSIDE the first — so when the RPC false-nulled the first tx's status (and
// advanced past its blockhash expiry) the retry double-spent, and the engine
// then recorded the position as failed while the extra buy's tokens sat orphaned.
//
// The fix: one "generation" (one signed tx / one signature) is only ever
// REBROADCAST within its validity window (idempotent — the chain dedupes an
// identical signature); a NEW generation is minted ONLY after the previous is
// provably dead (blockhash expired AND absent from a post-expiry grace sweep).
// These tests pin that: assert on the number of DISTINCT signatures broadcast.
import { describe, it, expect } from 'vitest';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { createWeb3Executor } from '../src/adapters/solana/executor-web3.js';

const payer = Keypair.generate();
const BLOCKHASH = bs58.encode(Keypair.generate().publicKey.toBytes());

// A mock connection whose behaviour is driven by per-signature scripts. Each
// generation gets a fresh blockhash-height pair; we record every distinct
// signature the executor broadcasts so a duplicate is directly observable.
function mockConnection(opts = {}) {
	const {
		landedSigs = new Set(),      // signatures the chain will report confirmed
		failedSigs = new Set(),      // signatures the chain will report err
		hideStatus = new Set(),      // sigs whose status is FALSE-NULLED (degraded RPC)
		heightSeq = null,            // async () => number, drives expiry
		lvbh = 100,
		sendThrows = false,          // send call throws AFTER pushing to the chain
	} = opts;
	const distinct = new Set();
	const broadcasts = [];
	let hi = 0;
	const conn = {
		distinct, broadcasts,
		async getLatestBlockhash() { return { blockhash: BLOCKHASH, lastValidBlockHeight: lvbh }; },
		async simulateTransaction() { return { value: { err: null } }; },
		async sendRawTransaction(raw) {
			const sig = bs58.encode(VersionedTransaction.deserialize(raw).signatures[0]);
			distinct.add(sig); broadcasts.push(sig);
			if (sendThrows) throw new Error('socket hang up');
			return sig;
		},
		async getSignatureStatuses(sigs) {
			return {
				value: sigs.map((s) => {
					if (hideStatus.has(s)) return null;
					if (failedSigs.has(s)) return { err: { InstructionError: [0, 'x'] }, confirmationStatus: 'processed' };
					if (landedSigs.has(s)) return { err: null, confirmationStatus: 'confirmed', slot: 1 };
					return null;
				}),
			};
		},
		async getBlockHeight() { return heightSeq ? heightSeq(hi++) : 50; },
	};
	return conn;
}

const submitArgs = (connection) => ({ connection, payer, instructions: [], confirmTimeoutMs: 500 });

describe('createWeb3Executor duplicate-broadcast safety', () => {
	it('happy path: one distinct signature, returns it', async () => {
		const connection = mockConnection({});
		// the (single) broadcast signature lands
		const exec = createWeb3Executor({ simulate: true });
		// pre-seed: whatever it sends, mark landed on first status poll
		const orig = connection.sendRawTransaction.bind(connection);
		connection.sendRawTransaction = async (raw) => { const s = await orig(raw); connection.__land = s; return s; };
		connection.getSignatureStatuses = async (sigs) => ({ value: sigs.map((s) => (s === connection.__land ? { err: null, confirmationStatus: 'confirmed', slot: 1 } : null)) });
		const res = await exec.submit(submitArgs(connection));
		expect(connection.distinct.size).toBe(1);
		expect(res.signature).toBe([...connection.distinct][0]);
	});

	it('THE BUG: RPC false-nulls a landed tx while height passes expiry → no second signature', async () => {
		// The generation lands on-chain, but getSignatureStatuses hides it AND the
		// block height marches past expiry. The old code declared it dead and minted
		// a duplicate. The grace sweep must reveal the landing; distinct stays 1.
		let landedSig = null;
		let polls = 0;
		const connection = mockConnection({ heightSeq: () => 999 /* always expired */ });
		const orig = connection.sendRawTransaction.bind(connection);
		connection.sendRawTransaction = async (raw) => { landedSig = await orig(raw); return landedSig; };
		connection.getSignatureStatuses = async (sigs) => ({
			value: sigs.map((s) => {
				// hidden for the first two polls (degraded), then revealed by grace sweep
				if (s === landedSig && polls++ >= 2) return { err: null, confirmationStatus: 'confirmed', slot: 1 };
				return null;
			}),
		});
		const exec = createWeb3Executor({ simulate: true, settleBudgetMs: 8_000 });
		const res = await exec.submit(submitArgs(connection));
		expect(connection.distinct.size).toBe(1);   // ← the fix: never a duplicate
		expect(res.signature).toBe(landedSig);
	});

	it('send throws AFTER the tx reached the chain → still no duplicate', async () => {
		let landed = null; let polls = 0;
		const connection = mockConnection({ sendThrows: true, heightSeq: () => 50 });
		// capture what WOULD have been sent (signature is computed pre-send)
		const origSend = connection.sendRawTransaction.bind(connection);
		connection.sendRawTransaction = async (raw) => {
			landed = bs58.encode(VersionedTransaction.deserialize(raw).signatures[0]);
			connection.distinct.add(landed); connection.broadcasts.push(landed);
			throw new Error('socket hang up'); // sent on-chain, client throws
		};
		connection.getSignatureStatuses = async (sigs) => ({ value: sigs.map((s) => (s === landed && polls++ >= 1 ? { err: null, confirmationStatus: 'confirmed', slot: 1 } : null)) });
		const exec = createWeb3Executor({ simulate: true });
		const res = await exec.submit(submitArgs(connection));
		expect(res.signature).toBe(landed);
		expect(connection.distinct.size).toBe(1);
	});

	it('provably dead (expired + absent from grace sweep) → mints exactly one new generation', async () => {
		let sendN = 0; let secondSig = null;
		const connection = mockConnection({ heightSeq: () => 999 }); // always expired
		const origSend = connection.sendRawTransaction.bind(connection);
		connection.sendRawTransaction = async (raw) => {
			const sig = await origSend(raw);
			sendN = connection.distinct.size;
			if (connection.distinct.size === 2) secondSig = sig;
			return sig;
		};
		connection.getSignatureStatuses = async (sigs) => ({ value: sigs.map((s) => (s === secondSig ? { err: null, confirmationStatus: 'confirmed', slot: 2 } : null)) });
		const exec = createWeb3Executor({ simulate: true, settleBudgetMs: 300, maxAttempts: 3 });
		const res = await exec.submit(submitArgs(connection));
		expect(connection.distinct.size).toBe(2);      // gen0 died, gen1 landed — no more
		expect(res.signature).toBe(secondSig);
	});

	it('on-chain failure (slippage) is terminal — no retry, no duplicate', async () => {
		let sig = null;
		const connection = mockConnection({ heightSeq: () => 50 });
		const origSend = connection.sendRawTransaction.bind(connection);
		connection.sendRawTransaction = async (raw) => { sig = await origSend(raw); return sig; };
		connection.getSignatureStatuses = async (sigs) => ({ value: sigs.map((s) => (s === sig ? { err: { InstructionError: [3, { Custom: 6002 }] }, confirmationStatus: 'processed' } : null)) });
		const exec = createWeb3Executor({ simulate: true, maxAttempts: 3 });
		await expect(exec.submit(submitArgs(connection))).rejects.toMatchObject({ code: 'tx_err' });
		expect(connection.distinct.size).toBe(1);
	});
});
