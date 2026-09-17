import postgres from 'postgres';
import { processDefinitionSchema } from '$lib/contracts/interactions';
import { B2B_PROCESS } from '$lib/server/stages/definitions';
import { expect, test } from './fixtures';
import { E2E_USER } from './global-setup';
import { waitForHydration } from './helpers/hydration';

/**
 * Взаимодействие глазами менеджера: список, заведение через форму и работа на
 * стадии. Данные готовятся прямо в базе — сервисы приложения здесь недоступны
 * (Playwright запускает файл обычным Node, где нет `$env/dynamic/private`), а
 * структура процесса берётся из той же константы, что и в продукте.
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

/**
 * Процесс, у которого объяснения требует именно шаг вперёд. В процессе учебных
 * заведений такого перехода нет, а правило процесса обязано быть выполнимым:
 * без поля для объяснения переход вперёд стал бы невозможен вовсе. Он живёт в
 * группе `b2c`: в одной группе действует ровно один процесс.
 */
const REASON_ROUTE = {
	/**
	 * Своя группа, а не `b2c`: там действует процесс стенда из пяти стадий, и
	 * подменять его ради одной проверки незачем. Вида контрагента за этой группой
	 * не закреплено — записи по ней прогон заводит сам.
	 */
	group: 'e2e-forward-reason',
	name: `${MARK} Процесс с объяснением`,
	stages: [
		{ key: 'terms_agreed', name: 'Согласование условий', category: 'contact' },
		{ key: 'terms_closed', name: 'Закрытие соглашения', category: 'documents' }
	]
} as const;

function databaseUrl(): string {
	const server = test.info().config.webServer;
	const url = (Array.isArray(server) ? server[0] : server)?.env?.DATABASE_URL;

	if (typeof url !== 'string') {
		throw new Error('playwright.config.ts must set DATABASE_URL for the web server');
	}

	return url;
}

/**
 * Процессы групп и две организации. Идемпотентно и под блокировкой: файлы
 * прогона выполняются параллельно, и два рабочих процесса не должны заводить
 * редакцию одновременно.
 */
async function seed(): Promise<void> {
	const process = processDefinitionSchema.parse(B2B_PROCESS);
	const sql = postgres(databaseUrl(), { max: 1, connect_timeout: 10 });

	try {
		await sql.begin(async (tx) => {
			await tx`select pg_advisory_xact_lock(918273645)`;

			for (const organization of [INSTITUTION, CUSTOMER]) {
				await tx`
					insert into organizations ${tx({
						id: organization.id,
						kind: organization.id === CUSTOMER.id ? 'legal_entity' : 'educational_institution',
						education_level: organization.id === CUSTOMER.id ? null : 'vo',
						legal_name: organization.shortName,
						short_name: organization.shortName
					})}
					on conflict (id) do nothing
				`;
			}

			// Область доступа КАМа считается по действующим назначениям: без строки
			// в `organization_responsibles` он не увидит ни своей организации в
			// подсказках, ни заведённого по ней взаимодействия.
			const [owner] = await tx<{ id: string }[]>`
				select id from users where email = ${E2E_USER.email} limit 1
			`;

			for (const organization of [INSTITUTION, CUSTOMER]) {
				await tx`
					insert into organization_responsibles ${tx({
						organization_id: organization.id,
						user_id: owner.id,
						valid_from: new Date()
					})}
					on conflict do nothing
				`;
			}

			// Процесс учебных заведений: его кладёт набор данных стенда, но прогон
			// не обязан на это полагаться — без стадий взаимодействие не завести.
			await ensureProcess(
				tx,
				'b2b',
				process.name,
				process.note,
				process.stages,
				process.transitions
			);

			await tx`
				insert into process_groups ${tx({
					key: REASON_ROUTE.group,
					name: 'Проверка обязательного объяснения',
					position: 101
				})}
				on conflict (key) do nothing
			`;

			// Процесс с обязательным объяснением — в своей группе: там своя
			// редакция и свои записи.
			await ensureProcess(
				tx,
				REASON_ROUTE.group,
				REASON_ROUTE.name,
				null,
				REASON_ROUTE.stages.map((stage) => ({
					key: stage.key,
					name: stage.name,
					category: stage.category,
					slaDays: 7,
					staleAfterDays: null,
					requiresResult: false,
					requiresConfirmation: false,
					requiresLmsData: false,
					isFinal: stage.key === 'terms_closed',
					checklist: []
				})),
				[
					{
						fromStageKey: 'terms_agreed',
						toStageKey: 'terms_closed',
						kind: 'forward',
						requiredPermissionKey: 'stages.transition',
						// Требований стадии здесь нет намеренно: переход упирается ровно
						// в объяснение, и проверка говорит только о нём.
						requiresReason: true
					}
				]
			);
		});
	} finally {
		await sql.end();
	}
}

