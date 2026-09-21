import { readFileSync } from 'node:fs';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';

const pkg: { version: string } = JSON.parse(
	readFileSync(new URL('./package.json', import.meta.url), 'utf8')
);

export default defineConfig({
	// `host`/`allowedHosts`: имитаторы сайта и системы обучения стоят в Docker, а
	// dev-сервер — на хосте, и обратный ход обмена (заявка с сайта, результаты
	// групп) идёт из контейнера в CRM по имени шлюза `host.docker.internal`.
	// Vite по умолчанию слушает петлю и отвергает чужое `Host:` — из контейнера
	// это выглядело бы обрывом связи, а кнопка «Демо: заявка с сайта» отвечала бы
	// «Не удалось отправить: fetch failed». Адрес CRM имитаторам задаёт
	// `MOCK_CRM_BASE_URL` в `.env`.
	server: {
		// strictPort: `ORIGIN` в `.env` и адреса возврата в realm Keycloak названы
		// портом 5173. Занят он — прежний dev-сервер обычно и держит, — и Vite молча
		// уходит на 5174: страницы открываются, а вход через каталог учётных записей
		// уже нет. Лучше отказ на старте с понятной причиной.
		port: 5173,
		strictPort: true,
		host: true,
		allowedHosts: ['host.docker.internal']
	},
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
			// Проверку происхождения формы делает хук `csrf`: встроенная отвечает
			// английской фразой фреймворка, которую нельзя ни перевести, ни
			// дополнить. Доверие «любому адресу» здесь означает «фреймворк не
			// проверяет», а не «проверки нет» — см. `src/lib/server/hooks/csrf.ts`.
			csrf: { trustedOrigins: ['*'] },
			// Everything the app needs comes from its own origin. `auto` lets Kit hash
			// the scripts and styles it inlines itself, so no blanket `unsafe-inline`
			// is needed for scripts. Widen a directive only together with the feature
			// that needs it.
			csp: {
				mode: 'auto',
				directives: {
					'default-src': ['self'],
					'script-src': ['self'],
					// Svelte sets element styles inline; there is no hash for those.
					'style-src': ['self', 'unsafe-inline'],
					'img-src': ['self', 'data:'],
					'font-src': ['self'],
					'frame-ancestors': ['none'],
					'object-src': ['none'],
					'base-uri': ['self']
				}
			},
			typescript: {
				config: (config) => {
					config.include.push(
						'../drizzle.config.ts',
						'../playwright.config.ts',
						'../eslint.config.js',
						'../prettier.config.js',
						'../scripts/**/*.ts',
						'../tests/**/*.ts',
						'../e2e/**/*.ts',
						// Имитаторы стенда: кода приложения не импортируют, но типами
						// проверяются вместе со всем остальным — иначе стенд ломался бы
						// молча, уже на прогоне.
						'../mocks/**/*.ts'
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
