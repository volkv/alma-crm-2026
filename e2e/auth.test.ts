import { expect, test } from '@playwright/test';
import { E2E_USER, E2E_PASSWORD, NO_ROLE_ACCOUNT } from './global-setup';
import { skipOnboardingTour } from './helpers/onboarding';
import { signInThroughDirectory } from './helpers/sign-in';

/**
 * Вход глазами посетителя: без сессии внутрь не попасть, почту и пароль
 * спрашивает каталог учётных записей, после входа человек оказывается там, куда
 * шёл, а после выхода — снова у нашей страницы входа. Тесты нарочно берут
 * обычный `test`, а не фикстуру с готовой сессией: проверяется именно то, что
 * фикстура для остальных обходит. Здесь же — то, что человек видит вместо
 * страницы: отказ и «нет такой записи» остаются внутри приложения.
 */

/**
 * Файл идёт одним рабочим процессом и по порядку: каталог защищён от быстрых
 * повторных попыток (`quickLoginCheckMilliSeconds` Keycloak), и восемь
 * параллельных входов одной и той же учётной записью он справедливо принимает за
 * перебор — проверять мы стали бы его защиту, а не свой вход.
 */
test.describe.configure({ mode: 'serial' });

/** Идентификатор верной формы, которого нет ни в одной таблице стенда. */
const ABSENT_ID = '00000000-0000-4000-8000-0000000000ff';

test('без сессии любая страница приложения отправляет на вход', async ({ page }) => {
	await page.goto('/');

	await expect(page).toHaveURL('/login?next=%2F');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(
		'Система контроля взаимодействия с учебными заведениями'
	);
	await expect(
		page.getByText('Доступ только для сотрудников. Действия в системе записываются в журнал.')
	).toBeVisible();
});

test('вход через каталог открывает оболочку приложения', async ({ page }) => {
	await signInThroughDirectory(page, E2E_USER);

	await expect(page).toHaveURL('/');
	// Между нажатием и этой проверкой стоят два перехода: в каталог и обратно.
	// Пяти секунд умолчания на это мало, когда машина занята.
	await expect(page.getByRole('button', { name: E2E_USER.fullName })).toBeVisible({
		timeout: 15_000
	});
});

test('страница входа перечисляет демонстрационные учётные записи и общий пароль', async ({
	page
}) => {
	await page.goto('/login');

	const accounts = page.getByTestId('demo-accounts');

	await expect(accounts).toContainText('manager');
	await expect(accounts).toContainText('lead');
	await expect(accounts).toContainText('admin');

	// Пароль стенда публичный: зритель показа должен войти с экрана, никого не
	// спрашивая. Показывается тот, что действительно пускает, — глобальный сетап
	// сверяет `DEMO_PASSWORD_HINT` с паролем, который ставит каталогу.
	await expect(page.getByTestId('demo-password')).toContainText(E2E_PASSWORD);
});

