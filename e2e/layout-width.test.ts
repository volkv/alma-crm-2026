import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { test as base, type Page, type TestInfo } from '@playwright/test';
import { expect, leadTest as test } from './fixtures';
import { STAFF_ADMIN_STATE } from './global-setup';
import { waitForHydration } from './helpers/hydration';

/**
 * Экран телефона против шапки страницы — и рабочий экран против таблицы.
 *
 * Таблица, доска или длинная строка имеют право прокручиваться внутри себя;
 * документ целиком — нет: страница, уехавшая вбок, болтается на телефоне вся,
 * вместе с шапкой и навигацией. Поэтому меряется корень документа, а не
 * отдельный блок, и меряется там, где рядом с заголовком стоят кнопки, бейджи и
 * фильтры: они и есть то, что распирает страницу, когда ей нечем сузиться.
 *
 * Второй проход — журналы и таблица процесса на 1280 точках. Там мерится уже и
 * сама таблица: колонок у журнала десяток, а места под них около тысячи точек,
 * и «прокручивается внутри себя» на рабочем экране значит «ключевую колонку не
 * видно, пока не потянешь вбок». Поэтому проверка требует и отсутствия
 * прокрутки у таблицы, и того, что ключевые колонки на месте.
 */

/** Экран телефона; та же ширина, что и в остальных узких проходах. */
const NARROW = { width: 390, height: 844 } as const;

/** Рабочий экран: ширина, на которую рассчитан интерфейс (`docs/design.md`). */
const WIDE = { width: 1280, height: 800 } as const;

/** Журналы и настройки закрыты правами: их смотрит администратор стенда. */
const staff = base.extend<object>({ storageState: STAFF_ADMIN_STATE });

/** Период стенда, за который есть подтверждённые данные. */
const PERIOD_KEY = '2026-09-01..2027-08-31';

/** Период загрузки этого прохода: свой, чтобы не пересечься с данными стенда. */
const UPLOAD_PERIOD = { start: '2023-09-01', end: '2024-08-31' } as const;

const FIXTURE = fileURLToPath(new URL('./fixtures/stats-sample.csv', import.meta.url));

/** Метка прогона: делает название файла уникальным в общей базе. */
const TAG = crypto.randomUUID().slice(0, 8);

/** День так, как его пишут в поле даты: `2023-09-01` → `01.09.2023`. */
function ruDay(iso: string): string {
	const [year, month, day] = iso.split('-');

	return `${day}.${month}.${year}`;
}

/** Насколько документ шире экрана. Ноль и меньше — помещается. */
async function documentOverflow(page: Page): Promise<number> {
	return page.evaluate(() => {
		const root = document.documentElement;

		return root.scrollWidth - root.clientWidth;
	});
}

/**
 * Насколько самая широкая таблица страницы шире отведённого ей места. Ноль и
 * меньше — помещается без горизонтальной прокрутки.
 *
 * Меряется контейнер прокрутки, который рисует `Table.Root`: именно он уезжает
 * вбок, когда колонкам не хватает ширины, и именно по нему человек тянет
 * таблицу, чтобы увидеть то, что не поместилось.
 */
async function tableOverflow(page: Page): Promise<number> {
	return page.evaluate(() => {
		const containers = [...document.querySelectorAll('[data-slot="table-container"]')];

		return containers.reduce(
			(widest, container) => Math.max(widest, container.scrollWidth - container.clientWidth),
			0
		);
	});
}

/** Адрес базы прогона: его знает только конфигурация Playwright. */
function databaseUrl(info: TestInfo): string {
	const server = info.config.webServer;
	const url = (Array.isArray(server) ? server[0] : server)?.env?.DATABASE_URL;

	if (typeof url !== 'string') {
		throw new Error('playwright.config.ts must set DATABASE_URL for the web server');
	}

	return url;
}

/**
 * Строки журналов для замера ширины. Прямо в базе: журнал обмена наполняется
 * настоящим обменом, а журнал доставок — фоновым циклом, и ждать их ради
 * измерения раскладки значило бы проверять чужую работу.
 *
 * Содержимое берётся худшее из правдоподобного: длинное название вуза,
 * длинное имя получателя и отказ, записанный словами, — раскладка обязана
 * держать именно такую строку, а не «ок».
 */
