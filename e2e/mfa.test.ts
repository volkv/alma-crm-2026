import { expect, test as base, type Locator } from '@playwright/test';
import { STAFF_ADMIN_STATE, type StoredFactor } from './global-setup';
import { codeAt, signInWithPassword } from './helpers/mfa';

/**
 * Второй фактор глазами человека: от принудительной регистрации при первом
 * входе до сброса фактора администратором.
 *
 * Проверки идут по порядку и в одном рабочем процессе: у них общая учётная
 * запись, которую первая из них заводит, вторая снабжает фактором, а последняя
 * этого фактора лишает. Ломать этот порядок нельзя — каждая следующая
 * начинается там, где кончилась предыдущая.
 */
base.describe.configure({ mode: 'serial' });

/** Раздел пользователей и настройки закрыты для демонстрации: нужен штатный. */
const staff = base.extend<object>({ storageState: STAFF_ADMIN_STATE });

/**
 * Учётная запись проверки. Роль администратора — та, которой политика по
 * умолчанию требует фактор; почта своя на каждый прогон, потому что учётные
 * записи не удаляются, а выключаются.
 */
const PROBE = {
	email: `mfa-probe-${Date.now().toString(36)}@example.org`,
	fullName: 'Петров Пётр',
	password: 'Проверка-Входа1'
};

/** Что унёс бы человек с экрана регистрации: ключ и резервные коды. */
let probeFactor: StoredFactor | null = null;

/**
 * Открывает всплывающий слой — диалог, меню, список выбора — и дожидается его.
 *
 * Слой открывает код страницы, а не браузер: нажатие до того, как страница
 * ожила, до обработчика не доходит и теряется совсем.
 */
async function openLayer(trigger: Locator, layer: Locator): Promise<void> {
	await expect(async () => {
		await trigger.click();
		await expect(layer).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });
}

staff('администратор заводит учётную запись, которой фактор обязателен', async ({ page }) => {
	await page.goto('/settings/users');

	const dialog = page.getByRole('dialog');
	await openLayer(page.getByRole('button', { name: 'Добавить пользователя' }), dialog);

	await dialog.getByLabel('Рабочая почта').fill(PROBE.email);
	await dialog.getByLabel('Имя и фамилия').fill(PROBE.fullName);
	// Не `getByLabel('Роль')`: «Пароль» содержит то же слово внутри себя.
	const role = page.getByRole('option', { name: 'Администратор' });
	await openLayer(dialog.getByRole('button', { name: /^Роль/ }), role);
	await role.click();
	await dialog.getByLabel('Пароль').fill(PROBE.password);
	await dialog.getByRole('button', { name: 'Завести пользователя' }).click();

	await expect(page.getByText(`Пользователь ${PROBE.fullName} заведён`)).toBeVisible();

	await page.goto(`/settings/users?q=${encodeURIComponent(PROBE.email)}`);
	const row = page.getByRole('row').filter({ hasText: PROBE.email });
	await expect(row.getByText('нет')).toBeVisible();
});

base('вход по паролю приводит на регистрацию фактора, а не в приложение', async ({ page }) => {
	await signInWithPassword(page, PROBE.email, PROBE.password);

	await page.waitForURL('**/login/mfa**');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Подключение второго фактора');

	// Сессия неполная: пароль назван, второго шага нет. В приложение она не
	// пускает и публичным API не признаётся — иначе фактор обходился бы тем, что
	// человек просто не пошёл на второй шаг.
	const app = await page.request.get('/', { maxRedirects: 0 });
	expect(app.status()).toBe(303);
	expect(app.headers()['location']).toBe('/login/mfa?next=%2F');

	const api = await page.request.get('/api/v1/organizations');
	expect(api.status()).toBe(401);

	const secret = (await page.getByTestId('totp-secret').innerText()).replace(/\s/g, '');

	// Неверный код не подключает фактор.
	await page.getByLabel('Код из приложения').fill('000000');
	await page.getByRole('button', { name: 'Подключить', exact: true }).click();
	await expect(page.getByText(/Код не подошёл/)).toBeVisible();

	await page.getByLabel('Код из приложения').fill(codeAt(secret));
	await page.getByRole('button', { name: 'Подключить', exact: true }).click();

	// Резервные коды показываются один раз — до того, как вход закроется.
	const list = page.getByTestId('backup-codes');
	await expect(list).toBeVisible();
	const backupCodes = await list.getByRole('listitem').allInnerTexts();
	expect(backupCodes).toHaveLength(10);

	probeFactor = { secret, backupCodes };

	await page.getByRole('button', { name: 'Я записал коды, продолжить' }).click();

	await expect(page).toHaveURL('/');
	await expect(page.getByRole('button', { name: PROBE.fullName })).toBeVisible();
});

