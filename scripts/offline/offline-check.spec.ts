import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as XLSX from 'xlsx';
import {
	expect,
	test,
	type APIRequestContext,
	type Browser,
	type BrowserContext,
	type Download,
	type Locator,
	type Page
} from '@playwright/test';

/**
 * Основные сценарии на стеке без выхода в интернет.
 *
 * Стек поднимает `offline-check.sh` из `compose.offline-check.yml`: сеть
 * сервисов внутренняя, и то, что прогон здесь проходит, — доказательство, что
 * ни вход, ни карточка, ни обмен с CMS и системой обучения, ни отчёты с PDF, ни
 * справка не ходят наружу. Браузер стоит на хосте и видит стек только через
 * прокси `edge` — как сотрудник в сети заказчика видит установку через её
 * обратный прокси.
 *
 * Два набора: `@full` — полный проход после первого подъёма, `@restart` —
 * короткая проверка того же стека после его перезапуска с сохранёнными томами.
 */

function required(name: string): string {
	const value = process.env[name];

	if (value === undefined || value === '') {
		throw new Error(`${name} не задана: прогон запускает scripts/offline/offline-check.sh`);
	}

	return value;
}

const PASSWORD = required('OFFLINE_DEMO_PASSWORD');
const CONTROL_TOKEN = required('OFFLINE_MOCK_CONTROL_TOKEN');
const LMS_INTERACTION = required('OFFLINE_LMS_INTERACTION');
const OUT_DIR = required('OFFLINE_OUT_DIR');

/** Между двумя наборами переживает перезапуск только то, что записано в файл. */
const STATE_FILE = path.join(OUT_DIR, 'offline-check.state.json');

type RunState = { applicationInteraction: string; comment: string };

const RUN = Date.now().toString(36);
const EXTERNAL_ID = `site-offline-${RUN}`;
const STEP_COMMENT = `Контакт подтверждён, прогон без интернета ${RUN}`;
const STEP_FILE = 'protokol-offline.txt';

const CONTROL_HEADERS = { 'x-mock-control': CONTROL_TOKEN };

/** Демонстрационные записи realm (`keycloak/demo-users.json`): по одной на роль. */
const ROLES = { admin: 'admin', lead: 'lead', manager: 'manager' } as const;

type Role = keyof typeof ROLES;

/** Строка журнала, чтобы итог прогона был виден в выводе, а не только «passed». */
function note(message: string): void {
	console.log(`    · ${message}`);
}

async function waitForHydration(page: Page): Promise<void> {
	await expect(page.locator('body[data-hydrated]')).toBeAttached({ timeout: 15_000 });
}

/**
 * Вход тем же путём, что у человека: кнопка «Войти» приложения, форма
 * каталога за прокси (`/auth/`), возврат в приложение. Подсказки первого входа
 * закрываются кнопкой «Позже».
 */
async function signIn(
	browser: Browser,
	role: Role
): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext();
	const page = await context.newPage();

	await page.goto('/login');
	await waitForHydration(page);
	await page.getByRole('button', { name: 'Войти', exact: true }).click();
	await page.waitForURL(/\/auth\/realms\/lct\/protocol\/openid-connect\/auth/);
	await page.locator('#username').fill(ROLES[role]);
	await page.locator('#password').fill(PASSWORD);
	await page.locator('#kc-login').click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Сводка', { timeout: 30_000 });

	const tour = page.getByTestId('onboarding-tour');

	await expect(tour).toBeVisible({ timeout: 15_000 });
	await tour.getByRole('button', { name: 'Позже' }).click();
	await expect(tour).toBeHidden();

	return { context, page };
}

async function openLayer(trigger: Locator, layer: Locator): Promise<void> {
	await expect(async () => {
		await trigger.click();
		await expect(layer).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });
}

type MockJournalEntry = {
	summary: string;
	eventType: string | null;
	status: number | null;
	payload: { data?: Record<string, unknown> } | null;
};

type MockState = {
	objects: { groups?: { requestExternalId: string; groupExternalId: string }[] };
	journal: MockJournalEntry[];
};

