import postgres from 'postgres';
import { expect, test as base, type Browser, type Locator } from '@playwright/test';
import { MANAGER_STATE, STAFF_ADMIN_STATE, E2E_USER } from './global-setup';
import { seedProcessGroup } from './helpers/process-group';

/**
 * Процесс глазами администратора: черновик изменений, предпросмотр и
 * применение ко всем.
 *
 * Процесс меняет тот, кто отвечает за устройство работы: право
 * `stages.configure` есть только у администратора. Поэтому правит процесс
 * штатный администратор оператора (`staff`), а КАМу (`manager`) раздел закрыт —
 * это и проверяется.
 *
 * Прогон работает в своей группе, а не в `b2b`: изменение процесса необратимо —
 * удалённый ключ стадии остаётся занятым навсегда, — и второй прогон по группе
 * стенда начинался бы уже с другого состояния. Группа заводится заново на
 * каждый прогон вместе с трёхстадийным процессом и одним взаимодействием,
 * стоящим на средней стадии: на нём и видно, что перенос состоялся.
 */
const staff = base.extend<object>({ storageState: STAFF_ADMIN_STATE });
const manager = base.extend<object>({ storageState: MANAGER_STATE });

/** Метка в названиях: база прогона общая с разработческой, и чужие записи бывают. */
const MARK = 'E2E-ПРОЦЕСС';

const GROUP_KEY = 'e2e-process';
const ORGANIZATION_ID = '1e2e0003-0000-4000-8000-000000000001';
const INTERACTION_TITLE = `${MARK} Взаимодействие на средней стадии`;

/** Стадия, которую прогон переименовывает: на ней стоит взаимодействие. */
const RENAMED_KEY = 'middle';
const RENAMED_NAME = `${MARK} Середина, названная иначе`;

/** Стадия, которую прогон удаляет: записи с неё переедут на предыдущую. */
const REMOVED_KEY = 'extra';
const REMOVED_NAME = 'Лишняя стадия';

const STAGES = [
	{ key: 'start', name: 'Начало', category: 'contact', isFinal: false },
	{ key: RENAMED_KEY, name: 'Середина', category: 'documents', isFinal: false },
	{ key: REMOVED_KEY, name: REMOVED_NAME, category: 'documents', isFinal: false },
	{ key: 'finish', name: 'Завершение', category: 'control', isFinal: true }
] as const;

function databaseUrl(): string {
	const server = base.info().config.webServer;
	const url = (Array.isArray(server) ? server[0] : server)?.env?.DATABASE_URL;

	if (typeof url !== 'string') {
		throw new Error('playwright.config.ts must set DATABASE_URL for the web server');
	}

	return url;
}

/**
 * Группа прогона с нуля: прежняя удаляется вместе с редакциями, стадиями и
 * взаимодействиями. Изменение процесса необратимо, поэтому повторяемость
 * достигается не идемпотентностью, а чистым листом, — об этом `reset` у общего
 * хелпера, он же берёт замок на остальную подготовку.
 */
