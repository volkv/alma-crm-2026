import { expect, test as base, type Locator } from '@playwright/test';
import { ADMIN_STATE, MANAGER_STATE } from './global-setup';

/**
 * Справочник ИТ-направлений в браузере.
 *
 * Раздел общий — его видят все, — а правит его руководитель и администратор,
 * поэтому сессий здесь две: администратор заводит направление и относит к нему
 * продукт, менеджер видит тот же список без единой кнопки записи. Данные тест
 * заводит свои: база прогона живёт дольше прогона, и направление с постоянным
 * кодом пережило бы только один раз.
 */
const test = base.extend<object>({ storageState: ADMIN_STATE });
const managerTest = base.extend<object>({ storageState: MANAGER_STATE });

/** Метка прогона: делает код и название уникальными в общей базе. */
function tag(): string {
	return crypto.randomUUID().slice(0, 8).toUpperCase();
}

/**
 * Открывает всплывающий слой и дожидается его: список выбора рисует код
 * страницы, и нажатие до того, как она ожила, теряется совсем
 * (`docs/development.md`, «Всплывающие слои»).
 */
async function openLayer(trigger: Locator, layer: Locator): Promise<void> {
	await expect(async () => {
		await trigger.click();
		await expect(layer).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });
}

test('раздел открывается из меню и показывает направления набора', async ({ page }) => {
	await page.goto('/');
	await page.getByRole('link', { name: 'Направления', exact: true }).click();

	await expect(page).toHaveURL(/\/directions$/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Направления');

	// Направления набора: по ним назначают ответственных за вуз.
	await page.getByLabel('Поиск по коду и названию').fill('DevOps');

	const rows = page.locator('[data-slot="data-table"] tbody tr[data-row]');
	await expect(rows).toHaveCount(1);
	await expect(rows.first()).toContainText('DevOps');
});

test('направление заводится формой, и к нему относят продукт', async ({ page }) => {
	const code = `QA${tag()}`;
	const name = `Тестирование ${code}`;

	await page.goto('/directions');
	await page.getByRole('link', { name: 'Новое направление' }).click();

	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Новое направление');

	await page.getByLabel('Код направления').fill(code);
	await page.getByLabel('Название').fill(name);
	await page.getByRole('button', { name: 'Создать направление' }).click();

	await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
	await expect(page.getByText('Продуктов пока нет')).toBeVisible();

	// Связь «продукт ↔ направление» заводят здесь же: список наш, поэтому
	// значение уходит скрытым полем, а не нативным `<select>`.
	const form = page.getByTestId('link-product');
	await openLayer(form.getByRole('combobox'), page.getByRole('listbox'));

	const option = page.getByRole('option').first();
	const product = (await option.textContent())?.trim() ?? '';

	expect(product).not.toBe('');
	await option.click();
	await form.getByRole('button', { name: 'Отнести' }).click();

	await expect(page.getByText('Продукт отнесён к направлению')).toBeVisible();
	await expect(page.getByRole('cell', { name: product })).toBeVisible();

	// В списке у направления теперь один продукт и ни одной программы.
	await page.goto(`/directions?q=${encodeURIComponent(code)}`);

	const row = page.getByRole('row').filter({ hasText: code });
	await expect(row).toHaveCount(1);
	await expect(row).toContainText('Действует');
});

managerTest('менеджер видит справочник, но не может его править', async ({ page }) => {
	await page.goto('/directions');

	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Направления');
	// Кнопки, которых человеку нельзя, не рисуются вовсе: ссылка, отвечающая
	// 403, — это не навигация.
	await expect(page.getByRole('link', { name: 'Новое направление' })).toHaveCount(0);

	// Спрятанная кнопка не защита: адрес формы отвечает отказом и без неё.
	const response = await page.goto('/directions/new');
	expect(response?.status()).toBe(403);
});