test('неверный пароль каталог объясняет сам и в систему не пускает', async ({ page }) => {
	// Отдельная учётная запись: неудачная попытка поднимает счётчик защиты от
	// перебора в каталоге, и портить им запись, которой входят остальные
	// проверки, незачем.
	await signInThroughDirectory(page, {
		login: NO_ROLE_ACCOUNT.login,
		password: 'совсем не тот'
	});

	// Разбирается с этим каталог: на его же странице и остаёмся, а в приложении
	// сессии не появляется.
	await expect(page).toHaveURL(/\/realms\/lct\//);

	await page.goto('/');
	await expect(page).toHaveURL('/login?next=%2F');
});

test('учётная запись без роли получает понятный отказ, а не пустой экран', async ({ page }) => {
	await signInThroughDirectory(page, NO_ROLE_ACCOUNT);

	await expect(page).toHaveURL(/\/login\/callback/);
	await expect(page.getByTestId('login-failure')).toContainText('Доступ в систему вам не назначен');

	// Сессии при этом не завелось: отказ во входе — это отказ, а не половина входа.
	await page.goto('/');
	await expect(page).toHaveURL('/login?next=%2F');
});

test('после входа человек возвращается туда, куда шёл', async ({ page }) => {
	await page.goto('/ui-kit');

	await expect(page).toHaveURL('/login?next=%2Fui-kit');

	await signInThroughDirectory(page, E2E_USER, { startAt: '/login?next=%2Fui-kit' });

	await expect(page).toHaveURL('/ui-kit');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('UI-кит');
});

test('адрес на чужой сайт в next никуда не уводит', async ({ page }) => {
	await signInThroughDirectory(page, E2E_USER, {
		startAt: '/login?next=https://example.org/steal'
	});

	// Проверка — в самом ожидаемом адресе: вход обязан привести на главную, а не
	// на чужой сайт из строки запроса.
	await expect(page).toHaveURL('/');
});

test('выход возвращает к форме входа и закрывает страницы приложения', async ({ page }) => {
	await signInThroughDirectory(page, E2E_USER);
	await expect(page).toHaveURL('/');

	// Первый вход в чистом браузере начинается с подсказок, и они стоят слоем
	// поверх страницы: дальше проверка нажимает на меню учётной записи.
	await skipOnboardingTour(page);

	// Меню учётной записи открывается кодом на странице, а не браузером:
	// нажатие до того, как страница ожила, не доходит до компонента. Поэтому
	// нажимаем, пока меню не откроется, — ждать фиксированную паузу значило бы
	// закладываться на скорость машины.
	await expect(async () => {
		await page.getByRole('button', { name: E2E_USER.fullName }).click();
		await expect(page.getByRole('menuitem', { name: 'Выйти' })).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	await page.getByRole('menuitem', { name: 'Выйти' }).click();

	// Выход гасит и сессию каталога, поэтому браузер проходит через его адрес
	// выхода и возвращается на нашу страницу входа.
	await expect(page).toHaveURL(/\/login\?reason=signed-out/, { timeout: 15_000 });

	await page.goto('/ui-kit');
	await expect(page).toHaveURL('/login?next=%2Fui-kit');
});

test('после выхода каталог спрашивает пароль заново', async ({ page }) => {
	await signInThroughDirectory(page, E2E_USER);
	await expect(page).toHaveURL('/');

	await page.request.post('/logout');
	await page.goto('/login');
	await page.getByRole('button', { name: 'Войти', exact: true }).click();

	// Сессия каталога погашена вместе с нашей: иначе человек на общем компьютере
	// вошёл бы обратно одним нажатием, не увидев формы.
	await expect(page.locator('#password')).toBeVisible({ timeout: 15_000 });
});

test('гвардия разворачивает анонима на вход и помнит, куда он шёл', async ({ page }) => {
	const response = await page.request.get('/audit', { maxRedirects: 0 });

	expect(response.status()).toBe(303);
	expect(response.headers()['location']).toBe('/login?next=%2Faudit');
});

test('форма на странице с погасшей сессией уводит на вход, а не в пятисотую', async ({ page }) => {
	await signInThroughDirectory(page, E2E_USER);
	await expect(page).toHaveURL('/');

	// Подсказки первого входа стоят слоем поверх страницы, а дальше проверка
	// заполняет форму. Признак «показаны» остаётся в браузере до конца проверки.
	await skipOnboardingTour(page);

	await page.goto('/organizations/new');
	await page.getByLabel('Полное наименование').fill('Организация без сессии');
	await page.getByLabel('Краткое наименование').fill('Без сессии');

	// Сессия гаснет между открытием страницы и отправкой формы — ровно так это и
	// выглядит у человека, который заполнял её полчаса.
	await page.context().clearCookies();

	await page.getByRole('button', { name: 'Создать организацию' }).click();

	// Форму отправляет код страницы, и ответом ему обязан быть конверт, который
	// он умеет читать. Готовая разметка страницы входа вместо него ломала бы
	// разбор, и человек вместо формы входа видел бы «внутреннюю ошибку».
	await expect(page).toHaveURL(/\/login\?next=%2Forganizations%2Fnew/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(
		'Система контроля взаимодействия с учебными заведениями'
	);
	await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeVisible();
});

test('отказ по правам остаётся внутри оболочки приложения', async ({ page }) => {
	await signInThroughDirectory(page, E2E_USER);
	await expect(page).toHaveURL('/');

	const response = await page.goto('/audit');
	expect(response?.status()).toBe(403);

	// Разделы и меню учётной записи на месте: человек не выпал из системы.
	await expect(page.getByRole('button', { name: E2E_USER.fullName })).toBeVisible();

	// Текст — тот, что написал сервер, а не общее «что-то пошло не так».
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Доступ закрыт');
	await expect(
		page.getByText('Журнал действий доступен только с правом «Просмотр журнала действий»')
	).toBeVisible();
	await expect(page.getByRole('link', { name: 'На главную' })).toBeVisible();
});

test('записи нет — 404 в оболочке, адреса нет — 404 без неё', async ({ page }) => {
	await signInThroughDirectory(page, E2E_USER);
	await expect(page).toHaveURL('/');

	const missing = await page.goto(`/organizations/${ABSENT_ID}`);
	expect(missing?.status()).toBe(404);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Страница не найдена');
	await expect(page.getByRole('button', { name: E2E_USER.fullName })).toBeVisible();

	// Идентификатор, который не может быть нашим, до загрузчика не доходит:
	// такого адреса в приложении нет, и оболочка тут ни при чём.
	const malformed = await page.goto('/organizations/abc');
	expect(malformed?.status()).toBe(404);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Страница не найдена');
	await expect(page.getByRole('button', { name: E2E_USER.fullName })).toBeHidden();
});

test('вход штатным администратором открывает то, чего нет у демонстрации', async ({ page }) => {
	await signInThroughDirectory(page, {
		login: 'staff-admin',
		password: E2E_PASSWORD
	});

	await expect(page).toHaveURL('/');

	await page.goto('/settings/users');
	await expect(page.getByRole('heading', { level: 1 })).toContainText('Пользователи');
});