base('второй вход спрашивает код, и один и тот же код второй раз не проходит', async ({ page }) => {
	const factor = probeFactor;
	expect(factor).not.toBeNull();
	if (factor === null) return;

	await signInWithPassword(page, PROBE.email, PROBE.password);

	await page.waitForURL('**/login/mfa**');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Подтверждение входа');

	await page.getByLabel('Код или резервный код').fill('000000');
	await page.getByRole('button', { name: 'Подтвердить' }).click();
	await expect(page.getByText('Код не подошёл')).toBeVisible();

	// Код следующего шага: тем, что показывало приложение при регистрации, уже
	// воспользовались.
	const code = codeAt(factor.secret, 1);

	await page.getByLabel('Код или резервный код').fill(code);
	await page.getByRole('button', { name: 'Подтвердить' }).click();
	await expect(page).toHaveURL('/');

	// Тот же код на второй вход не годится, хотя его окно ещё не закрылось:
	// подсмотренный код — это одна попытка, а не полминуты доступа.
	await page.context().clearCookies();
	await signInWithPassword(page, PROBE.email, PROBE.password);
	await page.waitForURL('**/login/mfa**');

	await page.getByLabel('Код или резервный код').fill(code);
	await page.getByRole('button', { name: 'Подтвердить' }).click();
	await expect(page.getByText('Этот код уже использован — дождитесь следующего')).toBeVisible();
	await expect(page).toHaveURL(/\/login\/mfa/);
});

base('резервный код впускает один раз и больше не работает', async ({ page }) => {
	const factor = probeFactor;
	expect(factor).not.toBeNull();
	if (factor === null) return;

	const code = factor.backupCodes[0];

	await signInWithPassword(page, PROBE.email, PROBE.password);
	await page.waitForURL('**/login/mfa**');

	await page.getByLabel('Код или резервный код').fill(code);
	await page.getByRole('button', { name: 'Подтвердить' }).click();
	await expect(page).toHaveURL('/');

	// Профиль показывает, что код списан: их девять из десяти.
	await page.goto('/settings/profile');
	await expect(page.getByText('9 из 10')).toBeVisible();

	await page.context().clearCookies();
	await signInWithPassword(page, PROBE.email, PROBE.password);
	await page.waitForURL('**/login/mfa**');

	await page.getByLabel('Код или резервный код').fill(code);
	await page.getByRole('button', { name: 'Подтвердить' }).click();
	await expect(page.getByText('Код не подошёл')).toBeVisible();
});

