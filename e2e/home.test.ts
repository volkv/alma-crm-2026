import postgres from 'postgres';
import type { Page } from '@playwright/test';
import type { StageSnapshot } from '$lib/contracts/interactions';
import { expect, test } from './fixtures';
import { waitForHydration } from './helpers/hydration';

/**
 * Главная глазами менеджера: плитки портфеля, список «требуют действия»,
 * ожидание стороны и поведение на узком экране.
 *
 * Данные готовятся прямо в базе — сервисы приложения здесь недоступны
 * (Playwright запускает файл обычным Node, где нет `$env/dynamic/private`), а
 * просроченную запись через интерфейс не сделать: срок стадии считает база от
 * момента входа на неё.
 */

/** Метка в названиях: база прогона общая с разработческой, и чужие записи в ней бывают. */
const MARK = 'E2E-СВОДКА';

const ROUTE_KEY = 'e2e-home';

const STAGES = [
	{ key: 'contact', name: 'Первый контакт', category: 'contact', slaDays: 7, staleAfterDays: 5 },
	{
		key: 'documents',
		name: 'Обмен документами',
		category: 'documents',
		slaDays: 10,
		staleAfterDays: 7
	},
	{
		key: 'control',
		name: 'Контроль исполнения',
		category: 'control',
		slaDays: 20,
		staleAfterDays: 14
	}
] as const;

const INSTITUTION = {
	id: '2e2e0001-0000-4000-8000-000000000001',
	shortName: `${MARK} Технологический университет`
};

/** Просроченная запись: она даёт и число в плитке, и первую строку списка. */
const OVERDUE = {
	id: '2e2e0002-0000-4000-8000-000000000001',
	partyId: '2e2e0003-0000-4000-8000-000000000001',
	entryId: '2e2e0004-0000-4000-8000-000000000001',
	eventId: '2e2e0005-0000-4000-8000-000000000001',
	title: `${MARK} Просроченное взаимодействие`,
	stageKey: 'contact',
	enteredDaysAgo: 30,
	silentDaysAgo: 2
};

/** Запись с остановленными часами: она наполняет блок «Ждём вуз». */
const WAITING = {
	id: '2e2e0002-0000-4000-8000-000000000002',
	partyId: '2e2e0003-0000-4000-8000-000000000002',
	entryId: '2e2e0004-0000-4000-8000-000000000002',
	eventId: '2e2e0005-0000-4000-8000-000000000002',
	pauseId: '2e2e0006-0000-4000-8000-000000000002',
	title: `${MARK} Ждём подписанное соглашение`,
	stageKey: 'documents',
	// Ожидание заведомо старше всего, что могли оставить прошлые прогоны: блок
	// показывает пять самых давних, и место в нём надо занять наверняка.
	enteredDaysAgo: 50,
	silentDaysAgo: 3,
	pausedDaysAgo: 45,
	note: 'Соглашение у проректора по учебной работе',
	nextAction: 'Напомнить о себе в среду'
};

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
	return new Date(Date.now() - days * DAY_MS);
}

function databaseUrl(): string {
	const server = test.info().config.webServer;
	const url = (Array.isArray(server) ? server[0] : server)?.env?.DATABASE_URL;

	if (typeof url !== 'string') {
		throw new Error('playwright.config.ts must set DATABASE_URL for the web server');
	}

	return url;
}

/**
 * Слепок стадии для записи о ней. Объект, а не строка: драйвер сам кладёт
 * объект в `jsonb`, а уже сериализованную строку сохранит как строку JSON — и
 * тогда `stage_entry_status` не найдёт в ней норматива и не посчитает срок.
 */
function snapshot(stageKey: string): StageSnapshot {
	const position = STAGES.findIndex((stage) => stage.key === stageKey);
	const stage = STAGES[position];

	return {
		key: stage.key,
		name: stage.name,
		position: position + 1,
		category: stage.category,
		slaDays: stage.slaDays,
		staleAfterDays: stage.staleAfterDays,
		requiresResult: false,
		requiresConfirmation: false,
		checklist: []
	};
}

