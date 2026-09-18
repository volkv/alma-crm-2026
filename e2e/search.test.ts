import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { waitForHydration } from './helpers/hydration';

/**
 * Быстрый поиск в браузере: `Ctrl` + `K`, строка, выбор клавишей.
 *
 * Проверяется путь целиком — от горячей клавиши до открытой карточки, — потому
 * что между сервером и человеком стоят ещё задержка ввода, разбор ответа и
 * клавиатура списка, и ломается обычно именно там. Запись тест заводит свою:
 * база прогона общая, и тот, кто ищет чужую строку, однажды найдёт не ту.
 */

/** Метка прогона: делает название уникальным в общей базе. */
function tag(): string {
	return crypto.randomUUID().slice(0, 8);
}

/**
 * Палитру открывает только ожившая страница: горячая клавиша живёт в клиентском
 * коде, и нажатие до монтирования теряется совсем. Нажимаем, пока поле ввода не
 * появится, и только если его ещё нет — повтор вхолостую закрыл бы уже открытую
 * палитру («Всплывающие слои» в `docs/development.md`).
 */
async function openPalette(page: Page) {
	const input = page.getByPlaceholder('Что ищем?');

	await expect(async () => {
		if (!(await input.isVisible())) {
			await page.keyboard.press('Control+KeyK');
		}

		await expect(input).toBeVisible();
	}).toPass();

	return input;
}

test('поиск по Ctrl+K находит организацию, и Enter открывает её карточку', async ({ page }) => {
	const shortName = `Вуз палитры ${tag()}`;

	await page.goto('/organizations/new');
	await waitForHydration(page);
	await page.getByLabel('Полное наименование').fill(`Полное наименование: ${shortName}`);
	await page.getByLabel('Краткое наименование').fill(shortName);
	await page.getByRole('button', { name: 'Создать организацию' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(shortName);

	// Уходим со страницы записи: палитра обязана находить её откуда угодно, а не
	// только там, где её видно и так.
	await page.goto('/');
	await waitForHydration(page);

	const input = await openPalette(page);
	await input.fill(shortName);

	const hit = page.getByRole('option', { name: shortName });
	await expect(hit).toBeVisible();

	await input.press('Enter');

	await expect(page.getByRole('heading', { level: 1 })).toHaveText(shortName);
});

test('пустая строка показывает разделы, чужая — слова, Esc закрывает палитру', async ({ page }) => {
	await page.goto('/');
	await waitForHydration(page);

	const input = await openPalette(page);

	// Пустой запрос — оглавление системы: разделы те же, что в меню слева.
	await expect(page.getByRole('option', { name: 'Взаимодействия' })).toBeVisible();

	await input.fill('яьъщэфх');

	await expect(page.getByText('ничего не найдено')).toBeVisible();

	await input.press('Escape');

	await expect(input).toBeHidden();
});
