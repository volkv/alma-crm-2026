import { defineConfig, devices } from '@playwright/test';

const port = 4173;
const origin = `http://localhost:${port}`;

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
	reporter: 'list',
	use: { baseURL: origin, trace: 'on-first-retry' },
	// Миграции, каталог ролей и учётные записи прогона — до старта сервера:
	// страница входа читает настройки из базы с первого же запроса.
	globalSetup: './e2e/global-setup.ts',
	projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
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
			DATABASE_URL: 'postgres://lct:lct@localhost:55432/lct',
			REDIS_URL: 'redis://localhost:56379',
			GOTENBERG_URL: 'http://localhost:3001',
			SMTP_HOST: 'localhost',
			SMTP_PORT: '1025',
			SESSION_SECRET: 'end-to-end-tests-only-session-secret',
			// Демонстрационный вход — часть проверяемого поведения.
			DEMO_MODE: 'true',
			TRUST_PROXY: 'false',
			DATA_DIR: '.playwright/data'
		}
	}
});
