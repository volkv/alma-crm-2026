import { expect, test } from './fixtures';
import { waitForHydration } from './helpers/hydration';

/**
 * Договор глазами менеджера: от карточки контрагента до карточки
 * взаимодействия.
 *
 * Дорога одна и целая: договор заводят там, где он живёт, — у контрагента, — а
 * взаимодействие его только выбирает вместе с нужными позициями. Проверять её
 * по частям бессмысленно: ломается она на стыке, где позиция обязана
 * принадлежать выбранному договору, а продукт позиции — составу записи.
 */

/** Метка прогона: база общая, и тест, который ищет чужую строку, найдёт не ту. */
function tag(): string {
	return crypto.randomUUID().slice(0, 8);
}

/**
 * ИНН с верной контрольной суммой ФНС: номер в базе уникален, поэтому он
 * именно генерируется, а не берётся готовым.
 */
function validInn(): string {
	const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
	const digits = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
	const control = (digits.reduce((sum, digit, index) => sum + digit * weights[index], 0) % 11) % 10;

	return [...digits, control].join('');
}

test('договор заводится на карточке вуза и доезжает до карточки взаимодействия', async ({
	page
}) => {
	const mark = tag();
	const shortName = `Вуз договора ${mark}`;
	const contractNumber = `ДГ-${mark}`;
	const transferStatus = 'передан вузу';

	// Вуз заводит сам менеджер: автор становится ответственным, иначе карточка
	// пропала бы из его области сразу после создания.
	await page.goto('/organizations/new');
	await waitForHydration(page);
	await page.getByLabel('Полное наименование').fill(`Полное наименование: ${shortName}`);
	await page.getByLabel('Краткое наименование').fill(shortName);
	await page.getByLabel('ИНН').fill(validInn());
	await page.getByRole('button', { name: 'Создать организацию' }).click();

	await expect(page.getByRole('heading', { level: 1 })).toHaveText(shortName);

	// Форма договора открывается кнопкой, а кнопка живёт в клиентском коде:
	// нажатие до гидратации не доходит до компонента и теряется совсем.
	const contractForm = page.getByTestId('contract-form');

	await expect(async () => {
		if (!(await contractForm.isVisible())) {
			await page.getByRole('button', { name: 'Добавить договор' }).click();
		}

		await expect(contractForm).toBeVisible({ timeout: 3000 });
	}).toPass({ timeout: 20_000 });

	await page.getByLabel(/^Номер договора/).fill(contractNumber);
	await page.getByRole('button', { name: 'Сохранить договор' }).click();

	await expect(page.getByText('Договор сохранён')).toBeVisible();
	await expect(page.getByText(`№ ${contractNumber}`)).toBeVisible();

	// Позиция договора: продукт берётся первым из каталога стенда, и его же
	// придётся отметить в составе взаимодействия — иначе позиция описывала бы
	// продукт, которого в работе нет.
	const itemForm = page.getByTestId('contract-item-form');

	await expect(async () => {
		if (!(await itemForm.isVisible())) {
			await page.getByRole('button', { name: 'Добавить позицию' }).click();
		}

		await expect(itemForm).toBeVisible({ timeout: 3000 });
	}).toPass({ timeout: 20_000 });

	const productLabel = (await page.getByLabel(/^Продукт/).textContent())?.trim() ?? '';

	expect(productLabel).not.toBe('');

	await page.getByLabel(/^Статус по передаче/).fill(transferStatus);
	await page.getByRole('button', { name: 'Сохранить позицию' }).click();

	await expect(page.getByText('Позиция договора сохранена')).toBeVisible();
	await expect(page.getByRole('cell', { name: productLabel })).toBeVisible();

	// Взаимодействие выбирает договор контрагента и его позицию.
	const title = `Работа по договору ${mark}`;

	await page.goto('/interactions/new');
	await waitForHydration(page);

	const picker = page.getByLabel(/^Учебное заведение/);
	const option = page.getByRole('button', { name: shortName });

	await expect(async () => {
		await picker.fill('');
		await picker.pressSequentially(mark, { delay: 20 });
		await expect(option).toBeVisible({ timeout: 3000 });
	}).toPass({ timeout: 20_000 });

	await option.click();
	await page.getByLabel(/^Название/).fill(title);

	await page
		.getByRole('group', { name: 'Продукты' })
		.getByRole('checkbox', { name: productLabel })
		.click();

	// Список договоров — всплывающий слой: он появляется из прозрачности, и
	// читать разметку в том же кадре бесполезно.
	const contractSelect = page.getByLabel(/^Договор контрагента/);
	const contractOption = page.getByRole('option', { name: new RegExp(`№ ${contractNumber}`) });

	await expect(async () => {
		if (!(await contractOption.isVisible())) {
			await contractSelect.click();
		}

		await expect(contractOption).toBeVisible({ timeout: 3000 });
	}).toPass({ timeout: 20_000 });

	await contractOption.click();

	const positions = page.getByRole('group', { name: 'Позиции договора' });

	await positions.getByRole('checkbox').first().click();
	await page.getByRole('button', { name: 'Создать взаимодействие' }).click();

	await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);

	// Карточка называет договор и коммерческие условия по его позиции: за этим
	// в неё и приходят, когда спрашивают «на каких условиях передан продукт».
	await page.goto(`${page.url().split('?')[0]}?tab=plan`);

	const panel = page.getByTestId('contract-panel');

	// Именно строка «Номер», а не любое совпадение: номер договора стоит и в
	// выпадающем списке формы, которой его меняют.
	await expect(panel.locator('dd', { hasText: `№ ${contractNumber}` })).toBeVisible();
	await expect(panel.getByRole('cell', { name: productLabel })).toBeVisible();
	await expect(panel.getByRole('cell', { name: transferStatus })).toBeVisible();
});
