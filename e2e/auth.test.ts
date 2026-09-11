import { expect, test } from '@playwright/test';
import { E2E_USER } from './global-setup';

/**
 * Вход глазами посетителя: без сессии внутрь не попасть, после входа человек
 * оказывается там, куда шёл, а после выхода — снова у формы. Тесты нарочно
 * берут обычный `test`, а не фикстуру с готовой сессией: проверяется именно то,
 * что фикстура для остальных обходит.
 */

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
	await expect(page.getByRole('button', { name: E2E_USER.fullName })).toBeVisible();
});

test('неверный пароль объясняется словами и не пускает дальше', async ({ page }) => {
	await page.goto('/login');

	await page.getByLabel('Рабочая почта').fill(E2E_USER.email);
	await page.getByLabel('Пароль').fill('совсем не тот пароль');
	await page.getByRole('button', { name: 'Войти', exact: true }).click();

	await expect(page.getByText('Неверная почта или пароль')).toBeVisible();
	await expect(page).toHaveURL('/login');
});

test('демонстрационная кнопка впускает и показывает плашку демо-режима', async ({ page }) => {
	await page.goto('/login');

	await page.getByRole('button', { name: 'Войти как наблюдатель' }).click();

	await expect(page).toHaveURL('/');
	await expect(page.getByText('Демо-режим: данные синтетические')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Демонстрация: Наблюдатель' })).toBeVisible();
});

test('после входа человек возвращается туда, куда шёл', async ({ page }) => {
	await page.goto('/ui-kit');

	await expect(page).toHaveURL('/login?next=%2Fui-kit');

	await page.getByRole('button', { name: 'Войти как менеджер' }).click();

	await expect(page).toHaveURL('/ui-kit');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('UI-кит');
});

test('адрес на чужой сайт в next никуда не уводит', async ({ page }) => {
	await page.goto('/login?next=https://example.org/steal');

	await page.getByRole('button', { name: 'Войти как менеджер' }).click();

	await expect(page).toHaveURL('/');
});

test('выход возвращает к форме входа и закрывает страницы приложения', async ({ page }) => {
	await page.goto('/login');
	await page.getByRole('button', { name: 'Войти как менеджер' }).click();
	await expect(page).toHaveURL('/');

	await page.getByRole('button', { name: 'Демонстрация: Менеджер' }).click();
	await page.getByRole('menuitem', { name: 'Выйти' }).click();

	await expect(page).toHaveURL('/login');

	await page.goto('/ui-kit');
	await expect(page).toHaveURL('/login?next=%2Fui-kit');
});
