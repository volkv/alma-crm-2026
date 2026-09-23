import { expect, test as base, type Locator } from '@playwright/test';
import { seedId } from '../scripts/seed/ids';
import { DEMO_EMAILS } from '../scripts/seed/users';
import { ADMIN_STATE, STAFF_ADMIN, STAFF_ADMIN_STATE } from './global-setup';
import { waitForHydration } from './helpers/hydration';
import { signInThroughDirectory } from './helpers/sign-in';

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
 * администратор оператора; ему доступно всё.
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

staff('раздел пользователей ведёт иерархию, а роль приходит из каталога', async ({ page }) => {
	const email = DEMO_EMAILS.manager;

	await page.goto(`/settings/users?q=${encodeURIComponent(email)}`);

	const row = page.getByRole('row').filter({ hasText: email });
	await expect(row.getByRole('cell', { name: email })).toBeVisible();
	await expect(row).toContainText('Менеджер');

	// Заводить запись руками нечем: она появляется сама при первом входе, а роль
	// приходит утверждением токена.
	await expect(page.getByRole('button', { name: 'Добавить пользователя' })).toHaveCount(0);
	await expect(page.getByText('Роль и имя приходят из каталога учётных записей')).toBeVisible();

	// Руководитель — единственное, что раздел про сотрудника решает сам: на этой
	// иерархии держится и область доступа, и адрес эскалации.
	// Список — наш контрол, и «кто руководитель» читается с него самого: у кнопки
	// нет `value`, зато на ней написано выбранное имя, а не «— не задан —».
	const manager = page.getByRole('combobox', { name: 'Руководитель: Менеджер Демо' });

	await expect(manager).toBeVisible();
	await expect(manager).not.toHaveText('— не задан —');
});

staff('демонстрационную учётную запись выключить нечем', async ({ page }) => {
	const email = DEMO_EMAILS.lead;

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
	// Значение поля даты держит компонент: набранное до того, как страница ожила,
	// не доходит ни до него, ни до адреса.
	await waitForHydration(page);

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

test('журнал демонстрации открыт, а выгрузка огрубляет адреса так же, как экран', async ({
	page
}) => {
	await page.goto('/audit');

	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Журнал действий');

	// Журнал — часть того, что показывают, поэтому и выгрузка демонстрации
	// доступна. Условие у неё одно: она обязана уносить ровно то, что видно на
	// экране, — с тем же огрублением адреса и клиента.
	await expect(page.getByRole('link', { name: 'Экспорт CSV' })).toHaveCount(1);

	const exported = await page.request.get('/audit/export?format=csv');
	expect(exported.status()).toBe(200);

	const body = await exported.text();
	expect(body).toMatch(/\d+\.\d+\.\*\.\*/);
	expect(body).not.toContain('Mozilla/5.0');

	// Адрес в журнале настоящий и принадлежит посетителю, а не стенду: демонстрации
	// он показывается огрублённым до сети.
	const address = page
		.locator('[data-slot="data-table"] tbody tr td')
		.filter({ hasText: /^\d+\.\d+\.\*\.\*$/ });

	await expect(address.first()).toBeVisible();
});

test('демонстрации закрыты адреса подключений, а не разделы целиком', async ({ page }) => {
	await page.goto('/settings/profile');

	// Учётные записи и ключи доступа демонстрации открыты: всё, что посетитель
	// в них наменяет, возвращает суточный сброс, а спрятанный раздел читался бы
	// как отсутствующий в продукте (`DEMO_DENIED_PERMISSIONS`).
	for (const section of ['Пользователи', 'Ключи доступа', 'Общие']) {
		await expect(page.getByRole('link', { name: section, exact: true })).toHaveCount(1);
	}

	for (const path of ['/settings/users', '/settings/api-keys', '/settings/general']) {
		const response = await page.request.get(path);
		expect(response.status()).toBe(200);
	}

	// Вычтено ровно одно право — адреса и секреты подключений: они живут в
	// настройках стенда, которые сброс не чистит, и подменённый приёмник
	// подписки пережил бы показ. Раздел при этом открыт: журнал обмена и
	// состояние доставок демонстрация показывает.
	await page.goto('/settings/integrations');

	await expect(
		page.getByText('Адреса, секреты и периодичность фоновой работы меняет тот, у кого есть право')
	).toBeVisible();
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
	// штатным администратором: демонстрационной сессии настройки стенда не
	// принадлежат.
	await signInThroughDirectory(page, STAFF_ADMIN);
	await page.waitForURL('/');

	await page.goto('/settings/general');
	await page.getByLabel('Текст').fill(original);
	await page.getByRole('button', { name: 'Сохранить баннер' }).click();
	await expect(page.getByText('Баннер страницы входа сохранён')).toBeVisible();
});
