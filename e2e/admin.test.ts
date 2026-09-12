import { expect, test as base, type Locator } from '@playwright/test';
import { seedId } from '../scripts/seed/ids';
import { DEMO_EMAILS } from '../scripts/seed/users';
import { ADMIN_STATE, STAFF_ADMIN_STATE } from './global-setup';
import { loginStaffAdmin } from './helpers/mfa';

/**
 * Журнал и настройки глазами администратора.
 *
 * Общая фикстура (`./fixtures`) впускает менеджера, а журнал и настройки для
 * него закрыты правами, поэтому здесь свои сессии — те, что приготовил
 * глобальный сетап.
 *
 * Администраторов два, и разница между ними — предмет отдельной проверки.
 * `test` — демонстрационный: стенд идёт с `DEMO_MODE=true`, и такая сессия не
 * получает прав, которые пережили бы демонстрацию. `staff` — штатный
 * администратор оператора, вошедший по паролю; ему доступно всё.
 */
const test = base.extend<object>({ storageState: ADMIN_STATE });
const staff = base.extend<object>({ storageState: STAFF_ADMIN_STATE });

/**
 * Проверки идут по порядку и в одном рабочем процессе: тесты, которые читают
 * один и тот же журнал, понятнее, когда известно, что в нём уже произошло.
 */
base.describe.configure({ mode: 'serial' });

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

staff('заведение пользователя видно в списке', async ({ page }) => {
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

	const off = page.getByRole('row').filter({ hasText: email });
	await expect(off.getByText('Выключен')).toBeVisible();

	// Выключение обратимо: человек, которого выключили по ошибке, возвращается
	// к работе с прежним паролем, а не заводится заново другой почтой.
	await off.getByRole('button', { name: 'Включить' }).click();
	await expect(page.getByText('Учётная запись включена, вход открыт')).toBeVisible();

	await page.goto(`/settings/users?q=${encodeURIComponent(email)}`);

	const on = page.getByRole('row').filter({ hasText: email });
	await expect(on.getByText('Работает')).toBeVisible();

	// И снова выключается: действующей в общем списке записи прогона делать нечего.
	await openLayer(on.getByRole('button', { name: 'Выключить' }), confirmation);
	await confirmation.getByRole('button', { name: 'Выключить' }).click();
	await expect(page.getByText('Учётная запись выключена, её сессии завершены')).toBeVisible();
});

staff('демонстрационную учётную запись выключить нечем', async ({ page }) => {
	const email = DEMO_EMAILS.viewer;

	await page.goto(`/settings/users?q=${encodeURIComponent(email)}`);

	const row = page.getByRole('row').filter({ hasText: email });

	// Именно значок в колонке состояния: слово «Демо» стоит ещё и в имени.
	await expect(row.getByTitle('Учётная запись публичной демонстрации')).toBeVisible();
	await expect(row.getByText('Работает')).toBeVisible();

	// Ею входят все, кто открыл стенд, а включить её обратно оттуда же будет
	// некому: кнопка «Войти как …» исчезнет вместе с записью.
	await expect(row.getByRole('button', { name: 'Выключить' })).toHaveCount(0);
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

test('фильтр по периоду принимает дату в русском виде и уносит её в адрес', async ({ page }) => {
	await page.goto('/audit');

	// Поле пишет и читает `01.01.2026`, а в адрес уходит календарный день так,
	// как его понимает сервер.
	await page.getByLabel('Период с').fill('01.01.2026');

	await expect(page).toHaveURL(/[?&]from=2026-01-01(&|$)/);
	await expect(page.getByLabel('Период с')).toHaveValue('01.01.2026');
});

staff('выпущенный ключ показывается один раз', async ({ page }) => {
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

test('журнал демонстрации открыт, но без выгрузки и без чужих адресов', async ({ page }) => {
	await page.goto('/audit');

	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Журнал действий');

	// Выгрузка уносит со стенда адреса, клиентов и всю историю действий — её у
	// демонстрации нет ни кнопкой, ни ссылкой.
	await expect(page.getByRole('link', { name: 'Экспорт CSV' })).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'Экспорт JSON' })).toHaveCount(0);

	const denied = await page.request.get('/audit/export?format=csv');
	expect(denied.status()).toBe(403);

	// Адрес в журнале настоящий и принадлежит посетителю, а не стенду: демонстрации
	// он показывается огрублённым до сети.
	const address = page
		.locator('[data-slot="data-table"] tbody tr td')
		.filter({ hasText: /^\d+\.\d+\.\*\.\*$/ });

	await expect(address.first()).toBeVisible();
});

test('разделы, которые переживают демонстрацию, ей не принадлежат', async ({ page }) => {
	await page.goto('/settings/profile');

	// Меню настроек собирается из прав: чего нет в нём, того нет и по ссылке.
	for (const section of ['Пользователи', 'Ключи доступа', 'Общие настройки']) {
		await expect(page.getByRole('link', { name: section })).toHaveCount(0);
	}

	for (const path of ['/settings/users', '/settings/api-keys', '/settings/general']) {
		const response = await page.request.get(path);
		expect(response.status()).toBe(403);
	}
});

staff('правка баннера видна на странице входа после выхода', async ({ page }) => {
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

	// Настройка общая на всю базу, поэтому текст возвращается как был. Входим
	// штатным администратором: кнопка «Войти как администратор» открывает
	// демонстрационную сессию, а ей настройки не принадлежат. Пароля ему мало —
	// его роль по политике защищена вторым фактором (см. `helpers/mfa`).
	await loginStaffAdmin(page);

	await page.goto('/settings/general');
	await page.getByLabel('Текст').fill(original);
	await page.getByRole('button', { name: 'Сохранить баннер' }).click();
	await expect(page.getByText('Баннер страницы входа сохранён')).toBeVisible();
});
