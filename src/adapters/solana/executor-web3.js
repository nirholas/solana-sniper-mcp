// agent-sniper — default Executor: MEV-aware web3.js broadcast.
//
// The one place a signed transaction hits the network. Builds a v0 tx with a
// dynamic priority fee, optionally simulates, sends, and confirms with bounded
// adaptive retry (fresh blockhash + escalating fee per attempt). When tipMode is
// 'economy'|'turbo' it appends a Jito tip transfer and routes the tx through the
// Jito block engine for bundle inclusion, falling back to the normal RPC path
// (reported honestly via fallbackReason) if Jito is unreachable.
//
// Returns full landing telemetry so callers can persist route / tip / fee /
// landed_ms. No external Jito SDK — the block engine speaks plain JSON-RPC.

import {
	ComputeBudgetProgram, SystemProgram, PublicKey,
	TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';

// The transaction's signature is fixed the moment it's signed — it's the base58
// of the first signature, computable with zero network I/O. Capturing it BEFORE
// broadcasting is what makes a client-side send error non-duplicating: even if
// sendViaJito/sendRawTransaction throws while the tx already reached the chain,
// we still know exactly which signature to poll for.
function sigOf(tx) {
	return bs58.encode(tx.signatures[0]);
}

// Jito mainnet tip accounts (public, rotate by random pick). Block engine routes
// a tx to a validator running Jito when it pays one of these.
const JITO_TIP_ACCOUNTS = [
	'96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
	'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
	'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
	'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
	'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
	'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
	'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
	'3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];
const JITO_BLOCK_ENGINE = 'https://mainnet.block-engine.jito.wtf/api/v1/transactions';

const TIP_LAMPORTS = { economy: 100_000n, turbo: 1_000_000n }; // 0.0001 / 0.001 SOL
const PRIORITY_FEE_MICROLAMPORTS = { base: 50_000, turbo: 500_000 };

function pickTipAccount(seed) {
	return JITO_TIP_ACCOUNTS[Math.abs(seed) % JITO_TIP_ACCOUNTS.length];
}

async function buildSigned({ connection, payer, instructions, microLamports, tipIx }) {
	const cuPrice = ComputeBudgetProgram.setComputeUnitPrice({ microLamports });
	const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });
	const ixs = [cuPrice, cuLimit, ...instructions];
	if (tipIx) ixs.push(tipIx);
	const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
	const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
	const tx = new VersionedTransaction(msg);
	tx.sign([payer]);
	return { tx, blockhash, lastValidBlockHeight };
}

async function sendViaJito(rawBase64) {
	const res = await fetch(JITO_BLOCK_ENGINE, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [rawBase64, { encoding: 'base64' }] }),
	});
	if (!res.ok) throw new Error(`jito ${res.status}`);
	const body = await res.json();
	if (body.error) throw new Error(`jito ${body.error.message || 'rejected'}`);
	return body.result; // signature
}

/**
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts]   default 3
 * @param {boolean} [opts.simulate]     pre-simulate before first send (default true)
 * @returns {import('../../types.js').Executor}
 */
