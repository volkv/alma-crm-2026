import { expect, test as base, type Locator } from '@playwright/test';
import { seedId } from '../scripts/seed/ids';
import { ADMIN_STATE } from './global-setup';

/**
 * Журнал и настройки глазами администратора.
 *
 * Общая фикстура (`./fixtures`) впускает менеджера, а журнал и настройки для
 * него закрыты правами, поэтому здесь своя сессия — та, что приготовил
 * глобальный сетап.
 */
const test = base.extend<object>({ storageState: ADMIN_STATE });

/**
 * Проверки идут по порядку и в одном рабочем процессе: тесты, которые читают
 * один и тот же журнал, понятнее, когда известно, что в нём уже произошло.
 */
test.describe.configure({ mode: 'serial' });

/** Почта у каждого прогона своя: учётные записи не удаляются, а выключаются. */
const runId = Date.now().toString(36);

/**
 * Демонстрационный администратор — тот, которого завёл сид. Журнал общий на всю
 * базу, и без отбора по действующему лицу самой свежей записью о входе
 * оказывается чужая: рядом идут проверки входа по паролю.
 */
const ADMIN_ID = seedId('user', 'demo-admin');

/**
 * Открывает всплывающий слой — диалог, меню, список выбора — и дожидается его.
 *
 * Слой открывает код страницы, а не браузер: нажатие до того, как страница
 * ожила, до обработчика не доходит и теряется совсем, второго шанса нет.
 * Поэтому нажимаем, пока слой не появится, — ждать фиксированную паузу значило
 * бы закладываться на скорость машины (см. `docs/development.md`, «Всплывающие
 * слои»).
 */
async function openLayer(trigger: Locator, layer: Locator): Promise<void> {
	await expect(async () => {
		await trigger.click();
		await expect(layer).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });
}

test('журнал показывает событие входа', async ({ page }) => {
	await page.goto(`/audit?actor=${ADMIN_ID}`);

	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Журнал действий');

	const row = page.getByRole('row').filter({ hasText: 'Вход в систему' }).first();
	await expect(row).toBeVisible();
	await expect(row).toContainText('Интерфейс');
	await expect(row).toContainText('Успех');
});

test('строка журнала раскрывается в карточку события', async ({ page }) => {
	await page.goto(`/audit?type=auth.login&actor=${ADMIN_ID}`);

	const card = page.getByRole('dialog');

	await openLayer(
		page.getByRole('cell', { name: 'Вход в систему' }).first(),
		card.getByText('auth.login')
	);

	await expect(card.getByText('Демонстрационный вход')).toBeVisible();
});

test('заведение пользователя видно в списке', async ({ page }) => {
	const email = `vetrov-${runId}@example.org`;

	await page.goto('/settings/users');

	const dialog = page.getByRole('dialog');
	await openLayer(page.getByRole('button', { name: 'Добавить пользователя' }), dialog);

	await dialog.getByLabel('Рабочая почта').fill(email);
	await dialog.getByLabel('Имя и фамилия').fill('Ветров Игорь');
	// Не `getByLabel('Роль')`: «Пароль» содержит то же слово внутри себя.
	const role = page.getByRole('option', { name: 'Наблюдатель' });
	await openLayer(dialog.getByRole('button', { name: /^Роль/ }), role);
	await role.click();
	await dialog.getByLabel('Пароль').fill('Проверка-Входа1');
	await dialog.getByRole('button', { name: 'Завести пользователя' }).click();

	await expect(page.getByText('Пользователь Ветров Игорь заведён')).toBeVisible();

	// Список общий на всю базу и от прогона к прогону только растёт, поэтому
	// свежей записи на первой странице может не быть вовсе. Ищем её тем же
	// способом, каким ищет человек, — отбором по почте.
	await page.goto(`/settings/users?q=${encodeURIComponent(email)}`);

	const row = page.getByRole('row').filter({ hasText: email });
	await expect(row.getByRole('cell', { name: email })).toBeVisible();
	await expect(row.getByText('Работает')).toBeVisible();

	// Учётная запись прогона тут же выключается: удалить её нельзя — за ней
	// стоят записи журнала, — а действующей в общем списке ей делать нечего.
	const confirmation = page.getByRole('alertdialog');
	await openLayer(row.getByRole('button', { name: 'Выключить' }), confirmation);
	await confirmation.getByRole('button', { name: 'Выключить' }).click();

	await expect(page.getByText('Учётная запись выключена, её сессии завершены')).toBeVisible();

	await page.goto(`/settings/users?q=${encodeURIComponent(email)}`);
	await expect(
		page.getByRole('row').filter({ hasText: email }).getByText('Выключен')
	).toBeVisible();
});

test('фильтр по типу события меняет список и адрес', async ({ page }) => {
	await page.goto('/audit');

	const option = page.getByRole('menuitemcheckbox', { name: 'Вход в систему' });
	await openLayer(page.getByRole('button', { name: /^Событие/ }), option);
	await option.click();
	await page.keyboard.press('Escape');

	await expect(page).toHaveURL(/[?&]type=auth\.login(&|$)/);

	// Журнал общий на всю базу, пишется без остановки и соседними проверками
	// тоже, поэтому что попало в него до фильтра — не проверка. Проверка в том,
	// что после фильтра на странице нет ни одной строки другого события: входы
	// в журнале есть всегда (ими начинается прогон), а всё прочее отобрано.
	const logins = page.getByRole('cell', { name: 'Вход в систему', exact: true });
	await expect(logins.first()).toBeVisible();

	const rows = page.locator('[data-slot="data-table"] tbody tr');
	await expect(logins).toHaveCount(await rows.count());
});

test('выпущенный ключ показывается один раз', async ({ page }) => {
	await page.goto('/settings/api-keys');

	const form = page.getByRole('dialog');
	// Кнопка раздела, а не такая же кнопка внутри диалога: он уезжает порталом
	// в конец страницы и в `main` не попадает.
	await openLayer(page.getByRole('main').getByRole('button', { name: 'Выпустить ключ' }), form);

	await form.getByLabel('Название').fill(`Выгрузка ${runId}`);
	// Именно в списке владельцев: на странице есть ещё и выбор размера страницы.
	const owners = page.getByRole('listbox');
	await openLayer(form.getByLabel('Владелец'), owners);
	await owners.getByRole('option').first().click();
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

	// Сессия администратора одна на весь прогон, поэтому здесь не выход, а
	// свежий браузер без кук: выход гасит сессию в Redis, и соседние файлы
	// прогона остались бы без неё. Сам выход проверяет `auth.test.ts`.
	await page.context().clearCookies();
	await page.goto('/login');

	await expect(page.getByText(marker)).toBeVisible();

	// Настройка общая на всю базу, поэтому текст возвращается как был.
	await page.getByRole('button', { name: 'Войти как администратор' }).click();
	await page.goto('/settings/general');
	await page.getByLabel('Текст').fill(original);
	await page.getByRole('button', { name: 'Сохранить баннер' }).click();
	await expect(page.getByText('Баннер страницы входа сохранён')).toBeVisible();
});
