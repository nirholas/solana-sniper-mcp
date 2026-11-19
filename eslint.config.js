import js from '@eslint/js';
import globals from 'globals';

export default [
	{ ignores: ['node_modules/', 'vendor/', 'docs/', 'dist/'] },
	js.configs.recommended,
	{
		languageOptions: {
			ecmaVersion: 2023,
			sourceType: 'module',
			globals: { ...globals.node },
		},
		rules: {
			'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
		},
	},
	{
		// Playwright helpers: the bodies of page.evaluate() callbacks run in the browser.
		files: ['scripts/ui-*.mjs', 'scripts/reel.js'],
		languageOptions: { globals: { ...globals.node, ...globals.browser } },
	},
];