export function createWeb3Executor(opts = {}) {
	const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
	const simulate = opts.simulate !== false;
	const settleBudgetMsOpt = opts.settleBudgetMs ?? null;

	return {
		async submit({ connection, payer, instructions, confirmTimeoutMs, tipMode = 'off', onTip }) {
			const start = Date.now();
			// Grace-sweep budget: how long to keep checking history for a landed tx
			// after its blockhash expires before declaring it dead. Injectable so
			// tests can shrink it; defaults to a generous window for degraded RPCs.
			const graceMs = settleBudgetMsOpt ?? 12_000;
			let useJito = tipMode === 'economy' || tipMode === 'turbo';
			let tipLamports = 0n;
			let tipIx = null;
			if (useJito) {
				tipLamports = TIP_LAMPORTS[tipMode] || TIP_LAMPORTS.economy;
				// Invoke the spend-guard veto with the real tip amount BEFORE it leaves
				// the wallet. A throw drops us to the untipped standard route.
				if (typeof onTip === 'function') {
					// A veto (throw) means "don't tip" — drop to the untipped protected
					// route, which the unified retry loop below runs when useJito is false.
					try { await onTip(tipLamports, 'jito'); }
					catch { tipLamports = 0n; tipIx = null; useJito = false; }
				}
				tipIx = SystemProgram.transfer({
					fromPubkey: payer.publicKey,
					toPubkey: new PublicKey(pickTipAccount(payer.publicKey.toBuffer()[0])),
					lamports: Number(tipLamports),
				});
			}

			let fallbackReason = null;

			// Every distinct transaction ("generation") this submit() has broadcast.
			// The duplicate-buy bug (found live 2026-07-03: 2–3 buys landed for one
			// order under a degraded RPC) came from minting a FRESH-blockhash tx on
			// each retry: a new signature the chain will execute ALONGSIDE the first,
			// so when the RPC false-nulls the first tx's status the retry double-spends.
			// The invariant that fixes it: within a generation's validity window we
			// only ever REBROADCAST the same signed bytes (idempotent — the chain
			// dedupes an identical signature, so a resend can never double-spend); a
			// NEW generation is minted ONLY after the previous one is provably dead
			// (blockhash expired AND absent from history across a grace sweep).
			const sent = []; // { signature, lastValidBlockHeight }

			async function landedAmongSent() {
				if (!sent.length) return null;
				const res = await connection.getSignatureStatuses(sent.map((s) => s.signature), { searchTransactionHistory: true }).catch(() => null);
				const arr = res?.value || [];
				for (let i = 0; i < arr.length; i++) {
					const st = arr[i];
					if (st && !st.err && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
						return sent[i].signature;
					}
				}
				return null;
			}

			function ambiguous(lastErr) {
				const sigs = sent.map((s) => s.signature);
				return Object.assign(
					new Error(`landing ambiguous after ${sent.length} broadcast(s) — verify before retrying: ${sigs.join(', ')}${lastErr ? ` (last error: ${lastErr.message})` : ''}`),
					{ code: 'landing_ambiguous', sentSignatures: sigs },
				);
			}

			// After a blockhash expires, a tx that truly landed still shows up in
			// history within a second or two; a degraded RPC just lags. Sweep a short
			// grace window before ever concluding a tx is dead — this is the guard the
			// old getBlockHeight-only check lacked, and the reason it double-spent.
			async function graceSweep(signature, ms = graceMs) {
				const deadline = Date.now() + ms;
				while (Date.now() < deadline) {
					const st = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true }).catch(() => null))?.value?.[0];
					if (st && !st.err && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return true;
					if (st && st.err) return false; // definitively failed on-chain
					await sleep(1500);
				}
				return false;
			}

			// Drive ONE generation: build+sign once, then (re)broadcast the same bytes
			// on an interval and poll until it confirms, definitively fails, or its
			// blockhash provably expires. Returns { signature } on land, { dead:true }
			// when provably gone (safe to mint a new generation), or { dead:false,
			// unknown:true } when the window elapsed without resolution (NEVER resend).
			async function runGeneration(microLamports, viaJito) {
				const { tx, lastValidBlockHeight } = await buildSigned({ connection, payer, instructions, microLamports, tipIx: viaJito ? tipIx : null });
				if (simulate) {
					const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
					if (sim.value.err) throw Object.assign(new Error(`simulation failed: ${JSON.stringify(sim.value.err)}`), { code: 'sim_failed', logs: sim.value.logs });
				}
				const raw = Buffer.from(tx.serialize());
				// Signature is fixed at signing — record it BEFORE any network call so a
				// send that throws post-broadcast (Jito 200 with an unreadable body, an
				// RPC socket reset after forwarding) can't hide a landed tx from us.
				const signature = sigOf(tx);
				sent.push({ signature, lastValidBlockHeight });

				const deadline = Date.now() + Math.max(confirmTimeoutMs || 0, 15_000);
				let lastBroadcast = 0;
				let broadcastErr = null;
				while (Date.now() < deadline) {
					if (Date.now() - lastBroadcast > 2_000) {
						try {
							if (viaJito) await sendViaJito(raw.toString('base64'));
							else await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
						} catch (e) { broadcastErr = e; /* already-known / transient — keep polling the sig */ }
						lastBroadcast = Date.now();
					}
					await sleep(1_200);
					const st = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true }).catch(() => null))?.value?.[0];
					if (st) {
						if (st.err) throw Object.assign(new Error(`tx failed on-chain: ${JSON.stringify(st.err)}`), { code: 'tx_err', signature });
						if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return { signature };
					}
					const height = await connection.getBlockHeight('confirmed').catch(() => null);
					if (height != null && height > lastValidBlockHeight) {
						if (await graceSweep(signature)) return { signature };
						return { dead: true, broadcastErr };
					}
				}
				return { dead: false, unknown: true, broadcastErr };
			}

			const result = (signature, route, fee, attempts, tip) => ({
				signature, route, tipLamports: tip ?? 0n, priorityFeeMicroLamports: fee,
				attempts, landedMs: Date.now() - start, fallbackReason,
			});

			// Unified retry: generation 0 rides Jito (when tipped); every later
			// generation is the untipped protected route. A new generation is only
			// reached after the prior is provably dead — the anti-duplicate gate.
			let lastErr = null;
			for (let attempt = 0; attempt < maxAttempts; attempt++) {
				const prior = await landedAmongSent();
				if (prior) return result(prior, sent.length > 1 ? 'protected' : (useJito && tipIx ? jitoRoute(tipMode) : 'standard'), PRIORITY_FEE_MICROLAMPORTS.base * Math.max(1, attempt), attempt, useJito ? tipLamports : 0n);

				const viaJito = useJito && !!tipIx && attempt === 0;
				const fee = viaJito
					? (tipMode === 'turbo' ? PRIORITY_FEE_MICROLAMPORTS.turbo : PRIORITY_FEE_MICROLAMPORTS.base)
					: PRIORITY_FEE_MICROLAMPORTS.base * (attempt + 1);

				let gen;
				try {
					gen = await runGeneration(fee, viaJito);
				} catch (err) {
					if (err?.code === 'sim_failed') throw err; // nothing was broadcast
					if (err?.code === 'tx_err') {
						// This generation failed ON-CHAIN. A DIFFERENT prior generation
						// might still have landed — return it rather than re-failing.
						const p = await landedAmongSent();
						if (p) return result(p, 'protected', fee, attempt + 1, viaJito ? tipLamports : 0n);
						throw err; // terminal: the trade genuinely failed on-chain
					}
					lastErr = err;
					const p = await landedAmongSent();
					if (p) return result(p, viaJito ? jitoRoute(tipMode) : 'standard', fee, attempt + 1, viaJito ? tipLamports : 0n);
					throw ambiguous(err); // in-flight & unknown — never resend
				}

				if (gen.signature) {
					const route = viaJito ? jitoRoute(tipMode) : (attempt === 0 ? 'standard' : 'protected');
					return result(gen.signature, route, fee, attempt + 1, viaJito ? tipLamports : 0n);
				}
				if (viaJito && (gen.dead || gen.unknown)) {
					// Jito generation didn't land — the remaining attempts are the
					// untipped protected route. Record why, honestly.
					fallbackReason = gen.broadcastErr ? `jito_failed:${(gen.broadcastErr.message || 'error').slice(0, 100)}` : 'jito_not_landed';
					tipIx = null;
				}
				if (gen.unknown) throw ambiguous(gen.broadcastErr || lastErr); // window elapsed, unresolved — do NOT mint another
				// gen.dead → provably gone; loop mints the next generation safely
			}

			const final = await landedAmongSent();
			if (final) return result(final, 'protected', PRIORITY_FEE_MICROLAMPORTS.base * maxAttempts, maxAttempts, 0n);
			if (sent.length) throw ambiguous(lastErr);
			throw lastErr || new Error('no broadcast attempted');
		},
	};
}

function jitoRoute(tipMode) {
	return tipMode === 'turbo' ? 'jito_turbo' : 'jito';
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms).unref?.());
}

export default createWeb3Executor;
