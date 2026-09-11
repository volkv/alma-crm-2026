import { readFileSync } from 'node:fs';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';

const pkg: { version: string } = JSON.parse(
	readFileSync(new URL('./package.json', import.meta.url), 'utf8')
);

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			// Exposed as `version` from `$app/environment` and reported by /api/health.
			version: { name: pkg.version },
			typescript: {
				config: (config) => {
					config.include.push(
						'../drizzle.config.ts',
						'../playwright.config.ts',
						'../eslint.config.js',
						'../prettier.config.js',
						'../scripts/**/*.ts',
						'../tests/**/*.ts',
						'../e2e/**/*.ts'
					);
				}
			}
		})
	],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'unit',
					environment: 'node',
					include: ['tests/unit/**/*.test.ts']
				}
			},
			{
				extends: './vite.config.ts',
				test: {
					name: 'integration',
					environment: 'node',
					include: ['tests/integration/**/*.test.ts'],
					// Pulling and booting a PostgreSQL container is far slower than a unit test.
					testTimeout: 120_000,
					hookTimeout: 300_000,
					// Containers are a shared, port-bound resource: run these files one at a time.
					fileParallelism: false
				}
			}
		]
	}
});
