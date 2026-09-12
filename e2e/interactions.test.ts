import postgres from 'postgres';
import { createRouteSchema } from '$lib/contracts/interactions';
import { DEMO_ROUTE } from '$lib/server/stages/demo-route';
import { expect, test } from './fixtures';

/**
 * Взаимодействие глазами менеджера: список, заведение через форму и работа на
 * стадии. Данные готовятся прямо в базе — сервисы приложения здесь недоступны
 * (Playwright запускает файл обычным Node, где нет `$env/dynamic/private`), а
 * конфигурация маршрута берётся из той же константы, что и в продукте.
 */

/** Метка в названиях: база прогона общая с разработческой, и чужие записи в ней бывают. */
const MARK = 'E2E-СТАДИИ';

const INSTITUTION = {
	id: '1e2e0001-0000-4000-8000-000000000001',
	shortName: `${MARK} Политехнический университет`
};

const CUSTOMER = {
	id: '1e2e0001-0000-4000-8000-000000000002',
	shortName: `${MARK} Компания-заказчик`
};

function databaseUrl(): string {
	const server = test.info().config.webServer;
	const url = (Array.isArray(server) ? server[0] : server)?.env?.DATABASE_URL;

	if (typeof url !== 'string') {
		throw new Error('playwright.config.ts must set DATABASE_URL for the web server');
	}

	return url;
}

/**
 * Маршрут стадий и две организации. Идемпотентно и под блокировкой: файлы
 * прогона выполняются параллельно, и два рабочих процесса не должны заводить
 * маршрут одновременно.
 */
async function seed(): Promise<void> {
	const route = createRouteSchema.parse(DEMO_ROUTE);
	const sql = postgres(databaseUrl(), { max: 1, connect_timeout: 10 });

	try {
		await sql.begin(async (tx) => {
			await tx`select pg_advisory_xact_lock(918273645)`;

			for (const organization of [INSTITUTION, CUSTOMER]) {
				await tx`
					insert into organizations ${tx({
						id: organization.id,
						kind: organization.id === CUSTOMER.id ? 'customer_company' : 'educational_institution',
						education_level: organization.id === CUSTOMER.id ? null : 'vo',
						legal_name: organization.shortName,
						short_name: organization.shortName
					})}
					on conflict (id) do nothing
				`;
			}

			const existing = await tx<{ id: string }[]>`
				select id from stage_routes where key = ${route.key} order by version desc limit 1
			`;

			if (existing.length > 0) {
				return;
			}

			const [created] = await tx<{ id: string }[]>`
				insert into stage_routes ${tx({
					key: route.key,
					version: 1,
					name: route.name,
					description: route.description,
					is_default: true,
					published_at: new Date()
				})}
				returning id
			`;

			const stageIds = new Map<string, string>();

			for (const [index, stage] of route.stages.entries()) {
				const [row] = await tx<{ id: string }[]>`
					insert into stages ${tx({
						route_id: created.id,
						position: index + 1,
						key: stage.key,
						name: stage.name,
						category: stage.category,
						sla_days: stage.slaDays,
						stale_after_days: stage.staleAfterDays,
						requires_result: stage.requiresResult,
						requires_confirmation: stage.requiresConfirmation,
						checklist: JSON.stringify(stage.checklist)
					})}
					returning id
				`;

				stageIds.set(stage.key, row.id);
			}

			for (const transition of route.transitions) {
				await tx`
					insert into stage_transitions ${tx({
						route_id: created.id,
						from_stage_id: stageIds.get(transition.fromStageKey) ?? null,
						to_stage_id: stageIds.get(transition.toStageKey) ?? null,
						kind: transition.kind,
						required_permission_key: transition.requiredPermissionKey,
						requires_reason: transition.requiresReason
					})}
				`;
			}

			await tx`update stage_routes set is_default = false where id <> ${created.id}`;
		});
	} finally {
		await sql.end();
	}
}

test.beforeAll(async () => {
	await seed();
});