async function seed(): Promise<void> {
	const sql = postgres(databaseUrl(), { max: 1, connect_timeout: 10 });

	try {
		await sql.begin(async (tx) => {
			const { groupId, stageIds } = await seedProcessGroup(tx, {
				key: GROUP_KEY,
				name: 'Проверка изменения процесса',
				description: 'Группа прогона: вида контрагента за ней не закреплено',
				revisionName: 'Процесс прогона',
				stages: STAGES.map((stage) => ({ ...stage, slaDays: 7 })),
				transitions: STAGES.slice(0, -1).map((stage, index) => ({
					fromStageKey: stage.key,
					toStageKey: STAGES[index + 1].key,
					kind: 'forward' as const,
					requiredPermissionKey: 'stages.transition'
				})),
				reset: { interactionTitleLike: INTERACTION_TITLE }
			});

			await tx`
				insert into organizations ${tx({
					id: ORGANIZATION_ID,
					kind: 'educational_institution',
					education_level: 'vo',
					legal_name: `${MARK} Университет`,
					short_name: `${MARK} Университет`
				})}
				on conflict (id) do nothing
			`;

			const [owner] = await tx<{ id: string }[]>`
				select id from users where email = ${E2E_USER.email} limit 1
			`;

			// Область доступа КАМа считается по действующим назначениям: без строки
			// в `organization_responsibles` он не увидит эту работу на доске.
			await tx`
				insert into organization_responsibles ${tx({
					organization_id: ORGANIZATION_ID,
					user_id: owner.id,
					valid_from: new Date()
				})}
				on conflict do nothing
			`;

			const [interaction] = await tx<{ id: string }[]>`
				insert into interactions ${tx({
					title: INTERACTION_TITLE,
					process_group_id: groupId,
					owner_user_id: owner.id
				})}
				returning id
			`;

			await tx`
				insert into interaction_parties ${tx({
					interaction_id: interaction.id,
					organization_id: ORGANIZATION_ID,
					party_role: 'educational_institution',
					is_primary: true
				})}
			`;

			// Взаимодействие стоит на стадии, которую прогон удалит: перенос виден
			// только на том, кто на ней стоял.
			await tx`
				insert into stage_entries ${tx({
					interaction_id: interaction.id,
					stage_id: stageIds.get(REMOVED_KEY) ?? null,
					responsible_user_id: owner.id,
					stage_snapshot: {
						key: REMOVED_KEY,
						name: REMOVED_NAME,
						position: 3,
						category: 'documents',
						slaDays: 7,
						staleAfterDays: null,
						requiresResult: false,
						requiresConfirmation: false,
						requiresLmsData: false,
						isFinal: false,
						checklist: []
					}
				})}
			`;
		});
	} finally {
		await sql.end();
	}
}

/**
 * Открывает всплывающий слой — диалог или список выбора — и дожидается его.
 *
 * Слой открывает код страницы, а не браузер: нажатие до того, как страница
 * ожила, до обработчика не доходит и теряется совсем. Поэтому нажимаем, пока
 * слой не появится, — фиксированная пауза закладывалась бы на скорость машины
 * (см. `docs/development.md`, «Всплывающие слои»).
 */
async function openLayer(trigger: Locator, layer: Locator): Promise<void> {
	await expect(async () => {
		await trigger.click();
		await expect(layer).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });
}

