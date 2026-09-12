import { expect, test, type Page } from '@playwright/test';
import { E2E_USER } from './global-setup';
import { waitForHydration } from './helpers/hydration';

/**
 * Вход глазами посетителя: без сессии внутрь не попасть, после входа человек
 * оказывается там, куда шёл, а после выхода — снова у формы. Тесты нарочно
 * берут обычный `test`, а не фикстуру с готовой сессией: проверяется именно то,
 * что фикстура для остальных обходит. Здесь же — то, что человек видит вместо
 * страницы: отказ и «нет такой записи» остаются внутри приложения.
 */

/** Идентификатор верной формы, которого нет ни в одной таблице стенда. */
const ABSENT_ID = '00000000-0000-4000-8000-0000000000ff';

/**
 * Вход демонстрационной кнопкой.
 *
 * Страница входа в момент нажатия ещё гидратируется, и узел, на который
 * пришёлся клик, SvelteKit заменяет — клик уходит вместе с ним («Всплывающие
 * слои» в `docs/development.md`). Поэтому нажимаем, пока не окажемся внутри, а
 * не ждём фиксированную паузу. Повтор безопасен: после удачного нажатия кнопки
 * на странице уже нет, и блок только сверяет адрес.
 */
async function enterByDemoButton(page: Page, roleName: string, landing = '/'): Promise<void> {
	const button = page.getByRole('button', { name: `Войти как ${roleName}` });

	await expect(async () => {
		if ((await button.count()) > 0) {
			await button.click({ timeout: 5_000 });
		}

		await expect(page).toHaveURL(landing, { timeout: 5_000 });
	}).toPass({ timeout: 30_000 });
}

/** Вход демонстрационной кнопкой наблюдателя: у него нет права на журнал. */
async function signInAsObserver(page: Page): Promise<void> {
	await page.goto('/login');
	await enterByDemoButton(page, 'наблюдатель');
}

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

test('вход по паролю открывает оболочку приложения', async ({ page }) => {
	await page.goto('/login');

	await page.getByLabel('Рабочая почта').fill(E2E_USER.email);
	await page.getByLabel('Пароль').fill(E2E_USER.password);
	await page.getByRole('button', { name: 'Войти', exact: true }).click();

	await expect(page).toHaveURL('/');
	// Между нажатием и этой проверкой стоит переход: POST, перенаправление и
	// загрузка оболочки. Пяти секунд умолчания на это мало, когда машина занята.
	await expect(page.getByRole('button', { name: E2E_USER.fullName })).toBeVisible({
		timeout: 15_000
	});
});

test('неверный пароль объясняется словами и не пускает дальше', async ({ page }) => {
	await page.goto('/login');
	// Отправку формы берёт на себя `use:enhance`, и только он оставляет человека
	// на `/login`: форма, ушедшая до того, как страница ожила, уходит обычным
	// POST-ом на `?/login` — отказ виден, но адрес уже не тот. Повтор здесь не
	// поможет, страница с формой к этому моменту сменилась.
	await waitForHydration(page);

	await page.getByLabel('Рабочая почта').fill(E2E_USER.email);
	await page.getByLabel('Пароль').fill('совсем не тот пароль');
	await page.getByRole('button', { name: 'Войти', exact: true }).click();

	await expect(page.getByText('Неверная почта или пароль')).toBeVisible();
	await expect(page).toHaveURL('/login');
});

test('демонстрационная кнопка впускает и показывает плашку демо-режима', async ({ page }) => {
	await page.goto('/login');

	await enterByDemoButton(page, 'наблюдатель');

	await expect(page.getByText('Демо-режим: данные синтетические')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Наблюдатель Демо' })).toBeVisible();
});

test('после входа человек возвращается туда, куда шёл', async ({ page }) => {
	await page.goto('/ui-kit');

	await expect(page).toHaveURL('/login?next=%2Fui-kit');

	await enterByDemoButton(page, 'менеджер', '/ui-kit');

	await expect(page.getByRole('heading', { level: 1 })).toHaveText('UI-кит');
});

test('адрес на чужой сайт в next никуда не уводит', async ({ page }) => {
	await page.goto('/login?next=https://example.org/steal');

	// Проверка — в самом ожидаемом адресе: вход обязан привести на главную, а не
	// на чужой сайт из строки запроса.
	await enterByDemoButton(page, 'менеджер', '/');
});

test('выход возвращает к форме входа и закрывает страницы приложения', async ({ page }) => {
	await page.goto('/login');
	await enterByDemoButton(page, 'менеджер');

	// Меню учётной записи открывается кодом на странице, а не браузером:
	// нажатие до того, как страница ожила, не доходит до компонента. Поэтому
	// нажимаем, пока меню не откроется, — ждать фиксированную паузу значило бы
	// закладываться на скорость машины.
	await expect(async () => {
		await page.getByRole('button', { name: E2E_USER.fullName }).click();
		await expect(page.getByRole('menuitem', { name: 'Выйти' })).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	await page.getByRole('menuitem', { name: 'Выйти' }).click();

	await expect(page).toHaveURL('/login');

	await page.goto('/ui-kit');
	await expect(page).toHaveURL('/login?next=%2Fui-kit');
});

test('гвардия разворачивает анонима на вход и помнит, куда он шёл', async ({ page }) => {
	const response = await page.request.get('/audit', { maxRedirects: 0 });

	expect(response.status()).toBe(303);
	expect(response.headers()['location']).toBe('/login?next=%2Faudit');
});

test('форма на странице с погасшей сессией уводит на вход, а не в пятисотую', async ({ page }) => {
	await page.goto('/login');
	await enterByDemoButton(page, 'менеджер');

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
	await expect(page.getByRole('button', { name: 'Войти как менеджер' })).toBeVisible();
});

test('отказ по правам остаётся внутри оболочки приложения', async ({ page }) => {
	await signInAsObserver(page);

	const response = await page.goto('/audit');
	expect(response?.status()).toBe(403);

	// Разделы и меню учётной записи на месте: человек не выпал из системы.
	await expect(page.getByRole('button', { name: 'Наблюдатель Демо' })).toBeVisible();

	// Текст — тот, что написал сервер, а не общее «что-то пошло не так».
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Доступ закрыт');
	await expect(
		page.getByText('Журнал действий доступен только с правом «Просмотр журнала действий»')
	).toBeVisible();
	await expect(page.getByRole('link', { name: 'На главную' })).toBeVisible();
});

test('записи нет — 404 в оболочке, адреса нет — 404 без неё', async ({ page }) => {
	await signInAsObserver(page);

	const missing = await page.goto(`/organizations/${ABSENT_ID}`);
	expect(missing?.status()).toBe(404);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Страница не найдена');
	await expect(page.getByRole('button', { name: 'Наблюдатель Демо' })).toBeVisible();

	// Идентификатор, который не может быть нашим, до загрузчика не доходит:
	// такого адреса в приложении нет, и оболочка тут ни при чём.
	const malformed = await page.goto('/organizations/abc');
	expect(malformed?.status()).toBe(404);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Страница не найдена');
	await expect(page.getByRole('button', { name: 'Наблюдатель Демо' })).toBeHidden();
});
