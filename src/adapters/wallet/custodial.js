// agent-sniper — custodial Wallet adapter.
//
// For a hosted, multi-tenant deployment where the operator holds (encrypted)
// keys on behalf of users — e.g. three.ws's `agent_identities.encrypted_solana_
// secret`. You supply a single async `resolve(agentId, ctx)` that returns a
// Keypair (decrypting on demand from your own KMS/secret box); this adapter adds
// a short TTL cache so a long-lived process doesn't re-decrypt on every trade.
//
// SECURITY: cache hits keep key material in process memory for up to ttlMs;
// expired entries are evicted. The cache is keyed by (userId, agentId), so a
// keypair resolved for one user is never handed to a request made on behalf of
// another: if `resolve` enforces ownership, a cache hit cannot bypass it. The
// resolve callback is the right place to write your decrypt audit row — it's
// invoked once per (cold) load, never on a cache hit, which is the correct
// audit semantics (no key left the process on a hit).

const DEFAULT_TTL_MS = 5 * 60_000;

/**
 * @param {object} opts
 * @param {(agentId: string, ctx: { userId?: string, reason?: string }) =>
 *   Promise<import('@solana/web3.js').Keypair|null>} opts.resolve
 * @param {number} [opts.ttlMs]
 * @returns {import('../../types.js').Wallet & { clearCache: () => void }}
 */
export function createCustodialWallet(opts) {
	if (typeof opts?.resolve !== 'function') {
		throw new Error('[agent-sniper] createCustodialWallet requires a resolve(agentId, ctx) callback');
	}
	const ttlMs = Math.max(0, opts.ttlMs ?? DEFAULT_TTL_MS);
	/** @type {Map<string, { keypair: import('@solana/web3.js').Keypair, at: number }>} */
	const cache = new Map();
	const keyOf = (agentId, ctx) => `${ctx.userId ?? ''}\u0000${agentId}`;

	function evictExpired(now) {
		for (const [k, v] of cache) if (now - v.at >= ttlMs) cache.delete(k);
	}

	return {
		clearCache() { cache.clear(); },

		async loadKeypair(agentId, ctx = {}) {
			const now = Date.now();
			evictExpired(now);
			const key = keyOf(agentId, ctx);
			const hit = cache.get(key);
			if (hit) return { keypair: hit.keypair, address: hit.keypair.publicKey.toBase58() };

			const keypair = await opts.resolve(agentId, ctx);
			if (!keypair) return null;
			if (ttlMs > 0) cache.set(key, { keypair, at: Date.now() });
			return { keypair, address: keypair.publicKey.toBase58() };
		},
	};
}

export default createCustodialWallet;
