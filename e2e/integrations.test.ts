import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test as base, type Locator } from '@playwright/test';
import { ADMIN_STATE, STAFF_ADMIN_STATE } from './global-setup';

/**
 * Интеграции глазами администратора.
 *
 * Настройка обмена не переживает демонстрации: `integrations.manage` у
 * демо-сессии нет, какой бы ролью в неё ни вошли, — заведённый вебхук
 * продолжал бы слать данные на чужой адрес и после того, как посетитель ушёл.
 * Поэтому подписку заводит штатный администратор (`staff`), а
 * демонстрационному (`demo`) раздел закрыт — это и проверяется.
 *
 * Приёмник поднимается прямо здесь: подписку проверяет не «кнопка нажалась», а
 * пришедший на настоящий сокет запрос с подписью, которую можно сверить.
 */
const staff = base.extend<object>({ storageState: STAFF_ADMIN_STATE });
const demo = base.extend<object>({ storageState: ADMIN_STATE });

type Received = { headers: Record<string, string>; body: string };

/** Приёмник вебхука на свободном порту loopback. */
async function startReceiver(): Promise<{
	url: string;
	received: Received[];
	stop: () => Promise<void>;
}> {
	const received: Received[] = [];

	const server: Server = createServer((request, response) => {
		let body = '';

		request.on('data', (chunk: Buffer) => {
			body += chunk.toString('utf8');
		});

		request.on('end', () => {
			received.push({
				headers: Object.fromEntries(
					Object.entries(request.headers).map(([name, value]) => [name, String(value)])
				),
				body
			});
			response.statusCode = 200;
			response.end('ok');
		});
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

	const { port } = server.address() as AddressInfo;

	return {
		url: `http://127.0.0.1:${port}/hook`,
		received,
		stop: () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve()))
			)
	};
}

/**
 * Открывает всплывающий слой и дожидается его: слой открывает код страницы, а
 * не браузер, и нажатие до того, как страница ожила, теряется совсем
 * (см. `docs/development.md`, «Всплывающие слои»).
 */
async function openLayer(trigger: Locator, layer: Locator): Promise<void> {
	await expect(async () => {
		await trigger.click();
		await expect(layer).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });
}

staff('подписка заводится, показывает секрет один раз и доходит до приёмника', async ({ page }) => {
	const receiver = await startReceiver();
	const name = `Приёмник прогона ${Date.now().toString(36)}`;

	try {
		await page.goto('/settings/integrations');
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Интеграции');

		const dialog = page.getByRole('dialog');
		await openLayer(page.getByRole('button', { name: 'Добавить подписку' }), dialog);

		await dialog.getByLabel('Название').fill(name);
		await dialog.getByLabel('Адрес приёмника').fill(receiver.url);

		// Галочка — не нативный `input`, а контрол bits-ui с ролью `checkbox`:
		// нажимаем её как человек и убеждаемся, что она встала.
		const wholeSection = dialog.getByRole('checkbox', { name: 'Интеграции — весь раздел' });
		await wholeSection.click();
		await expect(wholeSection).toBeChecked();

		await dialog.getByRole('button', { name: 'Завести подписку' }).click();

		// Секрет показывается ровно один раз — сразу после заведения. Отбор по
		// фразе диалога, а не по слову «заведена»: им же названы события журнала
		// в списке выбора, и по нему нашёлся бы диалог подписки.
		const secretDialog = page.getByRole('dialog').filter({ hasText: 'Заберите секрет сейчас' });
		await expect(secretDialog).toBeVisible();

		const secretInput = secretDialog.getByRole('textbox', { name: 'Секрет подписки' });
		await expect(secretInput).toBeVisible();

		const secret = await secretInput.inputValue();
		expect(secret).toMatch(/^whsec_/);

		await secretDialog.getByRole('button', { name: 'Готово' }).click();

		const card = page.locator('section').filter({ hasText: name });
		await expect(card).toBeVisible();

		await card.getByRole('button', { name: 'Тестовое событие' }).click();
		await expect(page.getByText(/Получатель ответил 200/)).toBeVisible();

		expect(receiver.received.length).toBeGreaterThan(0);

		const delivery = receiver.received.find(
			(entry) => (JSON.parse(entry.body) as { type: string }).type === 'webhook.test'
		);

		expect(delivery).toBeDefined();

		// Подпись сходится по тому же правилу, что описано в docs/integrations.md.
		const expected = `sha256=${createHmac('sha256', secret)
			.update(`${delivery!.headers['x-webhook-timestamp']}.${delivery!.body}`)
			.digest('hex')}`;

		expect(delivery!.headers['x-webhook-signature']).toBe(expected);

		// Попытка видна на экране: состояние доставок — часть раздела, а не только
		// внутреннее устройство.
		await page.reload();

		const saved = page.locator('section').filter({ hasText: name });
		await expect(saved.getByRole('row').nth(1)).toContainText('200');

		// Выключение — тот же экран: подписка на приёмник, который уйдёт вместе с
		// прогоном, не должна пережить его и стучаться в закрытый порт.
		await openLayer(saved.getByRole('button', { name: 'Изменить' }), dialog);

		const enabled = dialog.getByRole('checkbox', { name: 'Подписка включена' });
		await enabled.click();
		await expect(enabled).not.toBeChecked();

		await dialog.getByRole('button', { name: 'Сохранить' }).click();
		await expect(dialog).toBeHidden();
		await expect(saved).toContainText('Выключена');
	} finally {
		await receiver.stop();
	}
});

