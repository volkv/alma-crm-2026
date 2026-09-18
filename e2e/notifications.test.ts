import { expect, test as base } from '@playwright/test';
import { MANAGER_STATE, STAFF_ADMIN_STATE } from './global-setup';

/**
 * Уведомления о зависших взаимодействиях — от настройки до письма.
 *
 * Проверяется не «кнопка нажалась», а доставка: порог ставится на экране общих
 * настроек, фоновый цикл сам находит зависшую запись, журнал `/notifications`
 * показывает отправленное письмо, и то же письмо лежит в Mailpit из
 * `docker-compose.yml` — его поднимает `e2e/stack.ts`, и он единственный, кто
 * может подтвердить, что письмо действительно ушло по SMTP.
 *
 * Цикл фоновый и ходит раз в пятнадцать секунд, поэтому проверка ждёт
 * состояния, а не спит фиксированную паузу.
 */
const staff = base.extend<object>({ storageState: STAFF_ADMIN_STATE });
const manager = base.extend<object>({ storageState: MANAGER_STATE });

/** Веб-интерфейс и API Mailpit: опубликованный порт из `docker-compose.yml`. */
const MAILPIT_API = 'http://localhost:8025/api/v1';

/** Начало темы письма: его задаёт словарь видов уведомления. */
const SUBJECT_PREFIX = 'Зависшее взаимодействие';

type MailpitMessage = { Subject: string; To: { Address: string }[] };

/**
 * Письма из Mailpit. Обычный `fetch` процесса проверки, а не `page.request`:
 * почтовый ящик — это не страница приложения, и ходить в него через контекст
 * браузера незачем.
 */
async function mailpitMessages(): Promise<MailpitMessage[]> {
	const response = await fetch(`${MAILPIT_API}/messages?limit=200`);

	if (!response.ok) {
		throw new Error(
			`Mailpit ответил ${response.status}: поднят ли он? (node e2e/stack.ts поднимает его вместе со стеком)`
		);
	}

	const body = (await response.json()) as { messages?: MailpitMessage[] };

	return body.messages ?? [];
}

staff('порог из настроек доводит письмо до почтового ящика и до журнала', async ({ page }) => {
	// Проверка ждёт фоновый цикл, а не подгоняет его: он просыпается раз в
	// пятнадцать секунд, и столько же ждёт человек на стенде. Отсюда и срок,
	// заметно больший обычного.
	staff.setTimeout(240_000);

	await page.goto('/settings/general');

	const threshold = page.getByLabel('Порог зависания, дней');
	await expect(threshold).toBeVisible();

	// Ноль означает «напоминать сразу»: набор стенда и так стоит на стадиях
	// неделями, но проверка не должна зависеть от того, какие именно сроки
	// оказались в сиде сегодня.
	await threshold.fill('0');
	await page.getByRole('button', { name: 'Сохранить правило' }).click();
	await expect(page.getByText('Правило напоминаний сохранено')).toBeVisible();

	// Раздел открыт администратору и назван в меню.
	await page.goto('/notifications');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Уведомления');

	const sent = page.getByRole('row').filter({ hasText: 'Почта' }).filter({ hasText: 'Отправлено' });

	await expect(async () => {
		await page.reload();
		await expect(sent.first()).toBeVisible({ timeout: 3000 });
	}).toPass({ timeout: 120_000 });

	// И то же самое письмо — в почтовом ящике: строка журнала без письма
	// доказывала бы только то, что строку записали.
	await expect(async () => {
		const messages = await mailpitMessages();
		const letter = messages.find((message) => message.Subject.startsWith(SUBJECT_PREFIX));

		expect(letter, 'письма о зависшем взаимодействии в Mailpit нет').toBeDefined();
		// Адресат — руководитель ответственного, а не сам ответственный.
		expect(letter!.To.map((recipient) => recipient.Address)).toContain('lead@demo.lct-crm.local');
	}).toPass({ timeout: 60_000 });
});

manager('менеджеру раздел уведомлений не принадлежит', async ({ page }) => {
	await page.goto('/');

	// Эскалация приходит руководителю — и журнал её доставок тоже его.
	await expect(page.getByRole('link', { name: 'Уведомления' })).toHaveCount(0);

	const response = await page.request.get('/notifications');
	expect(response.status()).toBe(403);
});