async function mockState(
	request: APIRequestContext,
	mock: 'mock-cms' | 'mock-lms'
): Promise<MockState> {
	const response = await request.get(`/${mock}/__state`, { headers: CONTROL_HEADERS });

	expect(response.status(), `${mock}/__state`).toBe(200);

	return (await response.json()) as MockState;
}

async function save(download: Download, name: string): Promise<Buffer> {
	const body = await readFile(await download.path());

	await writeFile(path.join(OUT_DIR, name), body);

	return body;
}

async function readState(): Promise<RunState> {
	return JSON.parse(await readFile(STATE_FILE, 'utf8')) as RunState;
}

test.describe.serial('без интернета: полный проход', { tag: '@full' }, () => {
	test.setTimeout(180_000);

	const sessions = {} as Record<Role, { context: BrowserContext; page: Page }>;
	let applicationInteraction = '';

	test.afterAll(async () => {
		for (const session of Object.values(sessions)) {
			await session.context.close();
		}
	});

	test('вход через Keycloak тремя ролями', async ({ browser }) => {
		for (const role of Object.keys(ROLES) as Role[]) {
			sessions[role] = await signIn(browser, role);
			note(`${role}: вошёл, открыта «Сводка»`);
		}

		// Роли различаются не только именем: настройки связей закрыты менеджеру
		// правами и открыты администратору.
		const forManager = await sessions.manager.page.request.get('/settings/health', {
			maxRedirects: 0
		});
		const forAdmin = await sessions.admin.page.request.get('/settings/health');

		expect(forManager.status()).not.toBe(200);
		expect(forAdmin.status()).toBe(200);
		note(`/settings/health: менеджеру ${forManager.status()}, администратору ${forAdmin.status()}`);
	});

	test('заявка с сайта от имитатора CMS, снимок статуса уходит обратно', async () => {
		const { page } = sessions.admin;

		// Форму на сайте «заполняет» имитатор: он собирает конверт, подписывает и
		// сам отправляет его в CRM по сети стека.
		const sent = await page.request.post('/mock-cms/__send-application', {
			headers: CONTROL_HEADERS,
			data: { form: 'b2b', externalId: EXTERNAL_ID }
		});

		expect(sent.status()).toBe(200);

		const reply = (await sent.json()) as {
			crm: {
				status: number | null;
				error: string | null;
				body: { result?: string; data?: { interactionId?: string } };
			};
		};

		expect(reply.crm.error).toBeNull();
		expect(reply.crm.status).toBe(200);
		expect(reply.crm.body.result).toBe('created');
		applicationInteraction = reply.crm.body.data?.interactionId ?? '';
		expect(applicationInteraction).toMatch(/^[0-9a-f-]{36}$/);
		note(`имитатор CMS → CRM: 200, взаимодействие ${applicationInteraction}`);

		// Снимок статуса отправляет цикл интеграций — ждём его у имитатора.
		await expect(async () => {
			const state = await mockState(page.request, 'mock-cms');
			const status = state.journal.find(
				(entry) => entry.eventType === 'application.status' && entry.summary.includes(EXTERNAL_ID)
			);

			expect(status).toBeDefined();
			expect(status?.payload?.data).toMatchObject({ externalId: EXTERNAL_ID });
		}).toPass({ timeout: 120_000, intervals: [2000] });
		note('CRM → имитатор CMS: снимок статуса application.status принят');

		await page.goto(`/exchange?q=${encodeURIComponent(EXTERNAL_ID)}`);
		await expect(page.getByText('application.submitted').first()).toBeVisible();
		await expect(page.getByText('application.status').first()).toBeVisible();
		note('журнал обмена /exchange показывает обе стороны');
	});

	test('список и карточка: переход стадии с комментарием и файлом', async () => {
		const { page } = sessions.manager;

		await page.goto('/w/b2b/interactions?view=table');
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Взаимодействия');

		const listed = await page.getByRole('row').count();

		await page.goto(`/w/b2b/interactions?view=table&q=${encodeURIComponent('Заявка с сайта')}`);
		await expect(page.getByRole('row').filter({ hasText: 'Заявка с сайта' }).first()).toBeVisible();
		note(
			`список взаимодействий b2b: ${listed - 1} строк на первой странице, заявка с сайта находится поиском`
		);

		await page.goto(`/w/b2b/interactions/${applicationInteraction}`);
		await waitForHydration(page);
		await expect(page.getByRole('heading', { level: 1 })).toContainText('Заявка с сайта');

		const action = page.locator('[data-slot="card-action"]');

		// «Найдено профильное подразделение» — пункт-факт: закрывает его не
		// галочка, а выбранная площадка вида «Подразделение» у вуза в составе
		// дела (`$lib/components/interaction-card/model.ts`). Путь — тот же, что
		// у менеджера: «Открыть сторону» у пункта, пока он открыт (закрытый
		// пункт открыл бы сторону без кнопки — она уже в панели), «Выбрать
		// площадки» у учебного заведения, отметка площадки и сохранение состава.
		const openParty = action
			.locator('li')
			.filter({ hasText: 'Найдено профильное подразделение' })
			.getByRole('button', { name: 'Открыть сторону' });

		if ((await openParty.count()) > 0) {
			await openParty.click();
		}

		const institutionPanel = page.locator('[data-slot="institution-panel"]');
		const composition = page.getByRole('dialog');

		await openLayer(
			institutionPanel.getByRole('button', { name: 'Выбрать площадки' }),
			composition
		);
		await composition
			.getByRole('checkbox', { name: 'Кафедра информационной безопасности' })
			.click();
		await composition.getByRole('button', { name: 'Сохранить состав' }).click();
		await expect(composition).toBeHidden();

		// Обязательный ручной пункт первой стадии закрывается галочкой, как её
		// закрывает менеджер, — отдельным запросом формы.
		const box = action.getByRole('checkbox', { name: 'Подтверждён контакт ответственного лица' });

		await Promise.all([
			page.waitForResponse((response) => response.url().includes('/checklist') && response.ok()),
			box.click()
		]);

		const advance = action.getByRole('button', { name: /^Перейти к «/ });

		await expect(advance).toBeEnabled({ timeout: 15_000 });

		const target = /«(.+)»/.exec((await advance.textContent()) ?? '')?.[1];

		expect(target).toBeDefined();

		const dialog = page.getByRole('dialog');

		await openLayer(advance, dialog);
		await dialog.getByLabel('Комментарий').fill(STEP_COMMENT);
		await dialog.getByLabel('Вложения').setInputFiles({
			name: STEP_FILE,
			mimeType: 'text/plain',
			buffer: Buffer.from('Протокол звонка: контакт подтверждён', 'utf8')
		});
		await dialog.getByRole('button', { name: 'Подтвердить' }).click();

		await expect(page.locator('[data-slot="stage-strip"] [aria-current="step"]')).toContainText(
			`${target} — текущая`
		);

		const left = page
			.locator('[data-slot="event-feed"] li')
			.filter({ hasText: 'стадия пройдена' })
			.first();

		await expect(left).toContainText(STEP_COMMENT);
		await expect(left).toContainText(`Вложения: ${STEP_FILE}`);
		note(`стадия → «${target}», комментарий и файл ${STEP_FILE} в ленте`);

		await writeFile(
			STATE_FILE,
			JSON.stringify({ applicationInteraction, comment: STEP_COMMENT } satisfies RunState)
		);
	});

	test('учебная группа уходит в LMS, результат возвращается от имитатора', async () => {
		const { page } = sessions.manager;

		await page.goto(`/w/b2b/interactions/${LMS_INTERACTION}`);
		await waitForHydration(page);

		const dialog = page.getByRole('dialog');

		await openLayer(page.getByRole('button', { name: 'Заявить поток' }).first(), dialog);

		const purpose = page.getByRole('option', { name: 'Обучение студентов' });

		await openLayer(dialog.getByLabel('Для кого обучение'), purpose);
		await purpose.click();
		await dialog.getByLabel('Мест в потоке').fill('30');
		await dialog.getByLabel('Начало занятий').fill('01.10.2026');
		await expect(dialog.locator('input[name="startsOn"]')).toHaveValue('2026-10-01');
		await dialog.getByRole('button', { name: 'Отправить в LMS' }).click();
		await expect(dialog).toBeHidden();

		const prefix = `crm-group-${LMS_INTERACTION}-`;
		let requestExternalId = '';

		await expect(async () => {
			const groups = (await mockState(page.request, 'mock-lms')).objects.groups ?? [];
			const group = groups.filter((item) => item.requestExternalId.startsWith(prefix)).at(-1);

			expect(group).toBeDefined();
			requestExternalId = group!.requestExternalId;
		}).toPass({ timeout: 60_000, intervals: [1000] });
		note(`CRM → имитатор LMS: группа заведена (${requestExternalId})`);

		// «Поток закончился, вот числа»: имитатор подписывает результат и сам
		// отправляет его в CRM. План потока ещё впереди, а дату окончания позже
		// дня отправки CRM не принимает — поэтому итог досрочный, сегодняшним днём.
		const result = await page.request.post('/mock-lms/__send-result', {
			headers: CONTROL_HEADERS,
			data: {
				requestExternalId,
				finish: 'завершили сегодня',
				counters: { enrolled: 30, completed: 27, expelled: 2 }
			}
		});

		expect(result.status()).toBe(200);

		const reply = (await result.json()) as { crm: { status: number | null; error: string | null } };

		expect(reply.crm.error).toBeNull();
		expect(reply.crm.status).toBe(200);

		await page.reload();
		await expect(
			page.locator('[data-slot="event-feed"]').getByText('завершили 27', { exact: false }).first()
		).toBeVisible();
		note('имитатор LMS → CRM: результат 30/27/2 на карточке');
	});

	test('отчёт выгружается в XLSX и PDF (Gotenberg)', async () => {
		const { page } = sessions.manager;

		await page.goto('/reports');
		await waitForHydration(page);
		await expect(page.getByRole('heading', { name: 'Отчёты по взаимодействиям' })).toBeVisible();

		const rows = Number(await page.getByTestId('report-row-count').textContent());

		expect(rows).toBeGreaterThan(0);

		async function download(format: 'xlsx' | 'pdf'): Promise<{ name: string; body: Buffer }> {
			// Форматы выгрузки — в меню одной кнопки.
			await page.getByTestId('report-export').click();

			const [event] = await Promise.all([
				page.waitForEvent('download', { timeout: 90_000 }),
				page.getByTestId(`report-export-${format}`).click()
			]);
			const name = event.suggestedFilename();

			return { name, body: await save(event, name) };
		}

		const xlsx = await download('xlsx');
		const book = XLSX.read(xlsx.body, { type: 'buffer' });
		const sheet = book.Sheets[book.SheetNames[0]];
		const lines = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 }).length;

		expect(xlsx.name.endsWith('.xlsx')).toBe(true);
		expect(lines).toBeGreaterThan(rows);
		note(
			`XLSX ${xlsx.name}: ${xlsx.body.byteLength} байт, строк на первом листе ${lines} (в отчёте ${rows})`
		);

		const pdf = await download('pdf');

		expect(pdf.name.endsWith('.pdf')).toBe(true);
		expect(pdf.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
		expect(pdf.body.byteLength).toBeGreaterThan(2000);
		note(`PDF ${pdf.name}: ${pdf.body.byteLength} байт`);
	});

	test('встроенная справка', async () => {
		const { page } = sessions.lead;

		await page.goto('/help');
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Справка');

		const section = page.locator('main a[href^="/help/"]:not([href^="/help/print"])').first();
		const href = await section.getAttribute('href');

		await section.click();
		await page.waitForURL((url) => url.pathname === href);
		await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('');
		note(
			`справка: оглавление и раздел ${href} — «${await page.getByRole('heading', { level: 1 }).textContent()}»`
		);
	});

	test('самодиагностика связей: локальное отвечает, внешнее выключено и недоступно', async () => {
		const { page } = sessions.admin;

		/** Строки таблицы связей: название, адрес, роль для сценариев, состояние. */
		async function links(): Promise<string[][]> {
			await page.goto('/settings/health');
			await waitForHydration(page);
			await expect(page.getByText('Основные сценарии работают без интернета:')).toHaveText(
				/интернета:\s*да\s*$/
			);

			const rows = await page
				.getByRole('row')
				.evaluateAll((items) =>
					items
						.map((row) =>
							Array.from(row.querySelectorAll('td'), (cell) =>
								(cell.textContent ?? '').replace(/\s+/g, ' ').trim()
							)
						)
						.filter((row) => row.length === 4)
				);

			expect(rows.length).toBeGreaterThan(0);

			return rows;
		}

		// Демонстрационный набор включает флаг «Внешние источники» — стенд
		// показывает паспорт вуза с его сайта. Все сценарии выше прошли с ним
		// включённым: внешние источники в них не участвуют. Ключа Dadata у
		// прогона нет, поэтому связь стоит «Не настроено», а не «Отвечает».
		for (const [name, address, kind, state] of await links()) {
			note(`связь (флаг стенда включён): ${name} | ${address} | ${kind} | ${state}`);

			if (kind === 'Обязательна') {
				expect(state, name).toMatch(/^Отвечает/);
			}

			if (kind === 'Отключаемая') {
				expect(state, name).not.toMatch(/^Отвечает/);
			}
		}

		// Установка в закрытой сети держит флаг выключенным
		// (docs/deployment.md, «Установка без интернета») — выключаем, как
		// администратор, и смотрим страницу ещё раз.
		await page.goto('/settings/general');
		await waitForHydration(page);

		const enrichment = page.locator('[data-tour="general-enrichment"]');
		const flag = enrichment.getByRole('checkbox', {
			name: 'Разрешить обращения к внешним источникам'
		});

		if ((await flag.getAttribute('aria-checked')) === 'true') {
			await flag.click();
		}

		await expect(flag).toHaveAttribute('aria-checked', 'false');
		await Promise.all([
			page.waitForResponse((response) => response.url().includes('/enrichment') && response.ok()),
			enrichment.getByRole('button', { name: 'Сохранить', exact: true }).click()
		]);
		note('флаг «Внешние источники» выключен в общих настройках');

		for (const [name, address, kind, state] of await links()) {
			note(`связь (флаг выключен): ${name} | ${address} | ${kind} | ${state}`);

			if (kind === 'Обязательна') {
				expect(state, name).toMatch(/^Отвечает/);
			}

			if (kind === 'Отключаемая') {
				expect(state, name).toMatch(/^Выключено флагом/);
			}
		}

		await page.screenshot({ path: path.join(OUT_DIR, 'diagnostics.png'), fullPage: true });

		await page.getByRole('button', { name: 'Проверить внешние источники' }).click();

		const external = page.getByRole('status').filter({ hasText: /Доступен|Недоступен/ });

		await expect(external).toContainText('Недоступен', { timeout: 30_000 });
		note(
			`кнопка «Проверить внешние источники»: ${(await external.textContent())?.replace(/\s+/g, ' ').trim()}`
		);
	});
});

test.describe('без интернета: после перезапуска стека', { tag: '@restart' }, () => {
	test.setTimeout(120_000);

	test('здоровье, вход и карточка с данными первого прохода', async ({ browser, request }) => {
		const health = await request.get('/api/health');

		expect(health.status()).toBe(200);
		expect(await health.json()).toMatchObject({
			status: 'ok',
			db: 'ok',
			redis: 'ok',
			storage: 'ok'
		});
		note('/api/health: ok');

		const state = await readState();
		const { context, page } = await signIn(browser, 'manager');

		try {
			note('manager: вошёл');
			await page.goto(`/w/b2b/interactions/${state.applicationInteraction}`);
			await expect(page.getByRole('heading', { level: 1 })).toContainText('Заявка с сайта');
			await expect(
				page.locator('[data-slot="event-feed"] li').filter({ hasText: state.comment }).first()
			).toBeVisible();
			note('карточка заявки открыта, переход с комментарием первого прохода на месте');
		} finally {
			await context.close();
		}
	});
});