/**
 * Маршрут, вуз и две записи менеджера. Под блокировкой: файлы прогона
 * выполняются параллельно, и два рабочих процесса не должны заводить маршрут
 * одновременно. Записи не просто заводятся, а переписываются на каждом прогоне:
 * их сроки заданы относительно «сегодня», и оставленные от прошлого раза они
 * означали бы каждый раз другую просрочку.
 *
 * Маршрут намеренно не становится маршрутом по умолчанию — его предлагают новым
 * взаимодействиям, а это дело другого прогона.
 */
async function seed(): Promise<void> {
	const sql = postgres(databaseUrl(), { max: 1, connect_timeout: 10 });

	try {
		await sql.begin(async (tx) => {
			await tx`select pg_advisory_xact_lock(918273646)`;

			await tx`
				insert into organizations ${tx({
					id: INSTITUTION.id,
					kind: 'educational_institution',
					education_level: 'vo',
					legal_name: INSTITUTION.shortName,
					short_name: INSTITUTION.shortName
				})}
				on conflict (id) do nothing
			`;

			const existing = await tx<{ id: string }[]>`
				select id from stage_routes where key = ${ROUTE_KEY} limit 1
			`;

			let routeId = existing[0]?.id;

			if (routeId === undefined) {
				const [route] = await tx<{ id: string }[]>`
					insert into stage_routes ${tx({
						key: ROUTE_KEY,
						version: 1,
						name: 'Маршрут проверки сводки',
						is_default: false,
						published_at: new Date()
					})}
					returning id
				`;

				routeId = route.id;

				for (const [index, stage] of STAGES.entries()) {
					await tx`
						insert into stages ${tx({
							route_id: routeId,
							position: index + 1,
							key: stage.key,
							name: stage.name,
							category: stage.category,
							sla_days: stage.slaDays,
							stale_after_days: stage.staleAfterDays
						})}
					`;
				}
			}

			const stageRows = await tx<{ id: string; key: string }[]>`
				select id, key from stages where route_id = ${routeId}
			`;
			const stageIds = new Map(stageRows.map((row) => [row.key, row.id]));

			// Тот же выбор, что делает демонстрационный вход (`demoLogin`): записи
			// заводятся на учётную запись, под которой тест и войдёт. Адрес почты
			// здесь не годится — демонстрационные учётные записи заводит сид, и он
			// вправе называть их как угодно.
			const [manager] = await tx<{ id: string; full_name: string }[]>`
				select id, full_name
				from users
				where role_id = 'manager' and is_demo and is_active
				order by email
				limit 1
			`;

			if (manager === undefined) {
				throw new Error('Демонстрационная учётная запись менеджера не заведена');
			}

			for (const record of [OVERDUE, WAITING]) {
				await tx`
					insert into interactions ${tx({
						id: record.id,
						title: record.title,
						route_id: routeId,
						status: 'active',
						owner_user_id: manager.id,
						last_activity_at: daysAgo(record.silentDaysAgo)
					})}
					on conflict (id) do update
					set title = excluded.title,
						status = excluded.status,
						owner_user_id = excluded.owner_user_id,
						last_activity_at = excluded.last_activity_at
				`;

				await tx`
					insert into interaction_parties ${tx({
						id: record.partyId,
						interaction_id: record.id,
						organization_id: INSTITUTION.id,
						party_role: 'educational_institution',
						is_primary: true
					})}
					on conflict (id) do nothing
				`;

				await tx`
					insert into stage_entries ${tx({
						id: record.entryId,
						interaction_id: record.id,
						stage_id: stageIds.get(record.stageKey) ?? null,
						stage_snapshot: snapshot(record.stageKey),
						entered_at: daysAgo(record.enteredDaysAgo),
						responsible_user_id: manager.id
					})}
					on conflict (id) do update
					set stage_snapshot = excluded.stage_snapshot,
						entered_at = excluded.entered_at,
						responsible_user_id = excluded.responsible_user_id
				`;

				// След в журнале: лента главной показывает работу, а не пустоту.
				await tx`
					insert into audit_events ${tx({
						id: record.eventId,
						occurred_at: daysAgo(record.silentDaysAgo),
						request_id: `e2e-${record.id}`,
						source: 'ui',
						event_type: 'interactions.created',
						outcome: 'success',
						actor_user_id: manager.id,
						actor_label: manager.full_name,
						subject_type: 'interaction',
						subject_id: record.id
					})}
					on conflict (id) do nothing
				`;
			}

			await tx`
				insert into stage_pauses ${tx({
					id: WAITING.pauseId,
					stage_entry_id: WAITING.entryId,
					reason: 'waiting_counterparty',
					waiting_party_id: WAITING.partyId,
					next_action: WAITING.nextAction,
					note: WAITING.note,
					started_at: daysAgo(WAITING.pausedDaysAgo)
				})}
				on conflict (id) do update
				set next_action = excluded.next_action,
					note = excluded.note,
					started_at = excluded.started_at
			`;
		});
	} finally {
		await sql.end();
	}
}

