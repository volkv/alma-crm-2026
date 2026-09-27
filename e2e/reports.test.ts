import { stat } from 'node:fs/promises';
import postgres from 'postgres';
import type { Page } from '@playwright/test';
import type { StageSnapshot } from '$lib/contracts/interactions';
import { expect, test } from './fixtures';
import { waitForHydration } from './helpers/hydration';
import { seedWorkspace } from './helpers/workspace';

/**
 * Раздел отчётов глазами человека: выгрузка книгой и смена режима на своей
 * выборке.
 *
 * Эталонные числа проверяет `tests/integration/reports`; здесь — что экран
 * пересчитывает итоги при смене режима, а не показывает числа прошлого, и что
 * файл действительно скачивается.
 */

const SNAPSHOT_RULE = 'Каждое взаимодействие показано в той стадии';
const MOVEMENT_RULE = 'Каждая строка — один переход';

/**
 * Своя группа процесса с одной записью: в ней взаимодействие и начинается, и
 * уходит со своей первой стадии внутри одного периода. Это и есть выборка, на
 * которой срез и движение обязаны показать разные числа — одно взаимодействие
 * против двух событий.
 *
 * Данные готовятся прямо в базе: сервисы приложения Playwright недоступны, а
 * историю за сорок дней через интерфейс не сделать — движок ставит `now()`.
 * Группа своя, а не `b2b`: в ней действует процесс стенда, и подменять его
 * ради проверки экрана незачем.
 */
const GROUP_KEY = 'e2e-reports';

const STAGES = [
	{ key: 'intake', name: 'Приём заявки', category: 'contact', slaDays: 7 },
	{ key: 'work', name: 'Работа по заявке', category: 'documents', slaDays: 30 }
] as const;

const SEEDED = {
	organizationId: '3e2e0001-0000-4000-8000-000000000001',
	interactionId: '3e2e0002-0000-4000-8000-000000000001',
	partyId: '3e2e0003-0000-4000-8000-000000000001',
	firstEntryId: '3e2e0004-0000-4000-8000-000000000001',
	secondEntryId: '3e2e0004-0000-4000-8000-000000000002',
	title: 'E2E-ОТЧЁТЫ Заявка одного периода',
	enteredDaysAgo: 40,
	movedDaysAgo: 20,
	periodDaysAgo: 60
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Смещение Москвы постоянное, поэтому календарный день — это арифметика. */
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
	return new Date(Date.now() - days * DAY_MS);
}