async function seedJournals(url: string, tag: string): Promise<void> {
	const sql = postgres(url, { max: 1, connect_timeout: 10 });

	try {
		await sql.begin(async (tx) => {
			const [interaction] = await tx<{ id: string }[]>`
				select id from interactions order by length(title) desc limit 1
			`;

			// Запись стадии берётся закрытая (`left_at is not null`): по открытым
			// напоминает фоновый цикл, и строка прогона столкнулась бы с его
			// строкой на ключе «вид × запись × канал».
			const [entry] = await tx<{ id: string; interactionId: string }[]>`
				select id, interaction_id as "interactionId"
				from stage_entries
				where left_at is not null
				order by entered_at desc
				limit 1
			`;

			const [recipient] = await tx<{ id: string }[]>`
				select id from users order by length(full_name) desc limit 1
			`;

			if (interaction === undefined || entry === undefined || recipient === undefined) {
				throw new Error('стенд без взаимодействий, записей стадий или учётных записей');
			}

			await tx`
				insert into exchange_messages
					(direction, system, instance, event_type, event_id, external_id, interaction_id,
					 state, attempt, response_status, payload)
				values
					('inbound', 'cms', 'prod', 'application.created', ${`${tag}-in`},
					 ${`app-${tag}`}, ${interaction.id}, 'processed', 1, 200, '{}'::jsonb),
					('outbound', 'lms', 'prod', 'learning_group.requested', ${`${tag}-out`},
					 ${`grp-${tag}`}, ${interaction.id}, 'failed', 3, 503, '{}'::jsonb)
				on conflict do nothing
			`;

			await tx`
				update exchange_messages
				set last_error = 'Система обучения ответила 503: сервис временно недоступен, повтор по расписанию',
					next_attempt_at = now() + interval '1 hour'
				where event_id = ${`${tag}-out`}
			`;

			await tx`
				insert into notification_deliveries
					(kind, interaction_id, stage_entry_id, recipient_user_id, channel, status,
					 subject, body, attempts, last_error)
				values
					('stage_stuck', ${entry.interactionId}, ${entry.id}, ${recipient.id}, 'email', 'failed',
					 'Зависшее взаимодействие', 'Взаимодействие стоит на одной стадии дольше порога.',
					 3, 'Почтовый сервер отказал: 550 mailbox unavailable, адрес руководителя не принят')
				on conflict (kind, stage_entry_id, channel) do update
				set status = excluded.status,
					attempts = excluded.attempts,
					last_error = excluded.last_error,
					updated_at = now()
			`;
		});
	} finally {
		await sql.end({ timeout: 5 });
	}
}

test('карточка загруженного снимка держит ширину телефона', async ({ page }) => {
	await page.setViewportSize(NARROW);

	// Снимок заводится загрузкой, а не берётся у стенда: у сидированных снимков
	// файла нет, а именно файл добавляет в шапку кнопку «Скачать файл» — рядом с
	// бейджем состояния и кнопкой следующего шага. Три элемента в ряд и есть тот
	// набор, который на телефоне не помещается.
	await page.goto('/data/new');
	// Значение поля даты держит компонент: набранное до того, как страница ожила,
	// остаётся в разметке и в скрытое поле формы не попадает.
	await waitForHydration(page);

	await page.locator('input[name="file"]').setInputFiles({
		name: `ширина-${TAG}.csv`,
		mimeType: 'text/csv',
		buffer: await readFile(FIXTURE)
	});
	// Поле даты — своё (`DateField`): человек пишет `01.09.2023`, а форме уходит
	// `2023-09-01` скрытым полем.
	await page.locator('#periodStart').fill(ruDay(UPLOAD_PERIOD.start));
	await page.locator('#periodEnd').fill(ruDay(UPLOAD_PERIOD.end));
	await expect(page.locator('input[name="periodStart"]')).toHaveValue(UPLOAD_PERIOD.start);
	await expect(page.locator('input[name="periodEnd"]')).toHaveValue(UPLOAD_PERIOD.end);
	await page.getByRole('button', { name: 'Дальше: сопоставление колонок' }).click();
	await expect(page.getByRole('heading', { name: 'Сопоставление колонок' })).toBeVisible();

	const [, , id] = new URL(page.url()).pathname.split('/');

	await page.goto(`/data/${id}`);
	await expect(page.getByRole('heading', { level: 1 })).toContainText('Снимок данных');
	await expect(page.getByRole('link', { name: 'Скачать файл' })).toBeVisible();

	expect(await documentOverflow(page)).toBeLessThanOrEqual(0);
});

test('показатели с выбранным периодом держат ширину телефона', async ({ page }) => {
	await page.setViewportSize(NARROW);
	await page.goto(`/data/indicators?period=${PERIOD_KEY}`);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Показатели');

	const trigger = page.locator('#filter-period');

	// Метка выбранного периода длиннее экрана: «Учебный год: 01.09.2026 —
	// 31.08.2027» не помещается в 390 точек ни при каком кегле.
	await expect(trigger).toContainText('Учебный год');

	const box = await trigger.boundingBox();

	if (box === null) {
		throw new Error('фильтр периода обязан быть на экране');
	}

	// Отдельно от общей меры: страницу тут распирали двое — фильтр и список
	// вкладок, — и по одному документу не видно, который из них вернулся.
	expect(box.x + box.width).toBeLessThanOrEqual(NARROW.width);
	expect(await documentOverflow(page)).toBeLessThanOrEqual(0);
});

