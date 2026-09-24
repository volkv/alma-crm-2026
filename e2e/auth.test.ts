import { expect, test } from '@playwright/test';
import { E2E_USER, E2E_PASSWORD, NO_ROLE_ACCOUNT, STAFF_ADMIN_TOTP } from './global-setup';
import { skipOnboardingTour } from './helpers/onboarding';
import { enterSecondFactor } from './helpers/second-factor';
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

test('без сессии любая страница приложения отправляет на вход', async ({ page }) => {
	await page.goto('/');

	await expect(page).toHaveURL('/login?next=%2F');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Вход в Альма CRM');
	// Баннер администратора остаётся на странице — оговоркой под кнопкой.
	await expect(page.getByTestId('login-banner')).toContainText('Для сотрудников ИТ Школы');
	await expect(page.getByTestId('login-banner')).toContainText('Действия записываются в журнал.');
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

test('вход штатным администратором открывает то, чего нет у демонстрации', async ({ page }) => {
	await signInThroughDirectory(page, {
		login: 'staff-admin',
		password: E2E_PASSWORD
	});

	// Пароля штатной записи мало: каталог спрашивает одноразовый код, настроенный
	// глобальным сетапом, и без него в приложение не возвращает.
	await expect(page.locator('#otp')).toBeVisible();
	await enterSecondFactor(page, STAFF_ADMIN_TOTP);

	await expect(page).toHaveURL('/');

	await page.goto('/settings/users');
	await expect(page.getByRole('heading', { level: 1 })).toContainText('Пользователи');
});
