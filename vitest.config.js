import { defineConfig } from 'vitest/config';

// Self-contained config for @three-ws/agent-sniper so its suite runs in
// isolation from the monorepo root config (which scopes its own include globs
// and Vite plugins to platform code). These tests are pure-logic + in-memory
// adapters — no network, no RPC, no Vite transform needs.
export default defineConfig({
	test: {
		include: ['test/**/*.test.js'],
		environment: 'node',
	},
});