/**
 * Отчёт на рабочем экране.
 *
 * Страница была шире окна на четыре точки: полоса вкладок «Срез / Движение»
 * стоит с отрицательным внешним отступом, а полей у страницы не было вовсе —
 * отступу нечего было съедать. Ими же «Колонки» и «Сбросить фильтр» упирались
 * в правый край окна.
 */
test('отчёт держит ширину рабочего экрана и не липнет к краю', async ({ page }) => {
	await page.setViewportSize(WIDE);
	// Отбор включён намеренно: «Сбросить фильтр» появляется только под ним, а
	// это самая правая кнопка страницы.
	await page.goto('/reports?state=active');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Отчёты по взаимодействиям');

	const reset = page.getByRole('link', { name: 'Сбросить фильтр' });
	const columns = page.getByTestId('report-columns');

	await expect(reset).toBeVisible();
	await expect(columns).toBeVisible();

	const resetBox = await reset.boundingBox();
	const columnsBox = await columns.boundingBox();

	if (resetBox === null || columnsBox === null) {
		throw new Error('кнопки отбора обязаны быть на экране');
	}

	// Поле страницы на этой ширине — 24 точки; шестнадцать берутся с запасом на
	// подстановку шрифта.
	for (const box of [resetBox, columnsBox]) {
		expect(box.x + box.width).toBeLessThanOrEqual(WIDE.width - 16);
	}

	expect(await documentOverflow(page)).toBeLessThanOrEqual(0);
});

/**
 * Ключевые колонки журнала обмена: когда, куда, что за событие и чем кончилось.
 * Ответ получателя и ссылка на взаимодействие до 1536 точек стоят строкой под
 * ними — данные остаются на экране, а таблица перестаёт уезжать вбок.
 */
staff('журнал обмена держит ключевые колонки на 1280', async ({ page }, info) => {
	await seedJournals(databaseUrl(info), TAG);

	await page.setViewportSize(WIDE);
	await page.goto(`/exchange?q=${TAG}`);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Внешние системы');
	// Строки прогона и есть то, что меряется: шапка плюс входящее и исходящее.
	await expect(page.getByRole('row')).toHaveCount(3);

	for (const column of ['Когда', 'Направление', 'Тип', 'Состояние']) {
		await expect(page.getByRole('columnheader', { name: column, exact: true })).toBeVisible();
	}

	expect(await tableOverflow(page)).toBeLessThanOrEqual(0);
	expect(await documentOverflow(page)).toBeLessThanOrEqual(0);
});

/**
 * Таблица процесса: стадия, её норматив и требования к переходу. Группа,
 * протухание и чек-лист уезжают под название и под «Требует».
 */
staff('таблица стадий процесса держит ключевые колонки на 1280', async ({ page }) => {
	await page.setViewportSize(WIDE);

	await page.goto('/settings/workflows');
	await expect(page.getByRole('heading', { name: 'Процесс' })).toBeVisible();
	expect(await tableOverflow(page)).toBeLessThanOrEqual(0);

	// Группа стенда с самым длинным процессом: четырнадцать стадий работы с вузом.
	await page.goto('/settings/workflows/b2b');
	await expect(page.getByRole('heading', { level: 1 })).toContainText('Работа с ВУЗ');

	for (const column of ['Ключ', 'Название', 'Норматив', 'Требует']) {
		await expect(page.getByRole('columnheader', { name: column, exact: true })).toBeVisible();
	}

	expect(await tableOverflow(page)).toBeLessThanOrEqual(0);
	expect(await documentOverflow(page)).toBeLessThanOrEqual(0);
});

/**
 * Журнал доставок: повод, адресат, канал и состояние. Попытки и подробности
 * отказа до 1536 точек стоят строкой под состоянием.
 */
staff('журнал доставок держит ключевые колонки на 1280', async ({ page }, info) => {
	await seedJournals(databaseUrl(info), TAG);

	await page.setViewportSize(WIDE);
	// Фильтр отбирает строку прогона: соседние проверки наполняют журнал
	// отправленными письмами, и мерить пришлось бы чужую строку.
	await page.goto('/notifications?status=failed&channel=email');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Уведомления');
	await expect(page.getByRole('row').first()).toBeVisible();

	for (const column of ['Повод', 'Получатель', 'Канал', 'Состояние']) {
		await expect(page.getByRole('columnheader', { name: column, exact: true })).toBeVisible();
	}

	expect(await tableOverflow(page)).toBeLessThanOrEqual(0);
	expect(await documentOverflow(page)).toBeLessThanOrEqual(0);
});