/** Заводит взаимодействие через форму и возвращает его название. */
async function createInteraction(page: import('@playwright/test').Page): Promise<string> {
	const title = `${MARK} ${crypto.randomUUID().slice(0, 8)}`;

	await page.goto('/interactions/new');

	// Подсказки организаций появляются только после того, как страница ожила:
	// ввод до гидратации не доходит до компонента, а под нагрузкой прогона это
	// случается. Поэтому ввод повторяется, пока подсказка не покажется.
	const picker = page.getByLabel(/^Учебное заведение/);
	const option = page.getByRole('button', { name: INSTITUTION.shortName });

	await expect(async () => {
		await picker.fill('');
		await picker.pressSequentially(MARK, { delay: 20 });
		await expect(option).toBeVisible({ timeout: 3000 });
	}).toPass({ timeout: 20_000 });

	await option.click();
	// У обязательного поля в доступное имя попадает и пометка «обязательное поле».
	await page.getByLabel(/^Название/).fill(title);
	await page.getByRole('button', { name: 'Создать взаимодействие' }).click();

	await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);

	return title;
}

test('список открывается, ищет и фильтрует по адресу', async ({ page }) => {
	const title = await createInteraction(page);

	await page.goto('/interactions');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Взаимодействия');

	await page.getByPlaceholder('Поиск по названию и организации').fill(title);
	await expect(page).toHaveURL(/[?&]q=/);
	await expect(page.locator('[data-slot="data-table"] tbody tr')).toHaveCount(1);
	await expect(page.getByRole('cell', { name: INSTITUTION.shortName })).toBeVisible();

	await page.getByRole('button', { name: 'Просроченные' }).click();
	await expect(page).toHaveURL(/[?&]overdue=true/);
	await expect(page.getByText('Ничего не найдено')).toBeVisible();
});

test('карточка ведёт по стадии: чек-лист, переход, лента', async ({ page }) => {
	await createInteraction(page);

	const advance = page.getByRole('button', { name: 'Перейти: Коммуникация и сверка программ' });

	// Пока обязательные пункты не закрыты, переход недоступен — и говорит, почему.
	await expect(advance).toBeDisabled();
	await expect(page.getByText('Не закрыт обязательный пункт чек-листа')).toBeVisible();

	await page.getByRole('switch', { name: 'Найдено профильное подразделение' }).click();
	await page.getByRole('switch', { name: 'Подтверждён контакт ответственного лица' }).click();

	await expect(advance).toBeEnabled();
	await advance.click();

	await expect(
		page.getByRole('button', { name: 'Перейти: Встреча с представителями' })
	).toBeVisible();
	await expect(
		page.locator('[data-slot="stage-timeline"] [aria-current="step"]')
	).toHaveAccessibleName(/Коммуникация и сверка программ — текущая/);
});

test('пауза останавливает часы стадии', async ({ page }) => {
	await createInteraction(page);

	await page.getByRole('button', { name: 'Поставить на паузу' }).click();

	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('Чего ждём').fill('Ждём ответа приёмной комиссии');
	await dialog.getByRole('button', { name: 'Поставить на паузу' }).click();

	await expect(page.getByText('На паузе', { exact: true })).toBeVisible();
	await expect(
		page.getByText('Ждём ответа контрагента: Ждём ответа приёмной комиссии')
	).toBeVisible();
	await expect(page.getByRole('button', { name: 'Снять паузу' })).toBeVisible();
});

test('помеха запрещает переход и объясняет отказ', async ({ page }) => {
	await createInteraction(page);

	await page.getByRole('switch', { name: 'Найдено профильное подразделение' }).click();
	await page.getByRole('switch', { name: 'Подтверждён контакт ответственного лица' }).click();
	await expect(page.getByRole('button', { name: /^Перейти:/ })).toBeEnabled();

	await page.getByRole('tab', { name: 'Помехи' }).click();

	// Причина выбирается из справочника. Список bits-ui открывает клиентский
	// код, и нажатие до гидратации теряется совсем — отсюда повтор.
	const reason = page.getByRole('option', { name: 'Не отвечают на запрос' });

	await expect(async () => {
		await page.getByRole('button', { name: 'Причина', exact: true }).click();
		await expect(reason).toBeVisible({ timeout: 3000 });
	}).toPass({ timeout: 20_000 });

	await reason.click();
	await page.getByLabel('Что мешает').fill('Координатор не отвечает вторую неделю');
	await page.getByRole('button', { name: 'Сообщить', exact: true }).click();

	await expect(page.getByText('Есть открытые помехи, запрещающие переход')).toBeVisible();
	await expect(page.getByRole('button', { name: /^Перейти:/ })).toBeDisabled();
});

/**
 * Ширина документа против ширины окна. Таблица и лента вкладок прокручиваются
 * внутри себя — это правильно; уехать вправо не должен сам документ, иначе на
 * телефоне страница болтается вбок вся целиком.
 */
