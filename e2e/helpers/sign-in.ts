import type { Page } from '@playwright/test';

/**
 * Вход через каталог учётных записей — тем же путём, каким его проходит
 * человек: наша страница входа сама уводит на форму Keycloak, дальше имя и
 * пароль, возврат в приложение.
 *
 * Обойти этот путь нельзя и не нужно: подделанная сессия проверяла бы систему,
 * которой не существует. Хелпер один на все файлы прогона — вход встречается и
 * в глобальном сетапе, и в спеках, которые входят по ходу дела.
 *
 * Поля формы каталога ищутся по идентификаторам (`#username`, `#password`), а
 * не по подписям: подписи Keycloak локализует, и realm стоит на русском —
 * искать их текстом значит сломаться на смене языка стенда.
 */
export async function signInThroughDirectory(
	page: Page,
	credentials: { login: string; password: string },
	options: { startAt?: string } = {}
): Promise<void> {
	await page.goto(options.startAt ?? '/login');

	await page.waitForURL(/\/realms\/lct\/protocol\/openid-connect\/auth/);
	await page.locator('#username').fill(credentials.login);
	await page.locator('#password').fill(credentials.password);
	await page.locator('#kc-login').click();
}
