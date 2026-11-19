// agent-sniper — self-custodial Wallet adapter.
//
// Keys never leave the machine. Each agent maps to a local ed25519 Keypair,
// loaded from (in priority order):
//   1. an in-memory map passed to the constructor (agentId → secret)
//   2. SNIPER_WALLET_<AGENTID> env (base58 or JSON array secret key)
//   3. a keystore directory of `<agentId>.json` files (Solana CLI keypair format);
//      only ids made of letters, digits, '.', '_' and '-' are looked up there
//   4. a single default keypair (SOLANA_SECRET_KEY / --keypair) for one-agent runs
//
// Accepts base58 strings, JSON byte arrays (`[12,34,...]`), and 0x-hex secrets.

import fs from 'node:fs';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * @param {unknown} raw
 * @param {string} source  where the secret came from, for the error message
 */
function decodeSecret(raw, source) {
	if (!raw) return null;
	const s = String(raw).trim();
	try {
		if (s.startsWith('[')) {
			const arr = Uint8Array.from(JSON.parse(s));
			return Keypair.fromSecretKey(arr);
		}
		if (s.startsWith('0x')) {
			const bytes = Uint8Array.from(Buffer.from(s.slice(2), 'hex'));
			return Keypair.fromSecretKey(bytes);
		}
		return Keypair.fromSecretKey(bs58.decode(s));
	} catch {
		// Never echo the underlying error: JSON.parse messages quote the input,
		// which here is key material.
		throw new Error(`[agent-sniper] could not decode the wallet secret from ${source} (expected base58, a JSON byte array, or 0x-hex)`);
	}
}

// Agent ids that may name a keystore file: no path separators, no dot-only
// names, bounded length. Anything else could read a file outside the keystore.
const KEYSTORE_ID_RE = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;

/**
 * Path of `<agentId>.json` inside `dir`, or null when the id is not a safe file
 * name (so `../../.config/solana/id` cannot load the operator's own key).
 * @param {string} dir
 * @param {string} agentId
 */
function keystorePath(dir, agentId) {
	if (!KEYSTORE_ID_RE.test(agentId)) return null;
	const root = path.resolve(dir);
	const file = path.resolve(root, `${agentId}.json`);
	return path.dirname(file) === root ? file : null;
}

function envKeyFor(agentId) {
	// SNIPER_WALLET_<AGENTID> with non-alphanumerics → underscore, uppercased.
	return `SNIPER_WALLET_${String(agentId).replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`;
}

/**
 * @param {object} [opts]
 * @param {Record<string, string>} [opts.secrets]   agentId → secret (base58/json/hex)
 * @param {string} [opts.keystoreDir]               dir of <agentId>.json keypairs
 * @param {string} [opts.defaultSecret]             fallback secret for any agentId (single-wallet mode)
 * @returns {import('../../types.js').Wallet}
 */
export function createSelfCustodyWallet(opts = {}) {
	const cache = new Map(); // agentId → Keypair
	const inline = new Map(Object.entries(opts.secrets || {}));
	const keystoreDir = opts.keystoreDir || process.env.SNIPER_KEYSTORE_DIR || null;
	const defaultSecret = opts.defaultSecret || process.env.SOLANA_SECRET_KEY || null;

	function resolve(agentId) {
		if (cache.has(agentId)) return cache.get(agentId);

		let kp = null;
		if (inline.has(agentId)) kp = decodeSecret(inline.get(agentId), `secrets["${agentId}"]`);
		if (!kp && process.env[envKeyFor(agentId)]) kp = decodeSecret(process.env[envKeyFor(agentId)], envKeyFor(agentId));
		if (!kp && keystoreDir) {
			const file = keystorePath(keystoreDir, String(agentId));
			if (file && fs.existsSync(file)) kp = decodeSecret(fs.readFileSync(file, 'utf8'), file);
		}
		if (!kp && defaultSecret) kp = decodeSecret(defaultSecret, 'the default secret');

		if (kp) cache.set(agentId, kp);
		return kp;
	}

	return {
		async loadKeypair(agentId) {
			const keypair = resolve(agentId);
			if (!keypair) return null;
			return { keypair, address: keypair.publicKey.toBase58() };
		},
	};
}

export default createSelfCustodyWallet;