function moscowDay(value: Date): string {
	return new Date(value.getTime() + MOSCOW_OFFSET_MS).toISOString().slice(0, 10);
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
 * Слепок стадии объектом, а не строкой: драйвер сам кладёт объект в `jsonb`, а
 * готовую строку сохранит как строку JSON — и отчёт не найдёт в ней ключа.
 */
function snapshot(index: number): StageSnapshot {
	const stage = STAGES[index];

	return {
		key: stage.key,
		name: stage.name,
		position: index + 1,
		category: stage.category,
		slaDays: stage.slaDays,
		staleAfterDays: null,
		requiresResult: false,
		requiresConfirmation: false,
		requiresLmsData: false,
		requiresDocumentMark: null,
		requiresDocumentTemplate: null,
		lmsGroupPurposes: null,
		isFinal: index + 1 === STAGES.length,
		checklist: []
	};
}

/** Копилка клиентских исключений вкладки: повторный ключ списка — это оно. */
function clientErrors(page: Page): string[] {
	const messages: string[] = [];

	page.on('pageerror', (error) => messages.push(error.message));

	return messages;
}

async function seed(): Promise<void> {
	const sql = postgres(databaseUrl(), { max: 1, connect_timeout: 10 });

	try {
		await sql.begin(async (tx) => {
			// Группу заводит общий хелпер: он же берёт замок, под которым идёт и
			// остальная подготовка. Файлы прогона идут параллельно, и редакцию заводит
			// кто-то один.
			const { workspaceId, stageIds } = await seedWorkspace(tx, {
				key: GROUP_KEY,
				name: 'Проверка раздела отчётов',
				revisionName: 'Процесс проверки отчётов',
				stages: STAGES.map((stage, index) => ({
					...stage,
					isFinal: index + 1 === STAGES.length
				}))
			});

			await tx`
				insert into organizations ${tx({
					id: SEEDED.organizationId,
					kind: 'educational_institution',
					education_level: 'vo',
					legal_name: 'E2E-ОТЧЁТЫ Университет',
					short_name: 'E2E-ОТЧЁТЫ Университет'
				})}
				on conflict (id) do nothing
			`;

			// Тот же выбор, что делает демонстрационный вход: запись заводится на
			// учётную запись, под которой тест и войдёт.
			const [manager] = await tx<{ id: string }[]>`
				select id from users where role_id = 'manager' and is_demo and is_active
				order by email limit 1
			`;

			if (manager === undefined) {
				throw new Error('Демонстрационная учётная запись менеджера не заведена');
			}

			await tx`
				insert into interactions ${tx({
					id: SEEDED.interactionId,
					title: SEEDED.title,
					workspace_id: workspaceId,
					status: 'active',
					owner_user_id: manager.id,
					last_activity_at: daysAgo(SEEDED.movedDaysAgo)
				})}
				on conflict (id) do update
				set title = excluded.title,
					status = excluded.status,
					owner_user_id = excluded.owner_user_id,
					last_activity_at = excluded.last_activity_at
			`;

			await tx`
				insert into interaction_parties ${tx({
					id: SEEDED.partyId,
					interaction_id: SEEDED.interactionId,
					organization_id: SEEDED.organizationId,
					party_role: 'educational_institution',
					is_primary: true
				})}
				on conflict (id) do nothing
			`;

			// Первая запись: и вход, и уход с неё внутри периода — два события
			// движения на одну запись о стадии.
			await tx`
				insert into stage_entries ${tx({
					id: SEEDED.firstEntryId,
					interaction_id: SEEDED.interactionId,
					stage_id: stageIds.get(STAGES[0].key) ?? null,
					stage_snapshot: snapshot(0),
					entered_at: daysAgo(SEEDED.enteredDaysAgo),
					left_at: daysAgo(SEEDED.movedDaysAgo),
					outcome: 'completed',
					responsible_user_id: manager.id
				})}
				on conflict (id) do update
				set entered_at = excluded.entered_at,
					left_at = excluded.left_at,
					outcome = excluded.outcome
			`;

			await tx`
				insert into stage_entries ${tx({
					id: SEEDED.secondEntryId,
					interaction_id: SEEDED.interactionId,
					stage_id: stageIds.get(STAGES[1].key) ?? null,
					stage_snapshot: snapshot(1),
					entered_at: daysAgo(SEEDED.movedDaysAgo),
					responsible_user_id: manager.id
				})}
				on conflict (id) do update
				set entered_at = excluded.entered_at,
					left_at = null
			`;
		});
	} finally {
		await sql.end();
	}
}

test('отчёт выгружается книгой, и файл непустой', async ({ page }) => {
	// Прежний адрес уводит в отчёт первого пространства: закладки живут дольше
	// маршрутов.
	await page.goto('/reports');
	await expect(page).toHaveURL(/\/w\/[^/]+\/reports/);
	await waitForHydration(page);

	// Форматы собраны в меню одной кнопки «Выгрузить».
	await page.getByTestId('report-export').click();

	const [download] = await Promise.all([
		page.waitForEvent('download'),
		page.getByTestId('report-export-xlsx').click()
	]);

	const name = download.suggestedFilename();

	// В имени файла — пространство: отчёт описывает один процесс.
	expect(name.startsWith('Отчёт по взаимодействиям — ')).toBe(true);
	expect(name.endsWith('.xlsx')).toBe(true);

	const path = await download.path();
	const file = await stat(path);

	expect(file.size).toBeGreaterThan(0);
});

test('переключение режима пересчитывает итоги на той же выборке', async ({ page }) => {
	await seed();

	const errors = clientErrors(page);
	const period = `from=${moscowDay(daysAgo(SEEDED.periodDaysAgo))}&to=${moscowDay(new Date())}`;
	const address = `/w/${GROUP_KEY}/reports?mode=snapshot&${period}`;

	await page.goto(address);
	await waitForHydration(page);

	// В группе одна запись: в срезе это одна строка, а в движении — два события,
	// начало работы и уход с первой стадии. Обе строки опираются на одну запись
	// о стадии, и различает их только имя строки.
	await expect(page.getByTestId('report-row-count')).toHaveText('1');
	// Правило подсчёта раскрывается по кнопке и остаётся раскрытым при смене
	// режима: текст обязан смениться вместе с числами.
	await page.getByTestId('report-method-toggle').click();
	await expect(page.getByText(SNAPSHOT_RULE)).toBeVisible();

	await page.getByTestId('report-mode-movement').click();

	await expect(page).toHaveURL(/mode=movement/);
	await expect(page.getByText(MOVEMENT_RULE)).toBeVisible();
	// Числа прошлого режима здесь и появлялись: список с повторяющимся ключом
	// переставал обновляться, а выгрузка считала верно.
	await expect(page.getByTestId('report-row-count')).toHaveText('2');
	await expect(page.locator('[data-slot="report-table"] tbody tr')).toHaveCount(2);

	await page.getByTestId('report-mode-snapshot').click();

	await expect(page.getByTestId('report-row-count')).toHaveText('1');
	expect(errors).toStrictEqual([]);
});