type SeedStage = {
	key: string;
	name: string;
	category: string;
	slaDays: number;
	staleAfterDays: number | null;
	requiresResult: boolean;
	requiresConfirmation: boolean;
	requiresLmsData: boolean;
	isFinal: boolean;
	checklist: { key: string; label: string; required: boolean }[];
};

type SeedTransition = {
	fromStageKey: string;
	toStageKey: string;
	kind: string;
	requiredPermissionKey: string;
	requiresReason: boolean;
};

/**
 * Действующая редакция группы, если её ещё нет. Ставит и реестр ключей: он
 * заводится вместе с первой редакцией, и без него применение изменений
 * посчитало бы все ключи новыми.
 */
async function ensureProcess(
	tx: postgres.TransactionSql,
	groupKey: string,
	name: string,
	note: string | null,
	stages: readonly SeedStage[],
	transitions: readonly SeedTransition[]
): Promise<void> {
	const [group] = await tx<{ id: string; active_revision_id: string | null }[]>`
		select id, active_revision_id from process_groups where key = ${groupKey}
	`;

	if (group === undefined) {
		throw new Error(`Группа процесса «${groupKey}» не заведена миграцией`);
	}

	if (group.active_revision_id !== null) {
		return;
	}

	const [created] = await tx<{ id: string }[]>`
		insert into process_revisions ${tx({
			group_id: group.id,
			version: 1,
			name,
			note,
			published_at: new Date()
		})}
		returning id
	`;

	const stageIds = new Map<string, string>();

	for (const [index, stage] of stages.entries()) {
		const [row] = await tx<{ id: string }[]>`
			insert into stages ${tx({
				revision_id: created.id,
				position: index + 1,
				key: stage.key,
				name: stage.name,
				category: stage.category,
				sla_days: stage.slaDays,
				stale_after_days: stage.staleAfterDays,
				requires_result: stage.requiresResult,
				requires_confirmation: stage.requiresConfirmation,
				requires_lms_data: stage.requiresLmsData,
				is_final: stage.isFinal,
				checklist: JSON.stringify(stage.checklist)
			})}
			returning id
		`;

		stageIds.set(stage.key, row.id);
	}

	for (const transition of transitions) {
		await tx`
			insert into stage_transitions ${tx({
				revision_id: created.id,
				from_stage_id: stageIds.get(transition.fromStageKey) ?? null,
				to_stage_id: stageIds.get(transition.toStageKey) ?? null,
				kind: transition.kind,
				required_permission_key: transition.requiredPermissionKey,
				requires_reason: transition.requiresReason
			})}
		`;
	}

	for (const stage of stages) {
		await tx`
			insert into process_stage_keys ${tx({ group_id: group.id, key: stage.key })}
			on conflict do nothing
		`;
	}

	await tx`update process_groups set active_revision_id = ${created.id} where id = ${group.id}`;
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

/**
 * Взаимодействие на процессе с обязательным объяснением. Заводится прямо в
 * базе: форма выводит группу из вида основной стороны, а здесь нужна другая
 * группа и её контрагент.
 */
async function createReasonInteraction(): Promise<string> {
	const sql = postgres(databaseUrl(), { max: 1, connect_timeout: 10 });

	try {
		return await sql.begin(async (tx) => {
			const [owner] = await tx<{ id: string }[]>`
				select id from users where email = ${E2E_USER.email} limit 1
			`;

			const [stage] = await tx<{ id: string; group_id: string }[]>`
				select s.id, r.group_id
				from stages s
				join process_revisions r on r.id = s.revision_id
				join process_groups g on g.id = r.group_id
				where g.key = ${REASON_ROUTE.group} and s.position = 1
			`;

			const [interaction] = await tx<{ id: string }[]>`
				insert into interactions ${tx({
					title: `${MARK} Объяснение ${crypto.randomUUID().slice(0, 8)}`,
					process_group_id: stage.group_id,
					owner_user_id: owner.id
				})}
				returning id
			`;

			await tx`
				insert into interaction_parties ${tx({
					interaction_id: interaction.id,
					organization_id: CUSTOMER.id,
					party_role: 'customer',
					is_primary: true
				})}
			`;

			await tx`
				insert into stage_entries ${tx({
					interaction_id: interaction.id,
					stage_id: stage.id,
					responsible_user_id: owner.id,
					stage_snapshot: JSON.stringify({
						key: REASON_ROUTE.stages[0].key,
						name: REASON_ROUTE.stages[0].name,
						position: 1,
						category: REASON_ROUTE.stages[0].category,
						slaDays: 7,
						staleAfterDays: null,
						requiresResult: false,
						requiresConfirmation: false,
						requiresLmsData: false,
						isFinal: false,
						checklist: []
					})
				})}
			`;

			return interaction.id;
		});
	} finally {
		await sql.end();
	}
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

test('карточка ведёт по стадии: чек-лист, переход с файлом, лента', async ({ page }) => {
	await createInteraction(page);

	const advance = page.getByRole('button', { name: 'Перейти: Коммуникация и сверка программ' });

	// Пока обязательные пункты не закрыты, переход недоступен — и говорит, почему.
	await expect(advance).toBeDisabled();
	await expect(page.getByText('Не закрыт обязательный пункт чек-листа')).toBeVisible();

	await page.getByRole('switch', { name: 'Найдено профильное подразделение' }).click();
	await page.getByRole('switch', { name: 'Подтверждён контакт ответственного лица' }).click();

	await expect(advance).toBeEnabled();
	await advance.click();

	// Комментарий и вложения доступны при любом переходе, а не только там, где
	// процесс требует объяснения.
	const dialog = page.getByRole('dialog');
	await expect(dialog.getByLabel('Комментарий')).toBeVisible();
	await dialog.getByLabel('Комментарий').fill('Контакт подтверждён письмом деканата');
	await dialog.getByLabel('Вложения').setInputFiles({
		name: 'kontakt.txt',
		mimeType: 'text/plain',
		buffer: Buffer.from('Письмо деканата о контактном лице', 'utf8')
	});
	await dialog.getByRole('button', { name: 'Подтвердить' }).click();

	await expect(
		page.getByRole('button', { name: 'Перейти: Встреча с представителями' })
	).toBeVisible();
	await expect(
		page.locator('[data-slot="stage-timeline"] [aria-current="step"]')
	).toHaveAccessibleName(/Коммуникация и сверка программ — текущая/);

	// Файл виден на той стадии, где его приложили, а не общим списком карточки.
	await page.getByRole('tab', { name: 'История' }).click();
	await expect(page.getByText('Вложения: kontakt.txt')).toBeVisible();
});

test('шаг вперёд с обязательным объяснением спрашивает комментарий', async ({ page }) => {
	const comment = 'Условия согласованы протоколом встречи';
	const interactionId = await createReasonInteraction();

	await page.goto(`/interactions/${interactionId}`);
	await waitForHydration(page);

	const advance = page.getByRole('button', {
		name: `Перейти: ${REASON_ROUTE.stages[1].name}`
	});

	// Переход доступен: объяснение спрашивают в диалоге, а не гасят им кнопку.
	await expect(advance).toBeEnabled();
	await advance.click();

	const dialog = page.getByRole('dialog');
	const field = dialog.getByLabel('Комментарий');

	await expect(field).toBeVisible();
	await field.fill(comment);
	await dialog.getByRole('button', { name: 'Подтвердить' }).click();

	// Стадия сменилась, а объяснение доехало до истории, а не осталось в форме.
	await expect(advance).toHaveCount(0);
	await page.getByRole('tab', { name: 'История' }).click();
	await expect(page.getByText(`Причина: ${comment}`)).toBeVisible();
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
	await expect(header.getByText('Компания-заказчик')).toBeHidden();

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
	await expect(header.getByText('Компания-заказчик')).toBeHidden();
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