base('со второго шага можно уйти и войти другой учётной записью', async ({ page }) => {
	await signInWithPassword(page, PROBE.email, PROBE.password);
	await page.waitForURL('**/login/mfa**');

	// Человек, вошедший не в ту учётную запись или оставшийся без приложения,
	// иначе заперт: гвардия неполную сессию никуда не пускает, а форма входа
	// уводит обратно на этот же шаг.
	//
	// Клик обёрнут по той же причине, что и открытие слоёв выше: страница
	// перезагрузилась после отправки пароля, и первый клик может прийтись на
	// разметку, которую гидратация вот-вот заменит. Повтор безопасен — выход
	// гасит сессию, которой уже нет, и всё равно ведёт на форму входа.
	await expect(async () => {
		await page.getByRole('button', { name: 'Войти другой учётной записью' }).click();
		await expect(page).toHaveURL('/login', { timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	await expect(page.getByLabel('Рабочая почта')).toBeVisible();

	// Неполная сессия погашена, а не просто оставлена позади: второй шаг больше
	// не открывается и уводит на форму входа. Перенаправление загрузчика
	// относительное («../login»), поэтому сверяется хвост, а не строка целиком.
	const step = await page.request.get('/login/mfa', { maxRedirects: 0 });
	expect(step.status()).toBe(303);
	expect(step.headers()['location']).toMatch(/login\?next=%2F$/);
});

staff('администратор видит фактор в списке и сбрасывает его', async ({ page }) => {
	await page.goto(`/settings/users?q=${encodeURIComponent(PROBE.email)}`);

	const row = page.getByRole('row').filter({ hasText: PROBE.email });
	await expect(row.getByText('Подключён')).toBeVisible();

	const confirmation = page.getByRole('alertdialog');
	await openLayer(row.getByRole('button', { name: 'Сбросить фактор' }), confirmation);
	await confirmation.getByRole('button', { name: 'Сбросить' }).click();

	await expect(
		page.getByText('Второй фактор сброшен, сессии этой учётной записи завершены')
	).toBeVisible();

	await page.goto(`/settings/users?q=${encodeURIComponent(PROBE.email)}`);
	await expect(
		page.getByRole('row').filter({ hasText: PROBE.email }).getByText('нет')
	).toBeVisible();
});

base('после сброса вход снова начинается с регистрации', async ({ page }) => {
	await signInWithPassword(page, PROBE.email, PROBE.password);

	await page.waitForURL('**/login/mfa**');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Подключение второго фактора');
	// Прежний ключ отозван вместе с фактором: страница показывает новый.
	const secret = (await page.getByTestId('totp-secret').innerText()).replace(/\s/g, '');
	expect(secret).not.toBe(probeFactor?.secret);
});

staff('политика второго фактора правится в общих настройках', async ({ page }) => {
	await page.goto('/settings/general');

	const card = page.locator('[data-slot="card"]').filter({ hasText: 'Второй фактор входа' });

	// Галочка — не нативный `input`, а контрол bits-ui с ролью `checkbox`.
	await expect(card.getByRole('checkbox', { name: 'Администратор' })).toBeChecked();
	await expect(card.getByRole('checkbox', { name: 'Менеджер' })).not.toBeChecked();

	await card.getByLabel('Доверенные сети').fill('198.51.100.0/24\n2001:db8::/32');
	await card.getByRole('button', { name: 'Сохранить политику' }).click();

	await expect(page.getByText('Политика второго фактора сохранена')).toBeVisible();

	// Запись, которая не является сетью, до настройки не доходит и говорит, что
	// именно не разобрано.
	await card.getByLabel('Доверенные сети').fill('198.51.100.7/24');
	await card.getByRole('button', { name: 'Сохранить политику' }).click();
	await expect(page.getByText(/Не разобраны как сеть/)).toBeVisible();

	await page.reload();
	await expect(card.getByLabel('Доверенные сети')).toHaveValue('198.51.100.0/24\n2001:db8::/32');

	// Стенд возвращается к состоянию, в котором его застали: соседние проверки
	// входят из адреса, который в этих сетях не лежит, но полагаться на это
	// значило бы оставлять за собой настройку, которой не было.
	await card.getByLabel('Доверенные сети').fill('');
	await card.getByRole('button', { name: 'Сохранить политику' }).click();
	await expect(page.getByText('Политика второго фактора сохранена')).toBeVisible();
});

/**
 * Фактор самого штатного администратора проверяется не здесь, а там, где он
 * нужен по делу: `admin.test.ts` входит им по паролю и коду через общий хелпер.
 * Второго такого входа в прогоне быть не должно — секрет один на все файлы, а
 * код одноразовый, и две параллельные проверки разобрали бы одно и то же окно.
 */
staff('профиль знает про фактор и не даёт снять обязательный', async ({ page }) => {
	await page.goto('/settings/profile');

	await expect(page.getByText('10 из 10')).toBeVisible();
	// Фактор обязателен для роли: отключить его владелец не может.
	await expect(
		page.getByText(/Для вашей роли второй фактор обязателен по политике доступа/)
	).toBeVisible();
	await expect(page.getByRole('button', { name: 'Отключить фактор' })).toHaveCount(0);

	// А перевыпуск резервных кодов — его собственное дело.
	await expect(page.getByRole('button', { name: 'Выпустить новые коды' })).toBeVisible();
});