staff('черновик изменений применяется ко всем и переносит записи', async ({ page, browser }) => {
	await seed();

	await page.goto('/settings/process');

	// Список — это группы контрагентов, а не версии процесса: номера редакции на
	// экране нет вовсе.
	await expect(page.getByRole('cell', { name: 'Версия' })).toHaveCount(0);
	await page.getByRole('link', { name: 'Проверка изменения процесса' }).click();

	await expect(page.getByRole('button', { name: 'Черновик изменений' })).toBeEnabled();
	await page.getByRole('button', { name: 'Черновик изменений' }).click();

	await expect(page.getByText('Черновик изменений создан копией')).toBeVisible();
	await expect(page.getByRole('row').filter({ hasText: REMOVED_KEY })).toHaveCount(1);

	const dialog = page.getByRole('dialog');

	// Переименование: ключ остаётся прежним, поэтому записи никуда не поедут.
	const renamedRow = page.getByRole('row').filter({ hasText: RENAMED_KEY });
	await openLayer(renamedRow.getByRole('button', { name: 'Изменить' }), dialog);

	// Ключ существующей стадии не правится: поля для него в диалоге нет вовсе.
	await expect(dialog.getByLabel('Ключ')).toHaveCount(0);
	await dialog.getByLabel('Название').fill(RENAMED_NAME);
	await dialog.getByRole('button', { name: 'Сохранить стадию' }).click();

	await expect(page.getByText('Стадия сохранена')).toBeVisible();

	// Удаление: диалог называет число тех, кто стоит на стадии сейчас, и куда
	// они переедут. Цель по умолчанию — предыдущая сохранившаяся стадия.
	const removedRow = page.getByRole('row').filter({ hasText: REMOVED_KEY });
	await openLayer(removedRow.getByRole('button', { name: 'Удалить' }), dialog);

	await expect(dialog.getByText(/на этой стадии стоит незавершённых/i)).toBeVisible();
	await dialog.getByRole('button', { name: 'Удалить стадию' }).click();

	await expect(page.getByText('Стадия удалена из черновика')).toBeVisible();
	await expect(page.getByRole('row').filter({ hasText: REMOVED_KEY })).toHaveCount(0);

	// Цепочка порвалась: со стадии перед удалённой больше некуда идти вперёд, и
	// применить черновик нельзя, пока это не починят. Экран говорит об этом
	// словами, а не молча гасит кнопку.
	await expect(page.getByText(/нет перехода вперёд/).first()).toBeVisible();
	await expect(page.getByRole('button', { name: 'Применить ко всем' })).toBeDisabled();

	await openLayer(page.getByRole('button', { name: 'Добавить переход' }).first(), dialog);

	const from = page.getByRole('option', { name: new RegExp(RENAMED_NAME) });
	await openLayer(dialog.getByRole('button', { name: /^Откуда/ }), from);
	await from.click();

	const to = page.getByRole('option', { name: /Завершение/ });
	await openLayer(dialog.getByRole('button', { name: /^Куда/ }), to);
	await to.click();

	await dialog.getByRole('button', { name: 'Добавить переход' }).click();
	await expect(page.getByText('Переход добавлен')).toBeVisible();

	// Предпросмотр: сначала числа, потом подтверждение.
	await openLayer(page.getByRole('button', { name: 'Применить ко всем' }), dialog);

	await expect(dialog.getByText(/Затронуто взаимодействий/)).toBeVisible();
	await expect(dialog.getByRole('row').filter({ hasText: REMOVED_NAME })).toBeVisible();

	await dialog.getByRole('button', { name: 'Применить ко всем' }).click();

	await expect(page.getByText(/Процесс изменён/)).toBeVisible();

	// Применённый черновик стал действующим процессом: правит его только
	// следующий черновик.
	await expect(page.getByRole('button', { name: 'Добавить стадию' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Черновик изменений' })).toBeVisible();
	await expect(page.getByRole('row').filter({ hasText: RENAMED_NAME }).first()).toBeVisible();

	// «Изменения процесса» — не экран, а журнал с фильтром по событиям.
	await page.getByRole('link', { name: 'Изменения процесса' }).click();
	await expect(page.getByText('Изменения процесса применены').first()).toBeVisible();

	await checkManagerSeesMigration(browser);
});

/**
 * КАМ в своей сессии: переехавшее взаимодействие стоит на целевой стадии, на
 * карточке объяснён перенос, а удалённой стадии на доске больше нет.
 *
 * Отдельным контекстом, а не отдельным тестом: прогон идёт полностью
 * параллельно, и второй тест не может опираться на то, что сделал первый.
 */
async function checkManagerSeesMigration(browser: Browser): Promise<void> {
	const context = await browser.newContext({ storageState: MANAGER_STATE });
	const page = await context.newPage();

	try {
		await page.goto(`/interactions?view=board&group=${GROUP_KEY}`);

		// Колонки — стадии действующего процесса: удалённой среди них нет.
		await expect(page.getByRole('heading', { name: RENAMED_NAME })).toBeVisible();
		await expect(page.getByRole('heading', { name: REMOVED_NAME })).toHaveCount(0);

		await page.getByRole('link', { name: INTERACTION_TITLE }).click();

		await expect(page.getByRole('heading', { level: 1 })).toHaveText(INTERACTION_TITLE);
		await expect(page.getByText(/Стадия перенесена при изменении процесса/)).toBeVisible();

		// Работа продолжается: с целевой стадии есть куда идти дальше.
		await expect(page.getByRole('button', { name: /^Перейти:/ })).toBeVisible();
	} finally {
		await context.close();
	}
}

manager('настройка процесса КАМу не принадлежит', async ({ page }) => {
	await page.goto('/settings/profile');

	// Меню настроек собирается из прав: чего нет в нём, того нет и по ссылке.
	await expect(page.getByRole('link', { name: 'Процесс' })).toHaveCount(0);

	const response = await page.request.get('/settings/process');
	expect(response.status()).toBe(403);
});
