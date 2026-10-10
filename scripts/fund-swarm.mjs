// fund-swarm.mjs — fund the Swarm agents' Solana wallets from the niChP funder.
// Reads each Swarm agent's current solana_address straight from the Neon DB
// (so it funds the post-vanity address), then sends SOL from niChP. On-chain
// transfer — the one disclosed non-UI step (three.ws has no "fund from external
// wallet" button; the agent Wallet panel only shows a deposit QR).
//
// Env from ~/.three-ws-fleet/env: DATABASE_URL, SOLANA_RPC_URL, FLEET_FUNDER_SECRET_B58.
// Usage: PER=0.05 node scripts/fund-swarm.mjs --yes

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

function env() {
	const o = {};
	for (const l of fs.readFileSync(path.join(os.homedir(), '.three-ws-fleet', 'env'), 'utf8').split('\n')) {
		if (!l || l.startsWith('#')) continue; const i = l.indexOf('='); if (i < 0) continue; o[l.slice(0, i)] = l.slice(i + 1);
	}
	return o;
}
const e = env();
const YES = process.argv.includes('--yes');
const PER = Number(process.env.PER || 0.05);            // SOL target per agent
const RESERVE = Number(process.env.RESERVE || 0.15);    // keep in funder
const sol = (l) => (l / LAMPORTS_PER_SOL).toFixed(4);

// pull Swarm addresses from the DB
process.env.DATABASE_URL = e.DATABASE_URL;
const { sql } = await import('../../../api/_lib/db.js');
const rows = await sql`select name, meta->>'solana_address' as addr from agent_identities where name ~ '^Swarm [0-9]+$' and meta->>'solana_address' is not null order by (regexp_replace(name,'\\D','','g'))::int`;
console.log(`Swarm agents with wallets: ${rows.length}`);
if (!rows.length) { console.log('none yet — run after creation/wallets exist'); process.exit(0); }

const conn = new Connection(e.SOLANA_RPC_URL, 'confirmed');
const funder = Keypair.fromSecretKey(bs58.decode(e.FLEET_FUNDER_SECRET_B58));
const fBal = await conn.getBalance(funder.publicKey);
console.log(`funder ${funder.publicKey.toBase58()} = ${sol(fBal)} SOL`);

const targetLam = Math.round(PER * LAMPORTS_PER_SOL);
// compute who needs topping up
const need = [];
for (const r of rows) {
	const bal = await conn.getBalance(new PublicKey(r.addr));
	if (bal < targetLam) need.push({ ...r, add: targetLam - bal });
}
const total = need.reduce((s, n) => s + n.add, 0);
console.log(`need funding: ${need.length}/${rows.length} · total ${sol(total)} SOL · target ${PER}/agent`);
if (fBal - total < RESERVE * LAMPORTS_PER_SOL) { console.log(`! funder short: ${sol(fBal)} - ${sol(total)} < ${RESERVE} reserve. Lower PER.`); process.exit(1); }
if (!YES) { console.log('dry run — re-run with --yes to send'); process.exit(0); }

let sent = 0;
for (let i = 0; i < need.length; i += 8) {
	const batch = need.slice(i, i + 8);
	const tx = new Transaction();
	for (const n of batch) tx.add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: new PublicKey(n.addr), lamports: n.add }));
	const sig = await sendAndConfirmTransaction(conn, tx, [funder], { commitment: 'confirmed' });
	sent += batch.length;
	console.log(`  funded ${batch.map((b) => b.name).join(', ')} (${sent}/${need.length}) ${sig.slice(0, 12)}…`);
}
console.log(`\ndone — ${sent} agents funded to ${PER} SOL. funder now ${sol(await conn.getBalance(funder.publicKey))} SOL`);
process.exit(0);