staff('раздел называет адрес приёма заявок', async ({ page }) => {
	await page.goto('/settings/integrations');

	await expect(page.getByText('/api/v1/applications')).toBeVisible();
});

demo('демонстрационной сессии раздел закрыт', async ({ page }) => {
	await page.goto('/settings');

	// В меню настроек его нет вовсе: ссылка, отвечающая 403, — это не навигация.
	await expect(page.getByRole('link', { name: 'Интеграции' })).toHaveCount(0);

	const response = await page.goto('/settings/integrations');

	expect(response?.status()).toBe(403);
	await expect(page.getByText(/Настройка вебхуков и интеграций/)).toBeVisible();
});

staff('выгрузка из системы обучения доходит до раздела «Данные»', async ({ page, baseURL }) => {
	await page.goto('/settings/integrations');

	// Адрес и токен заглушки подсказывает сама страница — ими и настраиваем: в
	// прогоне настоящей LMS нет, а путь от настроек до снимка тот же самый.
	await expect(page.getByText('/mock-lms', { exact: false }).first()).toBeVisible();

	await page.getByLabel('Адрес системы обучения').fill(`${baseURL}/mock-lms`);
	await page.getByLabel('Токен веб-сервиса').fill('mock-lms-token');
	await page.getByRole('button', { name: 'Сохранить настройки' }).click();

	await expect(page.getByText('Настройки системы обучения сохранены')).toBeVisible();

	const sync = page.getByRole('button', { name: 'Синхронизировать сейчас' });
	await expect(sync).toBeEnabled();
	await sync.click();

	// Либо выгрузка приехала, либо она уже загружена — оба ответа успешные, и
	// какой из них придёт, зависит от того, гоняли ли прогон по этой базе раньше.
	const result = /Загружено строк|Изменений нет/;
	await expect(page.getByText(result).first()).toBeVisible();

	// Состояние последней синхронизации остаётся на экране и после перезагрузки:
	// сотрудник должен видеть, чем кончился заход, а не только всплывшее
	// сообщение.
	await page.reload();
	await expect(page.getByText('Последняя синхронизация')).toBeVisible();
	await expect(page.getByText(result).first()).toBeVisible();

	// Снимок ждёт человека в разделе «Данные»: подтверждение вводит числа в
	// показатели, и выгрузка этого решения за него не принимает.
	await page.goto('/data?source=lms');

	// Отбор и по режиму: в демонстрационном наборе уже есть снимок LMS-источника,
	// и без этого проверка сошлась бы на нём, что бы ни сделала синхронизация.
	// Полную выгрузку за учебный год кладёт только адаптер.
	const row = page
		.getByRole('row')
		.filter({ hasText: 'Выгрузка LMS' })
		.filter({ hasText: 'Полный' })
		.first();

	await expect(row).toBeVisible();
	await expect(row).toContainText('Проверен');
});
