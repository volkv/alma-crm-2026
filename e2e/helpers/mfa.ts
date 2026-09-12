import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { totpCodeAt, TOTP_STEP_SECONDS } from '../../src/lib/server/auth/totp';
import { STAFF_ADMIN, STAFF_ADMIN_FACTOR, type StoredFactor } from '../global-setup';

/**
 * Вход туда, где пароля мало.
 *
 * Политика по умолчанию требует второй фактор от роли администратора, поэтому
 * штатный администратор — а им входят проверки настроек и журнала — после
 * пароля попадает не в приложение, а на второй шаг. Секрет его фактора
 * приготовил глобальный сетап: он прошёл регистрацию через интерфейс и сложил
 * ключ рядом с состояниями сессий. Здесь этот ключ превращается в код — ровно
 * так же, как это делает приложение в телефоне.
 *
 * Хелпер один на все файлы прогона: вход по паролю встречается в нескольких, и
 * второй шаг в каждом из них — это один и тот же шаг.
 */

/** Секрет и резервные коды, которые унёс с экрана регистрации сетап. */
function staffFactor(): StoredFactor {
	return JSON.parse(readFileSync(STAFF_ADMIN_FACTOR, 'utf8')) as StoredFactor;
}

/**
 * Код, который приложение покажет через `shift` шагов. Окно проверки — шаг в
 * обе стороны, поэтому сервер принимает три соседних кода, а не один.
 */
export function codeAt(secret: string, shift = 0): string {
	return totpCodeAt(secret, Date.now() + shift * TOTP_STEP_SECONDS * 1000);
}

/** Первый шаг: почта и пароль. Куда он приведёт — решает политика. */
export async function signInWithPassword(
	page: Page,
	email: string,
	password: string
): Promise<void> {
	await page.goto('/login');
	await page.getByLabel('Рабочая почта').fill(email);
	await page.getByLabel('Пароль').fill(password);
	await page.getByRole('button', { name: 'Войти', exact: true }).click();
}

/**
 * Шаги окна в том порядке, в каком их стоит пробовать.
 *
 * Секрет у прогона один на все файлы, а код одноразовый: два файла, вошедшие в
 * одно и то же окно, предъявят один и тот же код, и второму система справедливо
 * ответит «уже использован». Ждать следующего окна — это полминуты на ровном
 * месте, поэтому берётся соседний шаг: он даёт другой код, который сервер
 * принимает сразу. Трёх хватает — столько кодов и живёт в окне.
 */
const WINDOW_SHIFTS = [1, 0, -1];

/**
 * Вход штатным администратором целиком: пароль, код, главная страница.
 * Демонстрационная кнопка «Войти как администратор» сюда не годится — ей
 * настройки и журнал не принадлежат.
 */
export async function loginStaffAdmin(page: Page): Promise<void> {
	const { secret } = staffFactor();

	await signInWithPassword(page, STAFF_ADMIN.email, STAFF_ADMIN.password);
	await page.waitForURL('**/login/mfa**');

	for (const shift of WINDOW_SHIFTS) {
		await page.getByLabel('Код или резервный код').fill(codeAt(secret, shift));
		await page.getByRole('button', { name: 'Подтвердить' }).click();

		const entered = await page
			.waitForURL('/', { timeout: 5_000 })
			.then(() => true)
			.catch(() => false);

		if (entered) {
			return;
		}
	}

	// Ни один код окна не подошёл — это уже не гонка соседнего файла, а поломка
	// второго фактора, и молчать о ней нельзя.
	throw new Error(
		`Второй шаг входа не пройден: ${await page.locator('[data-slot="alert"]').first().innerText()}`
	);
}
