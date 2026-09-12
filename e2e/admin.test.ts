import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test as base, type Page } from '@playwright/test';

/**
 * Журнал и настройки глазами администратора.
 *
 * Тест начинается с вошедшего администратора. Общая фикстура (`./fixtures`)
 * впускает менеджера, а журнал и настройки для него закрыты правами, поэтому
 * здесь свой вход. Делается он один раз на рабочий процесс: счётчик попыток
 * входа с адреса общий, и прогон не должен упираться в защиту, рассчитанную на
 * живого человека.
 */
const test = base.extend<object, { adminState: string }>({
	adminState: [
		async ({ browser }, use, workerInfo) => {
			const baseURL = workerInfo.project.use.baseURL;

			if (baseURL === undefined) {
				throw new Error('playwright.config.ts must set baseURL');
			}

			const directory = path.join(workerInfo.project.outputDir, '.auth');
			await mkdir(directory, { recursive: true });
			const file = path.join(directory, `admin-${workerInfo.workerIndex}.json`);

			const context = await browser.newContext({ baseURL });
			const page = await context.newPage();

			await page.goto('/login');
			await page.getByRole('button', { name: 'Войти как администратор' }).click();
			// Имя демонстрационной учётной записи зависит от того, чем залита база,
			// поэтому вход подтверждается адресом, а не подписью в меню.
			await expect(page).toHaveURL('/');

			await context.storageState({ path: file });
			await context.close();

			await use(file);
		},
		{ scope: 'worker' }
	],

	storageState: ({ adminState }, use) => use(adminState)
});

/**
 * Проверки идут по порядку и в одном рабочем процессе: последняя из них выходит
 * из системы, а тесты, которые читают один и тот же журнал, понятнее, когда
 * известно, что в нём уже произошло.
 */
test.describe.configure({ mode: 'serial' });

/** Почта у каждого прогона своя: учётные записи не удаляются, а выключаются. */
const runId = Date.now().toString(36);

/** Меню учётной записи в верхней панели: подпись в нём зависит от данных. */
function accountMenu(page: Page) {
	return page.getByRole('banner').getByRole('button').last();
}

test('журнал показывает событие входа', async ({ page }) => {
	await page.goto('/audit');

	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Журнал действий');

	const row = page.getByRole('row').filter({ hasText: 'Вход в систему' }).first();
	await expect(row).toBeVisible();
	await expect(row).toContainText('Интерфейс');
	await expect(row).toContainText('Успех');
});

test('строка журнала раскрывается в карточку события', async ({ page }) => {
	await page.goto('/audit?type=auth.login');

	await page.getByRole('cell', { name: 'Вход в систему' }).first().click();

	const card = page.getByRole('dialog');
	await expect(card.getByText('auth.login')).toBeVisible();
	await expect(card.getByText('Демонстрационный вход')).toBeVisible();
});

test('заведение пользователя видно в списке', async ({ page }) => {
	const email = `vetrov-${runId}@example.org`;

	await page.goto('/settings/users');
	await page.getByRole('button', { name: 'Добавить пользователя' }).click();

	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('Рабочая почта').fill(email);
	await dialog.getByLabel('Имя и фамилия').fill('Ветров Игорь');
	// Не `getByLabel('Роль')`: «Пароль» содержит то же слово внутри себя.
	await dialog.getByRole('button', { name: /^Роль/ }).click();
	await page.getByRole('option', { name: 'Наблюдатель' }).click();
	await dialog.getByLabel('Пароль').fill('Проверка-Входа1');
	await dialog.getByRole('button', { name: 'Завести пользователя' }).click();

	await expect(page.getByRole('cell', { name: email })).toBeVisible();
});

test('фильтр по типу события меняет список и адрес', async ({ page }) => {
	await page.goto('/audit');

	await expect(page.getByRole('cell', { name: 'Вход в систему' }).first()).toBeVisible();

	await page.getByRole('button', { name: 'Событие' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Пользователь заведён' }).click();
	await page.keyboard.press('Escape');

	await expect(page).toHaveURL(/[?&]type=users\.created/);
	await expect(page.getByRole('cell', { name: 'Пользователь заведён' }).first()).toBeVisible();
	await expect(page.getByRole('cell', { name: 'Вход в систему' })).toHaveCount(0);
});

test('выпущенный ключ показывается один раз', async ({ page }) => {
	await page.goto('/settings/api-keys');
	await page.getByRole('button', { name: 'Выпустить ключ' }).click();

	const form = page.getByRole('dialog');
	await form.getByLabel('Название').fill(`Выгрузка ${runId}`);
	await form.getByLabel('Владелец').click();
	// Именно в списке владельцев: на странице есть ещё и выбор размера страницы.
	await page.getByRole('listbox').getByRole('option').first().click();
	await form.getByRole('button', { name: 'Выпустить ключ' }).click();

	const issued = page.getByRole('dialog');
	await expect(issued.getByText(`Ключ «Выгрузка ${runId}» выпущен`)).toBeVisible();
	expect(await issued.getByLabel('Ключ доступа').inputValue()).toMatch(/^lct_[A-Za-z0-9_-]{32}$/);

	await issued.getByRole('button', { name: 'Готово' }).click();

	// Второй раз ключа нет нигде: в списке только название и состояние.
	await expect(page.getByRole('cell', { name: `Выгрузка ${runId}` })).toBeVisible();
	await expect(page.getByText(/^lct_/)).toHaveCount(0);
});

test('правка баннера видна на странице входа после выхода', async ({ page }) => {
	const marker = `Проверка баннера ${runId}`;

	await page.goto('/settings/general');

	const text = page.getByLabel('Текст');
	const original = await text.inputValue();
	await text.fill(`${original} ${marker}`);
	await page.getByRole('button', { name: 'Сохранить баннер' }).click();
	await expect(page.getByText('Баннер страницы входа сохранён')).toBeVisible();

	await accountMenu(page).click();
	await page.getByRole('menuitem', { name: 'Выйти' }).click();

	await expect(page).toHaveURL('/login');
	await expect(page.getByText(marker)).toBeVisible();

	// Настройка общая на всю базу, поэтому текст возвращается как был.
	await page.getByRole('button', { name: 'Войти как администратор' }).click();
	await page.goto('/settings/general');
	await page.getByLabel('Текст').fill(original);
	await page.getByRole('button', { name: 'Сохранить баннер' }).click();
	await expect(page.getByText('Баннер страницы входа сохранён')).toBeVisible();
});
