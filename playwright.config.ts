import { defineConfig, devices } from '@playwright/test';

/**
 * Порт прогона: свой у каждого, чтобы на одной машине помещалось два.
 *
 * Значение по умолчанию — 4173; второй прогон запускается из отдельной рабочей
 * копии со своим `E2E_PORT` (см. «Параллельные прогоны» в `docs/development.md`).
 */
const port = Number(process.env.E2E_PORT ?? 4173);

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
	throw new Error(`E2E_PORT must be a TCP port number, got «${process.env.E2E_PORT}»`);
}

const origin = `http://localhost:${port}`;

/**
 * Состояние прогона тоже своё на каждый порт, иначе от второго прогона спасал бы
 * один только свободный порт: соседний сетап залил бы ту же базу заново, а общий
 * счётчик попыток входа сбросился бы посреди проверки лимита.
 *
 * База PostgreSQL заводится глобальным сетапом в том же сервере из
 * `docker-compose.yml`; логических баз у Redis шестнадцать, поэтому номер — это
 * остаток от деления порта. Прогоны на соседних портах не пересекаются, а порты,
 * отличающиеся ровно на 16, делят счётчики — берите соседний.
 */
const databaseUrl = `postgres://lct:lct@localhost:55432/lct_e2e_${port}`;
const redisUrl = `redis://localhost:56379/${port % 16}`;

/**
 * The end-to-end suite runs against a production build backed by the PostgreSQL
 * and Redis services from docker-compose.yml, which `pnpm run test:e2e` starts
 * first. The values below are fixed on purpose: the suite must behave the same
 * on a laptop and in CI, so it does not read the developer's .env.
 */
export default defineConfig({
	testDir: 'e2e',
	testMatch: '**/*.test.ts',
	fullyParallel: true,
	forbidOnly: Boolean(process.env.CI),
	retries: 0,
	// `list` — чтобы прогон было видно в терминале и в логе CI, `html` — чтобы
	// после падения было что открыть: без него каталог отчёта пуст, и выгружать
	// из CI нечего.
	reporter: [['list'], ['html', { open: 'never' }]],
	// Повторов нет, поэтому трасса снимается на каждом падении: иначе
	// единственный шанс разобраться в упавшем прогоне CI пропадает вместе с ним.
	use: { baseURL: origin, trace: 'retain-on-failure' },
	// Миграции, каталог ролей и учётные записи прогона — до первого запроса к
	// приложению: страница входа читает настройки из базы.
	globalSetup: './e2e/global-setup.ts',
	projects: [
		{
			name: 'chromium',
			use: devices['Desktop Chrome'],
			testIgnore: '**/login-limit.test.ts'
		},
		{
			// Проверка лимита входа выбирает счётчик попыток, общий на весь прогон:
			// рядом с ней не должно идти ничего, что входит в систему. Поэтому она
			// вынесена в свой проект — один рабочий процесс, файлы по одному, старт
			// после того, как обычный проект закончил. Запустить её отдельно:
			// `playwright test --project=login-limit --no-deps`.
			name: 'login-limit',
			use: devices['Desktop Chrome'],
			testMatch: '**/login-limit.test.ts',
			dependencies: ['chromium'],
			fullyParallel: false,
			workers: 1
		}
	],
	webServer: {
		command: 'pnpm run build && node build/index.js',
		port,
		timeout: 180_000,
		reuseExistingServer: false,
		stdout: 'pipe',
		stderr: 'pipe',
		env: {
			NODE_ENV: 'production',
			PORT: String(port),
			ORIGIN: origin,
			DATABASE_URL: databaseUrl,
			REDIS_URL: redisUrl,
			GOTENBERG_URL: 'http://localhost:3001',
			SMTP_HOST: 'localhost',
			SMTP_PORT: '1025',
			// Потолок тела запроса у adapter-node: тот же, что в compose. С его
			// умолчанием (512K) загрузка обычного скана отваливается с 413 —
			// `e2e/documents.test.ts` этим и сторожит значение.
			BODY_SIZE_LIMIT: '27M',
			// Демонстрационный вход — часть проверяемого поведения.
			DEMO_MODE: 'true',
			TRUST_PROXY: 'false',
			DATA_DIR: '.playwright/data'
		}
	}
});
