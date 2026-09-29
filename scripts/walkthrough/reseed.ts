/**
 * Возвращает демо-данные стенда к эталону тем же путём, что и человек: вход
 * администратором демо, кнопка «Сбросить демо-данные» на `/settings/general`.
 *
 * Отдельной логики сброса здесь нет и не должно быть — она уже есть,
 * `resetDemoData` (`src/lib/server/demo/reset.ts`), и вызывается ровно этой
 * кнопкой. Скрипт только нажимает её через настоящий браузер: второй, более
 * короткий путь до того же результата разошёлся бы с первым на первой же
 * правке сброса.
 *
 * Запуск: node --env-file-if-exists=.env scripts/walkthrough/reseed.ts <baseUrl>
 */
import { chromium } from '@playwright/test';
import { dismissOnboardingTour } from './onboarding.ts';

const PASSWORD = process.env.WALK_DEMO_PASSWORD ?? 'lct-demo-2026';
const RESET_BUTTON = 'Сбросить демо-данные';

async function main(): Promise<void> {
	const baseUrl = process.argv[2] ?? 'http://localhost:3000';

	const browser = await chromium.launch();
	const context = await browser.newContext();
	const page = await context.newPage();

	try {
		await page.goto(`${baseUrl}/login`);
		await page.waitForURL(/\/realms\/lct\/protocol\/openid-connect\/auth/);
		await page.locator('#username').fill('admin');
		await page.locator('#password').fill(PASSWORD);
		await page.locator('#kc-login').click();
		await page.waitForURL((url) => !url.toString().includes('/realms/'));

		await page.goto(`${baseUrl}/settings/general`);
		// Первый вход администратором демо в свежем браузере открывает тур
		// подсказок, и его подложка перекрывает кнопку сброса.
		await dismissOnboardingTour(page);
		await page.getByRole('button', { name: RESET_BUTTON, exact: true }).click();

		const dialog = page.getByRole('alertdialog');
		await dialog.getByRole('button', { name: RESET_BUTTON, exact: true }).click();
		// Сброс идёт транзакциями движка на 128 взаимодействиях и может занять
		// заметное время; диалог закрывается, только когда действие отработало.
		await dialog.waitFor({ state: 'hidden', timeout: 120_000 });

		console.log('Демо-данные сброшены к эталону.');
	} finally {
		await context.close();
		await browser.close();
	}
}

await main();