test.beforeAll(async () => {
	await seed();
});

/** Блок сводки по его заголовку: страница собрана из нескольких одинаковых. */
function section(page: Page, title: string) {
	return page
		.locator('[data-slot="home-section"]')
		.filter({ has: page.getByRole('heading', { name: title }) });
}

test('плитки показывают числа и ведут в список с фильтром', async ({ page }) => {
	await page.goto('/');
	// Переход по плитке отдан клиентскому маршрутизатору: нажатие, пришедшее
	// раньше, чем он встал, не доходит ни до него, ни до браузера — ссылка
	// остаётся на месте, а повторить нажатие нельзя, второе увело бы дальше.
	await waitForHydration(page);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Сводка');

	// В подпись ссылки попадает само число: пустая плитка провалит проверку.
	const overdue = page.getByRole('link', { name: /^Просроченные:/ });
	await expect(overdue).toHaveAccessibleName(/Просроченные: [1-9]\d*\./);

	await overdue.click();

	await expect(page).toHaveURL(/[?&]overdue=true/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Взаимодействия');
	// Список открылся именно с этим фильтром, а не просто по адресу с ним.
	await expect(page.getByRole('button', { name: 'Просроченные' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
});

test('строка «требуют действия» открывает карточку', async ({ page }) => {
	await page.goto('/');

	const row = page.getByRole('row', { name: OVERDUE.title });
	await expect(row).toBeVisible();
	await expect(row).toContainText('просрочено на');

	await row.getByRole('link', { name: 'Открыть' }).click();

	await expect(page.getByRole('heading', { level: 1 })).toHaveText(OVERDUE.title);
});

test('«ждём вуз» называет сторону и следующий шаг', async ({ page }) => {
	await page.goto('/');

	const waiting = section(page, 'Ждём вуз');

	await expect(waiting.getByRole('link', { name: WAITING.title })).toBeVisible();
	await expect(waiting).toContainText(INSTITUTION.shortName);
	await expect(waiting).toContainText(WAITING.nextAction);
});

test('на узком экране блоки идут в столбец', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Сводка');

	const waiting = await section(page, 'Ждём вуз').boundingBox();
	const activity = await section(page, 'Недавняя активность').boundingBox();

	if (waiting === null || activity === null) {
		throw new Error('Блоки сводки не отрисованы');
	}

	// Рядом — значит в одной строке; в столбец — значит следующий ниже предыдущего.
	expect(activity.y).toBeGreaterThanOrEqual(waiting.y + waiting.height);
	expect(Math.abs(activity.x - waiting.x)).toBeLessThan(2);
	// И ничего не торчит за край экрана.
	expect(waiting.x + waiting.width).toBeLessThanOrEqual(390);
});

test('сводка снята для обзора', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Сводка');
	await page.screenshot({ path: 'test-results/home-desktop.png', fullPage: true });

	await page.setViewportSize({ width: 390, height: 844 });
	await page.reload();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Сводка');
	await page.screenshot({ path: 'test-results/home-mobile.png', fullPage: true });
});
