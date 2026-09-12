import { expect, test } from './fixtures';
import { waitForHydration } from './helpers/hydration';

/**
 * Справочники в браузере: форма, список и карточка.
 *
 * Проверяется путь целиком — от кнопки до строки в таблице, — потому что между
 * контрактом и базой стоят ещё разметка формы, действие и переход, и ломается
 * обычно именно там. Данные каждый тест заводит свои: база прогона общая, и
 * тест, который ищет чужую строку, однажды найдёт не ту.
 */

/** Метка прогона: делает названия уникальными в общей базе. */
function tag(): string {
	return crypto.randomUUID().slice(0, 8);
}

/**
 * ИНН с верной контрольной суммой ФНС. Проверку считает
 * `src/lib/validation/inn.ts`; здесь номер именно генерируется, а не берётся
 * готовым: ИНН в базе уникален, и постоянный номер пережил бы только один прогон.
 */
function validInn(): string {
	const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
	const digits = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
	const control = (digits.reduce((sum, digit, i) => sum + digit * weights[i], 0) % 11) % 10;

	return [...digits, control].join('');
}

test('организация заводится формой и появляется в списке', async ({ page }) => {
	const shortName = `Вуз ${tag()}`;

	await page.goto('/organizations');
	await page.getByRole('link', { name: 'Новая организация' }).click();

	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Новая организация');

	await page.getByLabel('Полное наименование').fill(`Полное наименование: ${shortName}`);
	await page.getByLabel('Краткое наименование').fill(shortName);
	await page.getByLabel('ИНН').fill(validInn());
	await page.getByLabel('Регион').fill('Москва');
	await page.getByRole('button', { name: 'Создать организацию' }).click();

	await expect(page.getByRole('heading', { level: 1 })).toHaveText(shortName);
	await expect(page.getByText('Организация создана')).toBeVisible();

	await page.goto('/organizations');
	await page.getByLabel('Поиск по названию, ИНН, региону').fill(shortName);

	const rows = page.locator('[data-slot="data-table"] tbody tr[data-row]');
	await expect(rows).toHaveCount(1);
	await expect(rows.first()).toContainText(shortName);
});

test('форма объясняет неверный ИНН словами', async ({ page }) => {
	await page.goto('/organizations/new');

	await page.getByLabel('Полное наименование').fill('Организация с опечаткой в ИНН');
	await page.getByLabel('Краткое наименование').fill('Опечатка');
	// Десять цифр, но контрольная сумма не сходится — длиной такую ошибку не поймать.
	await page.getByLabel('ИНН').fill('7707083890');
	await page.getByRole('button', { name: 'Создать организацию' }).click();

	await expect(
		page.getByText('ИНН должен состоять из 10 или 12 цифр и проходить проверку контрольной суммы')
	).toBeVisible();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Новая организация');
});

test('на карточке организации добавляется площадка', async ({ page }) => {
	const shortName = `Вуз ${tag()}`;
	const siteName = `Корпус ${tag()}`;

	await page.goto('/organizations/new');
	await page.getByLabel('Полное наименование').fill(`Полное наименование: ${shortName}`);
	await page.getByLabel('Краткое наименование').fill(shortName);
	await page.getByRole('button', { name: 'Создать организацию' }).click();

	await expect(page.getByRole('heading', { level: 1 })).toHaveText(shortName);
	await expect(page.getByText('Площадок пока нет')).toBeVisible();

	await page.getByRole('link', { name: 'Добавить площадку' }).click();
	await page.getByLabel('Название площадки').fill(siteName);
	await page.getByLabel('Адрес').fill('Москва, Приборостроительная улица, 5');
	await page.getByRole('button', { name: 'Добавить площадку' }).click();

	await expect(page.getByRole('heading', { level: 1 })).toHaveText(shortName);
	await expect(page.getByText('Площадка добавлена')).toBeVisible();
	await expect(page.getByRole('cell', { name: siteName })).toBeVisible();
});

test('список людей ищет по фамилии', async ({ page }) => {
	const lastName = `Петров${tag()}`;

	await page.goto('/people/new');
	await page.getByLabel('Фамилия').fill(lastName);
	// Подпись обязательного поля — «Имя *», поэтому по началу строки, а не целиком.
	await page.getByLabel(/^Имя/).fill('Пётр');
	await page.getByLabel('Электронная почта').fill('petrov@vuz.example');
	await page.getByRole('button', { name: 'Завести человека' }).click();

	await expect(page.getByRole('heading', { level: 1 })).toContainText(lastName);

	await page.goto('/people');
	await page.getByLabel('Поиск по ФИО и организации').fill(lastName);

	const rows = page.locator('[data-slot="data-table"] tbody tr[data-row]');
	await expect(rows).toHaveCount(1);
	await expect(rows.first()).toContainText(lastName);
});

test('справочник организаций снят для обзора', async ({ page }) => {
	const shortName = `Вуз ${tag()}`;

	await page.goto('/organizations/new');
	// Форму ведёт `use:enhance`: пока он не встал, отправка уходит обычным
	// POST-ом на `?/create`, и снимок карточки достаётся странице, которая ещё
	// не ожила. Повторить отправку нечем — она одна и уводит со страницы.
	await waitForHydration(page);

	await page.getByLabel('Полное наименование').fill(`Полное наименование: ${shortName}`);
	await page.getByLabel('Краткое наименование').fill(shortName);
	await page.getByLabel('ИНН').fill(validInn());
	await page.getByLabel('Регион').fill('Москва');
	await page.getByRole('button', { name: 'Создать организацию' }).click();

	await expect(page.getByRole('heading', { level: 1 })).toHaveText(shortName);
	await page.screenshot({ path: 'test-results/directory-organization-card.png', fullPage: true });

	await page.goto('/organizations');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Организации');
	await page.screenshot({ path: 'test-results/directory-organizations.png', fullPage: true });
});
