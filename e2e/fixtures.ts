import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test as base } from '@playwright/test';

/**
 * Тест, который начинается с уже вошедшего пользователя.
 *
 * Вход делается один раз на рабочий процесс, а не на тест: состояние браузера
 * сохраняется в файл, и каждый тест получает свежий контекст с теми же куками.
 * Так проверки страниц остаются про страницы, а счётчик попыток входа с адреса
 * не тратится на подготовку — с одной машины их разрешено ограниченное число,
 * и прогон не должен упираться в защиту, рассчитанную на живого человека.
 */
export const test = base.extend<object, { signedInState: string }>({
	signedInState: [
		async ({ browser }, use, workerInfo) => {
			const baseURL = workerInfo.project.use.baseURL;

			if (baseURL === undefined) {
				throw new Error('playwright.config.ts must set baseURL');
			}

			const directory = path.join(workerInfo.project.outputDir, '.auth');
			await mkdir(directory, { recursive: true });
			const file = path.join(directory, `worker-${workerInfo.workerIndex}.json`);

			const context = await browser.newContext({ baseURL });
			const page = await context.newPage();

			await page.goto('/login');
			await page.getByRole('button', { name: 'Войти как менеджер' }).click();
			await expect(page.getByRole('button', { name: 'Демонстрация: Менеджер' })).toBeVisible();

			await context.storageState({ path: file });
			await context.close();

			await use(file);
		},
		{ scope: 'worker' }
	],

	storageState: ({ signedInState }, use) => use(signedInState)
});

export { expect };
