import type { Page } from '@playwright/test';
import { seedId } from '../scripts/seed/ids';
import { expect, test } from './fixtures';

/**
 * Тост, переживший переход, — на обычной загрузке страницы.
 *
 * Формы без `use:enhance` (архив организации, закрытие полномочий) уходят
 * браузером: ответ 303 приводит к полной загрузке адреса с `?done=<код>`, а не
 * к клиентскому переходу. Это единственный путь, на котором `?done` встречает
 * гидратацию, поэтому проверяется он, а не переход внутри приложения.
 *
 * Клиентское исключение здесь стоит отдельной проверки: оно обрывает
 * гидратацию молча — разметка на месте, а страница уже не отвечает ни на один
 * щелчок. Поэтому каждый тест ловит `pageerror` и нажимает что-нибудь после.
 */

/** Организация из сида; тест её только читает. */
const ORGANIZATION_ID = seedId('organization', 'szpu');

/** Метка прогона: делает названия уникальными в общей базе. */
function tag(): string {
	return crypto.randomUUID().slice(0, 8);
}

/** Копилка клиентских исключений вкладки. */
function clientErrors(page: Page): string[] {
	const messages: string[] = [];
	page.on('pageerror', (error) => messages.push(error.message));

	return messages;
}

test('ссылка с ?done показывает тост и оставляет страницу живой', async ({ page }) => {
	const errors = clientErrors(page);

	await page.goto(`/organizations/${ORGANIZATION_ID}?done=updated`);

	await expect(page.getByText('Изменения сохранены')).toBeVisible();
	// Параметр убран: перезагрузка и пересланная ссылка не повторят тост.
	await expect(page).toHaveURL(`/organizations/${ORGANIZATION_ID}`);

	// Диалог открывается только на гидратированном дереве — им и проверяется,
	// что страница осталась интерактивной.
	await page.getByRole('button', { name: 'В архив' }).click();
	await expect(page.getByRole('alertdialog')).toContainText('Перевести организацию в архив?');
	await page.getByRole('button', { name: 'Отмена' }).click();

	expect(errors).toEqual([]);
});

test('архив организации доводит тост до списка', async ({ page }) => {
	const errors = clientErrors(page);
	const shortName = `Вуз ${tag()}`;

	await page.goto('/organizations/new');
	await page.getByLabel('Полное наименование').fill(`Полное наименование: ${shortName}`);
	await page.getByLabel('Краткое наименование').fill(shortName);
	await page.getByRole('button', { name: 'Создать организацию' }).click();

	await expect(page.getByRole('heading', { level: 1 })).toHaveText(shortName);

	// Форма архива уходит браузером: дальше идёт полная загрузка списка с `?done`.
	await page.getByRole('button', { name: 'В архив' }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'В архив' }).click();

	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Организации');
	await expect(page.getByText('Организация переведена в архив')).toBeVisible();
	await expect(page).toHaveURL('/organizations');

	// Кнопка сработала, а не только показала тост.
	await page.getByLabel('Поиск по названию, ИНН, региону').fill(shortName);

	const rows = page.locator('[data-slot="data-table"] tbody tr[data-row]');
	await expect(rows).toHaveCount(1);
	await expect(rows.first()).toContainText('В архиве');

	expect(errors).toEqual([]);
});
