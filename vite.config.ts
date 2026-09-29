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
						// Модули установки: конфиг лежит в корне, рядом с остальными.
						'../crm.config.ts',
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
		// Разобранные модули переживают прогон: на холодном старте почти всё время
		// уходило не на сами проверки, а на разбор и сборку исходников заново.
		// Слепок лежит в `node_modules`, поэтому переустановка зависимостей его и
		// обнуляет, а сам он привязан к содержимому файлов.
		fsModuleCache: true,
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
					// PostgreSQL, Redis и SeaweedFS — один набор на прогон; файл тестов берёт
					// у них свою базу, свою логическую базу Redis и свой бакет.
					globalSetup: './tests/integration/global-setup.ts',
					// Pulling and booting a PostgreSQL container is far slower than a unit test.
					testTimeout: 120_000,
					hookTimeout: 300_000,
					// Дочерний процесс на файл, а не поток. Проверок в этих файлах много,
					// и в общем процессе они тормозят друг друга тем сильнее, чем дальше
					// зашёл прогон: на трёх файлах разницы между потоком и процессом нет
					// вовсе, на всём наборе прогон под потоками идёт двадцать две минуты
					// против шести. Считанное на файл — соединения, шифрование контактов,
					// разобранные модули — потоку достаётся общее на весь процесс, и к
					// полусотне файлов этого общего накапливается больше, чем сборщик
					// мусора успевает разбирать.
					pool: 'forks',
					// Файлы по-прежнему идут по одному. Своя база, свой бакет и своя
					// логическая база Redis у каждого есть (`helpers/db.ts`), то есть
					// делить им нечего, — но и выигрыша от разом идущих файлов нет:
					// считает здесь PostgreSQL, и одному файлу он уже отдаёт несколько
					// ядер. Прогон вдвоём и вчетвером выходит той же длины (372 и 383
					// секунды против 371), а памяти просит на гигабайт-другой больше.
					fileParallelism: false
				}
			}
		]
	}
});