async function pageOverflow(page: import('@playwright/test').Page): Promise<number> {
	return page.evaluate(() => document.body.scrollWidth - window.innerWidth);
}

test('список и карточка держат ширину экрана и сняты для обзора', async ({ page }) => {
	const title = await createInteraction(page);

	await page.screenshot({ path: 'test-results/interactions-card-desktop.png', fullPage: true });

	await page.setViewportSize({ width: 390, height: 844 });
	await page.reload();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
	// Шесть вкладок карточки шире телефона: прокрутиться обязан их список.
	expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
	await page.screenshot({ path: 'test-results/interactions-card-mobile.png', fullPage: true });

	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/interactions');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Взаимодействия');
	await page.screenshot({ path: 'test-results/interactions-list-desktop.png', fullPage: true });

	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/interactions');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Взаимодействия');
	expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
	await page.screenshot({ path: 'test-results/interactions-list-mobile.png', fullPage: true });
});

/**
 * Правый край колонки против правого края её скроллера. Меряется по прямоугольникам
 * на экране: «поместилось» — это про пиксели, а не про классы разметки.
 */
async function fitsInScroller(
	page: import('@playwright/test').Page,
	cell: import('@playwright/test').Locator
): Promise<{ cellRight: number; scrollerRight: number }> {
	const scroller = page.locator('[data-slot="data-table"] [data-slot="table-container"]');
	const cellBox = await cell.boundingBox();
	const scrollerBox = await scroller.boundingBox();

	if (cellBox === null || scrollerBox === null) {
		throw new Error('и ячейка, и её скроллер обязаны быть на экране');
	}

	return {
		cellRight: cellBox.x + cellBox.width,
		scrollerRight: scrollerBox.x + scrollerBox.width
	};
}

test('на ноутбуке срок виден целиком, а не краем', async ({ page }) => {
	await createInteraction(page);

	// 1280 — это обычный ноутбук, и список на нём открывают чаще всего. Срок —
	// то, ради чего его открывают: он решает, за что браться сегодня. Колонка,
	// которая уехала за правый край, отвечает на этот вопрос только прокруткой.
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto('/interactions');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Взаимодействия');

	const header = page.locator('[data-slot="data-table"] thead');

	// Стартовая видимость ставится после того, как страница ожила: до этого
	// момента на экране ещё все колонки, и мерить нечего.
	await expect(header.getByText('Заказчик')).toBeHidden();

	const columns = await header.locator('th').allTextContents();
	const due = columns.findIndex((title) => title.includes('Срок'));
	expect(due).toBeGreaterThan(-1);

	const cell = page.locator('[data-slot="data-table"] tbody tr').first().locator('td').nth(due);
	const { cellRight, scrollerRight } = await fitsInScroller(page, cell);

	expect(cellRight).toBeLessThanOrEqual(scrollerRight);

	// И сама таблица никуда вбок не уехала: строку целиком видно без прокрутки.
	const overflow = await page
		.locator('[data-slot="data-table"] [data-slot="table-container"]')
		.evaluate((node) => node.scrollWidth - node.clientWidth);
	expect(overflow).toBeLessThanOrEqual(0);

	await page.screenshot({ path: 'test-results/interactions-list-1280.png', fullPage: true });
});

test('на ноутбуке список начинается без второстепенных колонок', async ({ page }) => {
	await createInteraction(page);

	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/interactions');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Взаимодействия');

	const header = page.locator('[data-slot="data-table"] thead');

	await expect(header.getByText('Стадия')).toBeVisible();
	await expect(header.getByText('Срок')).toBeVisible();
	await expect(header.getByText('Заказчик')).toBeHidden();
	await expect(header.getByText('Ответственный')).toBeHidden();
	await expect(header.getByText('Активность')).toBeHidden();

	// Скрыта только стартовая видимость: меню «Колонки» возвращает колонку.
	const option = page.getByRole('menuitemcheckbox', { name: 'Ответственный' });

	await expect(async () => {
		await page.getByRole('button', { name: 'Колонки' }).click();
		await expect(option).toBeVisible({ timeout: 3000 });
	}).toPass({ timeout: 20_000 });

	await option.click();
	await page.keyboard.press('Escape');
	await expect(header.getByText('Ответственный')).toBeVisible();
});
