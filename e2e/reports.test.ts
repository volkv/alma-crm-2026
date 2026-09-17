import { stat } from 'node:fs/promises';
import postgres from 'postgres';
import type { Page } from '@playwright/test';
import type { StageSnapshot } from '$lib/contracts/interactions';
import { expect, test } from './fixtures';
import { waitForHydration } from './helpers/hydration';
import { seedProcessGroup } from './helpers/process-group';

/**
 * Раздел отчётов глазами человека: режим, набор колонок, выгрузка и клик по
 * диаграмме.
 *
 * Числа здесь не утверждаются: база прогона общая и залита набором стенда, а
 * эталонные числа проверяет `tests/integration/reports`. Проверяется то, чего
 * не видно ни одному другому тесту, — что экран действительно ссылка: смена
 * режима и набора колонок попадает в адрес, файл скачивается, а клик по
 * столбцу сужает выборку.
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
			const { groupId, stageIds } = await seedProcessGroup(tx, {
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
					process_group_id: groupId,
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

test('раздел открывается срезом и объясняет правило словами', async ({ page }) => {
	await page.goto('/reports');

	await expect(page.getByRole('heading', { name: 'Отчёты по взаимодействиям' })).toBeVisible();
	await expect(page.getByText(SNAPSHOT_RULE)).toBeVisible();
	await expect(page.getByTestId('report-row-count')).toBeVisible();
});

test('переключение режима меняет адрес и правило на экране', async ({ page }) => {
	await page.goto('/reports');
	await waitForHydration(page);

	await page.getByTestId('report-mode-movement').click();

	await expect(page).toHaveURL(/mode=movement/);
	await expect(page.getByText(MOVEMENT_RULE)).toBeVisible();

	// Колонки движения появляются вместе с режимом: «Вид события» в срезе нет.
	await expect(page.getByRole('columnheader', { name: /Вид события/ })).toBeVisible();

	await page.getByTestId('report-mode-snapshot').click();

	await expect(page).toHaveURL(/mode=snapshot/);
	await expect(page.getByText(SNAPSHOT_RULE)).toBeVisible();
});

test('включённая колонка уезжает в адрес и появляется в таблице', async ({ page }) => {
	await page.goto('/reports');
	await waitForHydration(page);

	await page.getByTestId('report-columns').click();
	await page.getByTestId('report-column-stageEnteredAt').click();

	await expect(page).toHaveURL(/cols=[^&]*stageEnteredAt/);
	await expect(page.getByRole('columnheader', { name: /На стадии с/ })).toBeVisible();
});

test('отчёт выгружается книгой, и файл непустой', async ({ page }) => {
	await page.goto('/reports');

	const [download] = await Promise.all([
		page.waitForEvent('download'),
		page.getByTestId('report-export-xlsx').click()
	]);

	const name = download.suggestedFilename();

	expect(name.startsWith('Отчёт по взаимодействиям')).toBe(true);
	expect(name.endsWith('.xlsx')).toBe(true);

	const path = await download.path();
	const file = await stat(path);

	expect(file.size).toBeGreaterThan(0);
});

test('клик по столбцу воронки добавляет фильтр стадии в адрес', async ({ page }) => {
	await page.goto('/reports');
	await waitForHydration(page);

	const canvas = page.getByTestId('report-chart-canvas');

	await expect(canvas).toBeVisible();

	/**
	 * Координаты самой длинной полосы.
	 *
	 * Диаграмма — растр: ни столбца, ни его границ в разметке нет, поэтому
	 * геометрия берётся у самого экземпляра. Проба по долям ширины холста
	 * промахивалась бы на любой выборке с короткими полосами: длину подписей и
	 * масштаб оси решает Chart.js, а не тест.
	 */
	const readBar = () =>
		canvas.evaluate((element) => {
			type Bar = { x: number; y: number; base: number };
			type Instance = {
				getDatasetMeta: (index: number) => { data: Bar[] };
				data: { datasets: { data: (number | null)[] }[] };
			};

			const chart = (element as HTMLCanvasElement & { chart?: Instance }).chart;

			// Библиотека подключается динамическим импортом, поэтому холст живёт
			// раньше экземпляра: «ещё не собралась» — это не «полос нет».
			if (chart === undefined) {
				return { ready: false, values: [] as number[], target: null };
			}

			const box = element.getBoundingClientRect();
			const values = chart.data.datasets[0].data.map((value) =>
				typeof value === 'number' ? value : 0
			);
			const bars = chart.getDatasetMeta(0).data;
			const candidates: { value: number; bar: Bar }[] = [];

			values.forEach((value, index) => {
				const bar = bars[index];

				// Нулевая полоса длины не имеет: попасть в неё нельзя и незачем.
				if (bar !== undefined && value > 0) {
					candidates.push({ value, bar });
				}
			});

			candidates.sort((left, right) => right.value - left.value);

			const top = candidates[0];

			return {
				ready: true,
				values,
				target:
					top === undefined
						? null
						: {
								x: box.x + (top.bar.x + top.bar.base) / 2,
								y: box.y + top.bar.y,
								value: top.value
							}
			};
		});

	let bar: Awaited<ReturnType<typeof readBar>> = { ready: false, values: [], target: null };

	await expect(async () => {
		bar = await readBar();

		expect(bar, `диаграмма не отдала полосу: ${JSON.stringify(bar)}`).toMatchObject({
			ready: true,
			target: { value: expect.any(Number) }
		});
	}).toPass({ timeout: 15_000 });

	await page.mouse.click(bar.target!.x, bar.target!.y);

	await expect(page).toHaveURL(/stage=[a-z_]+/);
});

test('переключение режима пересчитывает итоги на той же выборке', async ({ page }) => {
	await seed();

	const errors = clientErrors(page);
	const period = `from=${moscowDay(daysAgo(SEEDED.periodDaysAgo))}&to=${moscowDay(new Date())}`;
	const address = `/reports?mode=snapshot&group=${GROUP_KEY}&${period}`;

	await page.goto(address);
	await waitForHydration(page);

	// В группе одна запись: в срезе это одна строка, а в движении — два события,
	// начало работы и уход с первой стадии. Обе строки опираются на одну запись
	// о стадии, и различает их только имя строки.
	await expect(page.getByTestId('report-row-count')).toHaveText('1');
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
