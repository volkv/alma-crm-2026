import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Прогон проверки без интернета (`offline-check.spec.ts`) против стека
 * `compose.offline-check.yml`. Свой файл, а не `playwright.config.ts` проекта:
 * здесь нет ни сервера разработки, ни базы прогона — только поднятый стек за
 * прокси `edge`, и ходит в него браузер так же, как ходил бы сотрудник из сети
 * заказчика.
 *
 * Запускает его `offline-check.sh`: он же поднимает стек и передаёт адрес,
 * пароль демонстрационных записей и ключи через окружение.
 */

const baseURL = process.env.OFFLINE_BASE_URL;
const outDir = process.env.OFFLINE_OUT_DIR;

if (baseURL === undefined || outDir === undefined) {
	throw new Error(
		'OFFLINE_BASE_URL и OFFLINE_OUT_DIR не заданы: прогон запускает scripts/offline/offline-check.sh'
	);
}

export default defineConfig({
	testDir: '.',
	testMatch: 'offline-check.spec.ts',
	outputDir: path.join(outDir, 'test-results'),
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: [['list']],
	use: {
		...devices['Desktop Chrome'],
		baseURL,
		locale: 'ru-RU',
		timezoneId: 'Europe/Moscow',
		// Браузер ходит только на петлю хоста; прокси окружения ему не нужен и
		// не должен подменять адрес стека.
		launchOptions: { args: ['--no-proxy-server'] },
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	}
});
