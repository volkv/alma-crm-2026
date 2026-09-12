import { Redis } from 'ioredis';
import { expect, test, type Page } from '@playwright/test';

/**
 * Лимит попыток входа с одного адреса — глазами того, кто в него упёрся.
 *
 * Проверка живёт в своём проекте Playwright (`login-limit` в
 * `playwright.config.ts`) и никогда не идёт рядом с остальными: счётчик
 * считается по адресу, а весь прогон приходит с одного — выбранный лимит закрыл
 * бы вход и соседним тестам. Проект запускается после обычного, в один рабочий
 * процесс, а счётчик убирается до и после каждой проверки.
 */

/**
 * Порог из `src/lib/server/auth/lockout.ts`: тридцать попыток с адреса за
 * пятнадцать минут, а на публичной демонстрации — впятеро больше, потому что
 * для счётчика все зрители за одним NAT это один адрес. Здесь он повторён
 * числом: `lockout.ts` тянет за собой конфигурацию сервера, которой в прогоне
 * нет, а брать порог из самого приложения значило бы проверять его им же.
 */
const ADDRESS_ATTEMPT_LIMIT = 30;
const DEMO_ADDRESS_MULTIPLIER = 5;

/** Учётная запись, которой не существует: проверяется счётчик, а не пароль. */
const PROBE = { email: 'perebor@example.org', password: 'заведомо-не-тот-пароль' };

/** Переменная окружения сервера прогона; их задаёт `playwright.config.ts`. */
function serverEnvironment(name: string): string {
	const server = test.info().config.webServer;
	const value = (Array.isArray(server) ? server[0] : server)?.env?.[name];

	if (typeof value !== 'string') {
		throw new Error(`playwright.config.ts must set ${name} for the web server`);
	}

	return value;
}

/** Порог для этого прогона: демонстрационный режим поднимает его впятеро. */
function addressAttemptLimit(): number {
	return serverEnvironment('DEMO_MODE') === 'true'
		? ADDRESS_ATTEMPT_LIMIT * DEMO_ADDRESS_MULTIPLIER
		: ADDRESS_ATTEMPT_LIMIT;
}

/**
 * Снимает счётчики адресов. Окно у них пятнадцать минут, и без уборки второй
 * прогон подряд упёрся бы в то, что насчитал первый, а обычные проверки входа —
 * в то, что насчитала эта.
 */
async function forgetAddressAttempts(): Promise<void> {
	const redis = new Redis(serverEnvironment('REDIS_URL'));

	try {
		const keys = await redis.keys('login_ip:*');

		if (keys.length > 0) {
			await redis.del(...keys);
		}
	} finally {
		await redis.quit();
	}
}

type Attempt = { status: number; redirected: boolean };

/**
 * Неудачные отправки формы входа — из самой страницы, а не из прогона.
 *
 * Так у них тот же адрес, что и у всего остального, что делает браузер: счётчик
 * считает по нему, и запрос, отправленный мимо страницы, попал бы в другой
 * счётчик. Развёрнутую хуком попытку видно по `redirected`: вместо отказа формы
 * приходит перенаправление обратно на страницу входа.
 *
 * `accept: text/html` — это обычная отправка формы, без перехвата кодом
 * страницы. С заголовком по умолчанию — тем, где годится любой тип, — SvelteKit
 * решил бы, что отправку ведёт `use:enhance`, и вернул бы свой конверт с кодом
 * 200 на любой исход: отказ формы стал бы неотличим от разворота хуком.
 */
async function failedAttempts(page: Page, count: number): Promise<Attempt[]> {
	return page.evaluate(
		async ({ count, probe }) => {
			const attempts: { status: number; redirected: boolean }[] = [];

			for (let index = 0; index < count; index += 1) {
				const response = await fetch('/login?/login', {
					method: 'POST',
					headers: { accept: 'text/html' },
					body: new URLSearchParams(probe)
				});

				attempts.push({ status: response.status, redirected: response.redirected });
			}

			return attempts;
		},
		{ count, probe: PROBE }
	);
}

test.beforeEach(forgetAddressAttempts);
test.afterAll(forgetAddressAttempts);

test('исчерпанный лимит адреса закрывает форму входа и объясняет словами', async ({ page }) => {
	// Сотни отправок формы — это секунды, а не миллисекунды обычной проверки.
	test.slow();

	const limit = addressAttemptLimit();

	await page.goto('/login');

	const attempts = await failedAttempts(page, limit + 1);
	const refused = attempts.slice(0, limit);

	// Пока лимит не выбран, отвечает сама форма: неверный пароль (400), а после
	// нескольких неудач подряд — закрытая перебором учётная запись (429).
	expect(
		refused.every(
			(attempt) => !attempt.redirected && (attempt.status === 400 || attempt.status === 429)
		)
	).toBe(true);

	// Следующая попытка до формы уже не доходит: её разворачивает хук.
	expect(attempts[limit].redirected).toBe(true);

	await page.goto('/login');

	await expect(page.getByText(/^Слишком много входов с этого адреса/)).toBeVisible();

	// Нерабочих органов управления на странице нет: их POST всё равно развернут.
	await expect(page.getByLabel('Рабочая почта')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Войти', exact: true })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Войти как менеджер' })).toHaveCount(0);
});

test('демонстрационный вход лимит адреса не снимает', async ({ page }) => {
	test.slow();

	const limit = addressAttemptLimit();

	await page.goto('/login');

	// На одну попытку меньше порога: следующая отправка ещё проходит, и ею будет
	// демонстрационный вход.
	const attempts = await failedAttempts(page, limit - 1);

	expect(attempts.every((attempt) => !attempt.redirected)).toBe(true);

	await page.goto('/login');
	await page.getByRole('button', { name: 'Войти как менеджер' }).click();
	await expect(page).toHaveURL('/');

	// Счётчик снимает только верный пароль. Демонстрационная кнопка пароля не
	// спрашивает, и если бы она его снимала, лимит обходил бы любой, кто открыл
	// страницу: перебирай до порога, входи демонстрационным входом, повторяй.
	await page.context().clearCookies();
	await page.goto('/login');

	await expect(page.getByText(/^Слишком много входов с этого адреса/)).toBeVisible();
	await expect(page.getByLabel('Рабочая почта')).toHaveCount(0);
});
