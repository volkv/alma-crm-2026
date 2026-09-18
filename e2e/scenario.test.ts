import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import * as XLSX from 'xlsx';
import {
	expect,
	test,
	type APIRequestContext,
	type BrowserContext,
	type Download,
	type Locator,
	type Page
} from '@playwright/test';
import { seedId } from '../scripts/seed/ids';
import { DEMO_EMAILS } from '../scripts/seed/users';
import { ADMIN_STATE, LEAD_STATE, MANAGER_STATE, STAFF_ADMIN_STATE } from './global-setup';
import { waitForHydration } from './helpers/hydration';
import { seedProcessGroup } from './helpers/process-group';

/**
 * Сквозной проход по продукту одной историей: от заявки с сайта до отчёта.
 *
 * Здесь не проверяется ни один экран отдельно — этим заняты остальные файлы
 * прогона. Проверяется то, чего по ним не видно: что семь шагов складываются в
 * одну работу и что результат каждого виден следующему. КАМ видит свои вузы,
 * двигает стадию с объяснением и файлом; руководитель передаёт ему вуз;
 * администратор правит действующий процесс, и записи с удалённой стадии
 * переезжают, не теряя истории; заявка с сайта заводит взаимодействие и
 * получает обратно снимок статуса; учебная группа уходит в систему обучения и
 * возвращается результатом; отчёт за период выгружается четырьмя файлами, в
 * которых лежит та самая работа.
 *
 * Шаги идут строго по порядку (`describe.serial`) и в трёх сессиях —
 * менеджера, руководителя и администратора, — потому что роль здесь часть
 * проверки: любой шаг, сделанный «кем угодно», доказывал бы вдвое меньше.
 *
 * Данные — свои. Сброс демонстрационных данных не зовётся: база прогона общая,
 * и сброс унёс бы записи соседних файлов. Взамен проход заводит себе группу
 * процесса, два вуза и два взаимодействия с меткой прогона и сносит их остатки
 * на входе: изменение процесса необратимо (удалённый ключ стадии остаётся
 * занятым за группой навсегда), поэтому повторяемость даёт чистый лист, а не
 * идемпотентность.
 */

/** Метка записей прохода: база прогона общая с разработческой. */
const MARK = 'E2E-СЦЕНАРИЙ';

/** Номер прогона: им отличаются названия, которые проход ищет в файлах отчёта. */
const RUN = Date.now().toString(36);

/**
 * Своя группа процесса, а не `b2b` стенда.
 *
 * Шаг администратора удаляет стадию, а это необратимо: ключ остаётся занятым
 * за группой, и следующий прогон начинался бы уже с другого процесса. Править
 * ради одного прохода общий процесс стенда нельзя и по второй причине — по
 * нему идут записи набора и проверки соседних файлов.
 */
const GROUP_KEY = 'e2e-scenario';
const GROUP_NAME = `${MARK} Подготовка по договору`;

/** Вуз, который КАМ ведёт с самого начала: на нём идёт основная работа. */
const INSTITUTION = {
	id: '1e2e0004-0000-4000-8000-000000000001',
	name: `${MARK} Политехнический университет`
};

/** Вуз руководителя: его он передаёт КАМу на третьем шаге. */
const COLLEGE = {
	id: '1e2e0004-0000-4000-8000-000000000002',
	name: `${MARK} Промышленный колледж`
};

/** Взаимодействие, которое КАМ ведёт руками: стадия, файл, группа, отчёт. */
const MAIN_TITLE = `${MARK} ${RUN} Соглашение о подготовке`;

/** Взаимодействие на стадии, которую администратор удалит: оно и переедет. */
const MOVED_TITLE = `${MARK} ${RUN} Пробный поток второго курса`;

/** Объяснение перехода: его проход ищет в истории после правки процесса. */
const STEP_COMMENT = `Программы сверены на встрече ${RUN}`;

/** Имя приложенного файла: оно тоже обязано пережить правку процесса. */
const STEP_FILE = 'protokol-vstrechi.txt';

/**
 * Процесс группы. Четыре стадии: по первой идёт шаг КАМа, вторую администратор
 * переименовывает, третью удаляет, четвёртая — завершающая.
 *
 * На второй КАМ и остаётся до конца прохода, поэтому она и требует данных
 * обучения: ровно так устроена «Ведение занятий» в процессе стенда — занятия
 * идут в чужой системе, и подтверждает стадию её результат, а не отметка
 * ответственного.
 */
const STAGES = [
	{
		key: 'contact',
		name: 'Первый контакт',
		category: 'contact',
		isFinal: false,
		requiresConfirmation: false,
		requiresLmsData: false
	},
	{
		key: 'programs',
		name: 'Сверка программ',
		category: 'documents',
		isFinal: false,
		requiresConfirmation: true,
		requiresLmsData: true
	},
	{
		key: 'pilot',
		name: 'Пробный поток',
		category: 'documents',
		isFinal: false,
		requiresConfirmation: false,
		requiresLmsData: false
	},
	{
		key: 'result',
		name: 'Итог года',
		category: 'control',
		isFinal: true,
		requiresConfirmation: false,
		requiresLmsData: false
	}
] as const;

const RENAMED_NAME = `${MARK} Сверка программ и площадок`;

/** Ключ заявки с сайта: свой на прогон, иначе вторая заявка обновила бы первую. */
const APPLICATION_ID = `e2e-scenario-${RUN}`;

/**
 * Заявитель: имя и ИНН **не** меняются от прогона к прогону.
 *
 * Приём заявки ищет контрагента по ИНН, поэтому повторный прогон переиспользует
 * ту же организацию, а не заводит рядом ещё одну. Иначе база прогона копила бы
 * по вузу за запуск, и соседние проверки, читающие первую страницу справочника,
 * начали бы падать не от своей ошибки, а от чужого мусора.
 */
const APPLICANT_NAME = `${MARK} Академия связи`;
const APPLICANT_INN = '0000000018';

/** Вуз набора, который ведёт демонстрационный КАМ. */
const SEEDED_OWN = { id: seedId('organization', 'bit'), name: 'МТУСИ' };

/** Вуз другого КАМа того же руководителя: его КАМ видеть не должен. */
const SEEDED_FOREIGN = { name: 'МФТИ' };

/** Имитаторы стенда из `docker-compose.yml`. */
const CMS_URL = 'http://localhost:58081';
const LMS_URL = 'http://localhost:58082';

/**
 * Проход ждёт цикл интеграций: снимок статуса уходит не в ответе на запрос, а
 * следующим проходом — как и на стенде. Плюс сборка PDF отчёта через
 * Gotenberg. Тридцати секунд по умолчанию на шаг не хватает.
 */
test.setTimeout(180_000);

type MockState = {
	objects: {
		applications?: { externalId: string; statuses: { data: Record<string, unknown> }[] }[];
		groups?: { requestExternalId: string; groupExternalId: string }[];
	};
	journal: {
		direction: string;
		summary: string;
		status: number | null;
		eventType: string | null;
		payload: { data?: Record<string, unknown> } | null;
	}[];
};

async function mockState(request: APIRequestContext, service: string): Promise<MockState> {
	const response = await request.get(`${service}/__state`);

	expect(response.ok()).toBeTruthy();

	return (await response.json()) as MockState;
}

/**
 * Открывает всплывающий слой — диалог или список выбора — и дожидается его.
 *
 * Слой открывает код страницы, а не браузер: нажатие до того, как страница
 * ожила, до обработчика не доходит и теряется совсем. Фиксированная пауза
 * закладывалась бы на скорость машины («Всплывающие слои» в
 * `docs/development.md`).
 */
async function openLayer(trigger: Locator, layer: Locator): Promise<void> {
	await expect(async () => {
		await trigger.click();
		await expect(layer).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });
}

/** Конверт контракта обмена (`docs/exchange-contract.md`, раздел 1). */
function envelope(eventType: string, system: string, data: unknown): Record<string, unknown> {
	return {
		schemaVersion: '1.0',
		eventId: crypto.randomUUID(),
		eventType,
		occurredAt: new Date().toISOString(),
		source: { system, instance: system === 'cms' ? 'itschool-site' : 'moodle-itschool' },
		data
	};
}

/** Снимок стадии, каким его кладёт движок в запись о стадии. */
function stageSnapshot(index: number): string {
	const stage = STAGES[index];

	return JSON.stringify({
		key: stage.key,
		name: stage.name,
		position: index + 1,
		category: stage.category,
		slaDays: 7,
		staleAfterDays: null,
		requiresResult: false,
		requiresConfirmation: stage.requiresConfirmation,
		requiresLmsData: stage.requiresLmsData,
		isFinal: stage.isFinal,
		checklist: []
	});
}

/**
 * Записи прохода с нуля: группа процесса с четырьмя стадиями, два вуза с
 * назначениями и два взаимодействия.
 *
 * Прямо в базе, а не через интерфейс, по двум причинам. Группа процесса
 * выбирается по виду основной стороны, и завести взаимодействие в своей группе
 * формой нельзя: за ней не закреплено ни одного вида — закрепить значило бы
 * отобрать учебные заведения у процесса стенда. А сервисы приложения этому
 * файлу недоступны: Playwright запускает его обычным Node, где нет
 * `$env/dynamic/private`.
 */
async function seed(databaseUrl: string): Promise<{ main: string; moved: string }> {
	const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10 });

	try {
		return await sql.begin(async (tx) => {
			const { groupId, stageIds } = await seedProcessGroup(tx, {
				key: GROUP_KEY,
				name: GROUP_NAME,
				description: 'Группа прохода: вида контрагента за ней не закреплено',
				revisionName: 'Процесс прохода',
				stages: STAGES.map((stage) => ({ ...stage, slaDays: 7 })),
				transitions: STAGES.slice(0, -1).map((stage, index) => ({
					fromStageKey: stage.key,
					toStageKey: STAGES[index + 1].key,
					kind: 'forward' as const,
					requiredPermissionKey: 'stages.transition'
				})),
				// Взаимодействие заявки живёт в группе стенда, а взаимодействие прохода
				// могло переехать: остатки сносятся по метке, а не только по группе.
				reset: { interactionTitleLike: `%${MARK}%` }
			});

			for (const organization of [INSTITUTION, COLLEGE]) {
				await tx`
					insert into organizations ${tx({
						id: organization.id,
						kind: 'educational_institution',
						education_level: 'vo',
						legal_name: `${organization.name} (полное наименование)`,
						short_name: organization.name
					})}
					on conflict (id) do nothing
				`;
			}

			const [manager] = await tx<{ id: string }[]>`
				select id from users where email = ${DEMO_EMAILS.manager} limit 1
			`;
			const [lead] = await tx<{ id: string }[]>`
				select id from users where email = ${DEMO_EMAILS.lead} limit 1
			`;

			// Назначения ставятся заново: третий шаг их меняет, и прошлый прогон
			// оставил бы вуз руководителя уже у КАМа — передавать было бы нечего.
			await tx`
				delete from organization_responsibles
				where organization_id in ${tx([INSTITUTION.id, COLLEGE.id])}
			`;

			await tx`
				insert into organization_responsibles ${tx({
					organization_id: INSTITUTION.id,
					user_id: manager.id,
					valid_from: new Date()
				})}
			`;

			await tx`
				insert into organization_responsibles ${tx({
					organization_id: COLLEGE.id,
					user_id: lead.id,
					valid_from: new Date()
				})}
			`;

			/**
			 * Взаимодействие на стадии по её номеру, с основной стороной.
			 *
			 * Ведущий передаётся отдельно: область доступа считается по владельцу
			 * **или** по основной стороне, и взаимодействие, которое КАМ ведёт сам,
			 * он увидел бы и по чужому вузу. Работа руководителя обязана быть
			 * работой руководителя целиком, иначе третий шаг ничего не передаёт.
			 */
			async function interaction(
				title: string,
				organizationId: string,
				stageIndex: number,
				ownerId: string
			): Promise<string> {
				const [row] = await tx<{ id: string }[]>`
					insert into interactions ${tx({
						title,
						process_group_id: groupId,
						owner_user_id: ownerId
					})}
					returning id
				`;

				await tx`
					insert into interaction_parties ${tx({
						interaction_id: row.id,
						organization_id: organizationId,
						party_role: 'educational_institution',
						is_primary: true
					})}
				`;

				await tx`
					insert into stage_entries ${tx({
						interaction_id: row.id,
						stage_id: stageIds.get(STAGES[stageIndex].key) ?? null,
						responsible_user_id: ownerId,
						stage_snapshot: stageSnapshot(stageIndex)
					})}
				`;

				return row.id;
			}

			return {
				main: await interaction(MAIN_TITLE, INSTITUTION.id, 0, manager.id),
				// Стоит на стадии, которую администратор удалит: перенос виден
				// только на том, кто на ней стоял.
				moved: await interaction(MOVED_TITLE, COLLEGE.id, 2, lead.id)
			};
		});
	} finally {
		await sql.end();
	}
}

/**
 * Ключ обмена на машинного субъекта, выпущенный в интерфейсе.
 *
 * Выпускает его штатный администратор, а не демонстрационный: право
 * `api_keys.manage` демонстрационной сессии не достаётся ни при какой роли
 * (`DEMO_DENIED_PERMISSIONS`), и на стенде ключи выпускает именно штатный
 * администратор оператора. Поэтому на один шаг открывается четвёртая сессия —
 * и закрывается сразу же.
 *
 * Подключение указывается при выпуске: права роли «Внешняя система» одинаковы у
 * всех ключей обмена, и только оно не даёт ключу сайта подать результат учебной
 * группы. Поэтому ключей на проход два — по одному на направление.
 */
async function issueExchangeKey(page: Page, connection: RegExp): Promise<string> {
	await page.goto('/settings/api-keys');

	const dialog = page.getByRole('dialog');

	await openLayer(page.getByRole('button', { name: 'Выпустить ключ' }).first(), dialog);

	await dialog.getByLabel('Название').fill(`Обмен ${RUN}`);

	const owner = page.getByRole('option', { name: /Внешние системы/ });

	await openLayer(dialog.getByLabel('Владелец'), owner);
	await owner.click();

	const system = page.getByRole('option', { name: connection });

	await openLayer(dialog.getByLabel('Подключение обмена'), system);
	await system.click();
	await dialog.getByRole('button', { name: 'Выпустить ключ' }).click();

	const issued = page.getByRole('dialog').filter({ hasText: 'выпущен' });
	await expect(issued).toBeVisible();

	const key = await issued.getByRole('textbox', { name: 'Ключ доступа' }).inputValue();

	expect(key).toMatch(/^lct_/);

	await issued.getByRole('button', { name: 'Готово' }).click();

	return key;
}

/** Скачанный файл целиком: отчёт проверяется по содержимому, а не по имени. */
async function downloaded(download: Download): Promise<Buffer> {
	return readFile(await download.path());
}

/** Текст листа книги: им проверяется, что строка доехала до файла. */
function sheetText(body: Buffer): string {
	const book = XLSX.read(body, { type: 'buffer' });

	return book.SheetNames.map((name) => XLSX.utils.sheet_to_csv(book.Sheets[name])).join('\n');
}

test.describe.serial('сквозной сценарий: от заявки до подтверждённого результата', () => {
	let managerContext: BrowserContext;
	let leadContext: BrowserContext;
	let adminContext: BrowserContext;
	let manager: Page;
	let lead: Page;
	let admin: Page;

	let mainId = '';
	let movedId = '';
	let exchangeKey = '';
	let lmsExchangeKey = '';
	let applicationInteractionId = '';
	let learningGroupId = '';

	test.beforeAll(async ({ browser }, testInfo) => {
		const server = testInfo.config.webServer;
		const databaseUrl = (Array.isArray(server) ? server[0] : server)?.env?.DATABASE_URL;

		if (typeof databaseUrl !== 'string') {
			throw new Error('playwright.config.ts must set DATABASE_URL for the web server');
		}

		const ids = await seed(databaseUrl);

		mainId = ids.main;
		movedId = ids.moved;

		managerContext = await browser.newContext({ storageState: MANAGER_STATE });
		leadContext = await browser.newContext({ storageState: LEAD_STATE });
		adminContext = await browser.newContext({ storageState: ADMIN_STATE });

		manager = await managerContext.newPage();
		lead = await leadContext.newPage();
		admin = await adminContext.newPage();
	});

	test.afterAll(async () => {
		await managerContext?.close();
		await leadContext?.close();
		await adminContext?.close();
	});

	test('1. КАМ видит свои вузы и свою работу — и ничего сверх', async () => {
		await manager.goto(`/organizations?q=${encodeURIComponent(SEEDED_OWN.name)}`);
		await expect(manager.getByRole('row').filter({ hasText: SEEDED_OWN.name })).toHaveCount(1);

		// Вуз другого КАМа того же руководителя: область считается по
		// назначениям, и чужая работа за её границей не видна вовсе.
		await manager.goto(`/organizations?q=${encodeURIComponent(SEEDED_FOREIGN.name)}`);
		await expect(manager.getByRole('row').filter({ hasText: SEEDED_FOREIGN.name })).toHaveCount(0);

		await manager.goto(`/organizations?q=${encodeURIComponent(MARK)}`);
		await expect(manager.getByRole('row').filter({ hasText: INSTITUTION.name })).toHaveCount(1);
		// Колледж пока ведёт руководитель — КАМу его не видно.
		await expect(manager.getByRole('row').filter({ hasText: COLLEGE.name })).toHaveCount(0);

		// Доска группы: своя работа стоит на первой стадии, чужая не показана.
		await manager.goto(`/interactions?view=board&group=${GROUP_KEY}`);
		await expect(manager.getByRole('heading', { name: STAGES[0].name })).toBeVisible();
		await expect(manager.getByRole('link', { name: MAIN_TITLE })).toBeVisible();
		await expect(manager.getByRole('link', { name: MOVED_TITLE })).toHaveCount(0);
	});

	test('2. КАМ двигает стадию с комментарием и файлом', async () => {
		await manager.goto(`/interactions/${mainId}`);
		await waitForHydration(manager);
		await expect(manager.getByRole('heading', { level: 1 })).toHaveText(MAIN_TITLE);

		const advance = manager.getByRole('button', { name: `Перейти: ${STAGES[1].name}` });

		await expect(advance).toBeEnabled();
		await advance.click();

		const dialog = manager.getByRole('dialog');

		await expect(dialog.getByLabel('Комментарий')).toBeVisible();
		await dialog.getByLabel('Комментарий').fill(STEP_COMMENT);
		await dialog.getByLabel('Вложения').setInputFiles({
			name: STEP_FILE,
			mimeType: 'text/plain',
			buffer: Buffer.from('Протокол встречи по сверке программ', 'utf8')
		});
		await dialog.getByRole('button', { name: 'Подтвердить' }).click();

		// Лента стадий показывает новую текущую стадию: переход состоялся, а не
		// только закрылся диалог.
		await expect(
			manager.locator('[data-slot="stage-timeline"] [aria-current="step"]')
		).toHaveAccessibleName(new RegExp(`${STAGES[1].name} — текущая`));

		// Объяснение и файл доехали до истории, а не остались в форме.
		await manager.getByRole('tab', { name: 'История' }).click();
		await expect(manager.getByText(`Причина: ${STEP_COMMENT}`)).toBeVisible();
		await expect(manager.getByText(`Вложения: ${STEP_FILE}`)).toBeVisible();
	});

	test('3. Руководитель передаёт вуз КАМу, и доступ меняется сразу', async () => {
		const collegeUrl = `/organizations/${COLLEGE.id}`;

		/** Код ответа карточки колледжа в сессии КАМа. */
		const statusForManager = async (): Promise<number> =>
			(await managerContext.request.get(collegeUrl)).status();

		// До передачи чужой вуз отвечает «не найдено», а не отказом: иначе
		// перебором идентификаторов было бы видно, что лежит за границей области.
		await expect.poll(statusForManager, { timeout: 15_000 }).toBe(404);

		await lead.goto(collegeUrl);
		await expect(lead.getByRole('heading', { level: 1 })).toContainText(COLLEGE.name);

		const form = lead.getByTestId('assign-responsible');

		await form.getByLabel('Сотрудник').selectOption({ label: 'Менеджер Демо' });
		await form.getByRole('button', { name: 'Назначить' }).click();

		// Проверяем доступ, а не тост: тост исчезает сам, и ожидание его
		// видимости проверяло бы скорость машины.
		await expect.poll(statusForManager, { timeout: 15_000 }).toBe(200);

		// Прежнее назначение закрыто, а не стёрто: замена ушла в историю вуза.
		await expect(lead.getByText(/История назначений \(1\)/)).toBeVisible();

		// И работа по переданному вузу пришла к КАМу вместе с ним.
		await manager.goto(`/organizations?q=${encodeURIComponent(MARK)}`);
		await expect(manager.getByRole('row').filter({ hasText: COLLEGE.name })).toHaveCount(1);

		await manager.goto(`/interactions?view=board&group=${GROUP_KEY}`);
		await expect(manager.getByRole('link', { name: MOVED_TITLE })).toBeVisible();
	});

	test('4. Администратор правит живой процесс: записи переезжают, история цела', async () => {
		await admin.goto('/settings/process');
		await admin.getByRole('link', { name: GROUP_NAME, exact: true }).click();

		await expect(admin.getByRole('button', { name: 'Черновик изменений' })).toBeEnabled();
		await admin.getByRole('button', { name: 'Черновик изменений' }).click();
		await expect(admin.getByText('Черновик изменений создан копией')).toBeVisible();

		const dialog = admin.getByRole('dialog');

		// Переименование: ключ стадии остаётся прежним, поэтому записи с неё
		// никуда не поедут — поедут только те, чью стадию удалили.
		const renamed = admin.getByRole('row').filter({ hasText: STAGES[1].key });

		await openLayer(renamed.getByRole('button', { name: 'Изменить' }), dialog);
		await dialog.getByLabel('Название').fill(RENAMED_NAME);
		await dialog.getByRole('button', { name: 'Сохранить стадию' }).click();
		await expect(admin.getByText('Стадия сохранена')).toBeVisible();

		// Удаление: диалог называет число тех, кто стоит на стадии сейчас.
		const removed = admin.getByRole('row').filter({ hasText: STAGES[2].key });

		await openLayer(removed.getByRole('button', { name: 'Удалить' }), dialog);
		await expect(dialog.getByText(/на этой стадии стоит незавершённых/i)).toBeVisible();
		await dialog.getByRole('button', { name: 'Удалить стадию' }).click();
		await expect(admin.getByText('Стадия удалена из черновика')).toBeVisible();

		// Цепочка порвалась: с переименованной стадии больше некуда идти вперёд,
		// и применить черновик нельзя, пока это не починят.
		await expect(admin.getByText(/нет перехода вперёд/).first()).toBeVisible();
		await expect(admin.getByRole('button', { name: 'Применить ко всем' })).toBeDisabled();

		await openLayer(admin.getByRole('button', { name: 'Добавить переход' }).first(), dialog);

		const from = admin.getByRole('option', { name: new RegExp(RENAMED_NAME) });

		await openLayer(dialog.getByRole('button', { name: /^Откуда/ }), from);
		await from.click();

		const to = admin.getByRole('option', { name: new RegExp(STAGES[3].name) });

		await openLayer(dialog.getByRole('button', { name: /^Куда/ }), to);
		await to.click();

		await dialog.getByRole('button', { name: 'Добавить переход' }).click();
		await expect(admin.getByText('Переход добавлен')).toBeVisible();

		// Предпросмотр: сначала числа, потом подтверждение.
		await openLayer(admin.getByRole('button', { name: 'Применить ко всем' }), dialog);
		await expect(dialog.getByText(/Переедут на другую стадию/)).toBeVisible();
		await expect(
			dialog.getByRole('listitem').filter({ hasText: STAGES[2].name }).first()
		).toBeVisible();

		await dialog.getByRole('button', { name: 'Применить ко всем' }).click();
		await expect(admin.getByText(/Процесс изменён/)).toBeVisible();

		// Доска КАМа: колонка названа по-новому, удалённой стадии нет вовсе.
		await manager.goto(`/interactions?view=board&group=${GROUP_KEY}`);
		await expect(manager.getByRole('heading', { name: RENAMED_NAME })).toBeVisible();
		await expect(manager.getByRole('heading', { name: STAGES[2].name })).toHaveCount(0);

		// Переехавшее взаимодействие стоит на целевой стадии, и карточка
		// объясняет перенос словами.
		await manager.goto(`/interactions/${movedId}`);
		await expect(manager.getByText(/Стадия перенесена при изменении процесса/)).toBeVisible();
		await expect(manager.getByRole('button', { name: /^Перейти:/ })).toBeVisible();

		// История второго шага пережила правку процесса целиком: и объяснение, и
		// приложенный файл на месте.
		await manager.goto(`/interactions/${mainId}`);
		await manager.getByRole('tab', { name: 'История' }).click();
		await expect(manager.getByText(`Причина: ${STEP_COMMENT}`)).toBeVisible();
		await expect(manager.getByText(`Вложения: ${STEP_FILE}`)).toBeVisible();
	});

	test('5. Заявка с сайта заводит взаимодействие, снимок статуса уходит обратно', async ({
		browser,
		request
	}) => {
		const staffContext = await browser.newContext({ storageState: STAFF_ADMIN_STATE });

		try {
			const staff = await staffContext.newPage();

			exchangeKey = await issueExchangeKey(staff, /Сайт/);
			lmsExchangeKey = await issueExchangeKey(staff, /Система обучения/);
		} finally {
			await staffContext.close();
		}

		/**
		 * Конверт отправляет сам проход, а не триггер имитатора
		 * (`POST /__send-application`).
		 *
		 * Имитатору задан адрес CRM сети стенда (`CRM_BASE_URL: http://app:3000`
		 * в `docker-compose.yml`), и переопределить его запросом нельзя: он
		 * читается из окружения контейнера при старте. Приложение прогона живёт
		 * на хосте, на другом порту и с другой базой — до него имитатор не
		 * достучится, а нажатие триггера ушло бы в приложение стенда и об этом
		 * проходе не сказало бы ничего. Конверт, ключ, маршрут и проверки при
		 * этом ровно те же, что собирает имитатор; тот же путь выбран и в
		 * `e2e/exchange.test.ts`, а «имитатор сам постучался в CRM» проверяется
		 * там, где оба конца в одном процессе
		 * (`tests/integration/integrations/exchange.test.ts`).
		 */
		const intake = await request.post('/api/v1/applications', {
			headers: { authorization: `Bearer ${exchangeKey}`, 'content-type': 'application/json' },
			data: envelope('application.submitted', 'cms', {
				externalId: APPLICATION_ID,
				revision: 1,
				form: 'b2b',
				applicant: {
					kind: 'educational_institution',
					name: APPLICANT_NAME,
					inn: APPLICANT_INN,
					educationLevel: 'vo'
				},
				contact: {
					lastName: 'Кузьмина',
					firstName: 'Наталья',
					email: `kuzmina-${RUN}@example.org`,
					phone: '+7 900 000-00-11',
					position: 'Проректор по цифровому развитию'
				},
				interest: 'Программа подготовки DevOps-инженеров'
			})
		});

		expect(intake.status()).toBe(200);

		const accepted = (await intake.json()) as {
			result: string;
			data: { interactionId: string };
		};

		expect(accepted.result).toBe('created');
		applicationInteractionId = accepted.data.interactionId;
		expect(applicationInteractionId).toMatch(/^[0-9a-f-]{36}$/);

		// Заявка — не третья сущность рядом с контрагентом и взаимодействием, а
		// сразу работа, и приходит она к живому сотруднику: ответственным за
		// входящие стоит демонстрационный КАМ, и вуз заявки попал в его область.
		const expectedTitle = `Заявка с сайта: ${APPLICANT_NAME}`;

		await manager.goto(`/interactions?q=${encodeURIComponent(APPLICANT_NAME)}`);
		await expect(manager.getByText(expectedTitle)).toBeVisible();

		// Снимок статуса уходит в чужой процесс по сети. Отправляет его цикл
		// интеграций, поэтому ждём — как ждал бы сотрудник.
		await expect(async () => {
			const state = await mockState(request, CMS_URL);

			expect(state.journal.find((entry) => entry.summary.includes(APPLICATION_ID))).toBeDefined();
		}).toPass({ timeout: 120_000, intervals: [2000] });

		const delivered = (await mockState(request, CMS_URL)).journal.find((entry) =>
			entry.summary.includes(APPLICATION_ID)
		);

		// Сообщение дошло и прошло проверку подписи: неподписанное имитатор
		// отвергает кодом 401, не разбирая тела. Тело он разобрал — в журнале
		// лежит конверт со снимком состояния заявки.
		expect(delivered?.eventType).toBe('application.status');
		expect(delivered?.payload?.data).toMatchObject({
			externalId: APPLICATION_ID,
			applicationStatus: 'received',
			stage: { position: 1 }
		});

		// Журнал обмена показывает обе стороны одним списком. Раздел открыт по
		// праву `integrations.manage` — это администратор, не КАМ.
		await admin.goto(`/exchange?q=${encodeURIComponent(APPLICATION_ID)}`);
		await expect(admin.getByRole('heading', { level: 1 })).toHaveText('Внешние системы');
		await expect(admin.getByText('application.submitted').first()).toBeVisible();
		await expect(admin.getByText('application.status').first()).toBeVisible();
	});

	test('6. Учебная группа уходит в LMS, результат возвращается на карточку', async ({
		request
	}) => {
		await manager.goto(`/interactions/${mainId}`);
		await waitForHydration(manager);

		// Стадия требует данных обучения, и их ещё не получали: карточка говорит
		// об этом словами, а не гасит кнопку молча.
		await expect(
			manager.getByText('Стадии нужны данные системы обучения — их ещё не получали.')
		).toBeVisible();

		await manager.getByLabel('Мест в потоке').fill('45');
		await manager.getByLabel('Начало занятий').fill('2026-10-01');
		await manager.getByRole('button', { name: 'Отправить в LMS' }).click();

		const requestExternalId = `crm-group-${mainId}-1`;

		await expect(async () => {
			const state = await mockState(request, LMS_URL);

			expect(
				state.objects.groups?.find((item) => item.requestExternalId === requestExternalId)
			).toBeDefined();
		}).toPass({ timeout: 30_000, intervals: [1000] });

		const group = (await mockState(request, LMS_URL)).objects.groups?.find(
			(item) => item.requestExternalId === requestExternalId
		);

		expect(group).toBeDefined();
		learningGroupId = group!.groupExternalId;

		// Карточка показывает заведённый поток и его имя в чужой системе.
		await manager.reload();
		await expect(manager.getByText('Поток 1')).toBeVisible();
		await expect(manager.getByText(learningGroupId, { exact: false }).first()).toBeVisible();

		// Результат группы: стадию он подтверждает, но никуда её не двигает —
		// переход остаётся решением сотрудника.
		const result = await request.post('/api/v1/exchange/learning-groups/results', {
			headers: { authorization: `Bearer ${lmsExchangeKey}`, 'content-type': 'application/json' },
			data: envelope('learning_group.result', 'lms', {
				groupExternalId: learningGroupId,
				requestExternalId,
				period: { start: '2026-10-01', end: '2027-05-31' },
				finishedOn: '2027-05-20',
				counters: { enrolled: 45, completed: 38, expelled: 4 }
			})
		});

		expect(result.status()).toBe(200);

		// Числа приехали из чужой системы и стали частью работы по взаимодействию.
		await manager.reload();
		await expect(manager.getByText('завершили 38', { exact: false }).first()).toBeVisible();

		// И стадия подтверждена именно ими: не отметкой ответственного, а
		// записью в системе обучения — тем подключением, откуда пришёл результат.
		const confirmation = manager.locator('p').filter({ hasText: 'записью в системе обучения' });

		await expect(confirmation).toContainText('Подтверждено');
		await expect(confirmation).toContainText('lms:moodle-itschool');

		// Двигать взаимодействие результат не стал: стадия та же, и шаг вперёд
		// по-прежнему предлагается человеку.
		await expect(
			manager.locator('[data-slot="stage-timeline"] [aria-current="step"]')
		).toHaveAccessibleName(new RegExp(`${RENAMED_NAME} — текущая`));

		// Обе стороны обмена по этому потоку видны в журнале. Ключей два, и это
		// не небрежность: заявку журнал помнит по нашему ключу потока, а результат
		// — по ключу группы, который выдала чужая система.
		await admin.goto(`/exchange?q=${encodeURIComponent(requestExternalId)}`);
		await expect(admin.getByText('learning_group.requested').first()).toBeVisible();

		await admin.goto(`/exchange?q=${encodeURIComponent(learningGroupId)}`);
		await expect(admin.getByText('learning_group.result').first()).toBeVisible();
	});

	test('7. Отчёт за период выгружается в четырёх форматах', async () => {
		// Адрес отчёта сужен до вуза прохода: числа обязаны сойтись с тем, что
		// проход только что сделал, а не со всем стендом.
		await manager.goto(`/reports?org=${INSTITUTION.id}`);
		await expect(manager.getByRole('heading', { name: 'Отчёты по взаимодействиям' })).toBeVisible();
		await expect(manager.getByTestId('report-row-count')).toHaveText('1');
		await expect(manager.getByRole('link', { name: MAIN_TITLE })).toBeVisible();

		/** Скачивает отчёт одного формата и возвращает файл целиком. */
		async function download(format: string): Promise<{ name: string; body: Buffer }> {
			const [event] = await Promise.all([
				manager.waitForEvent('download'),
				manager.getByTestId(`report-export-${format}`).click()
			]);

			const body = await downloaded(event);

			expect(body.byteLength, `выгрузка ${format} пуста`).toBeGreaterThan(0);

			return { name: event.suggestedFilename(), body };
		}

		const xlsx = await download('xlsx');

		expect(xlsx.name.endsWith('.xlsx')).toBe(true);
		expect(sheetText(xlsx.body)).toContain(MAIN_TITLE);

		const xls = await download('xls');

		expect(xls.name.endsWith('.xls')).toBe(true);
		expect(sheetText(xls.body)).toContain(MAIN_TITLE);

		const json = await download('json');

		expect(json.name.endsWith('.json')).toBe(true);

		const payload = JSON.parse(json.body.toString('utf8')) as {
			rows: { values: Record<string, unknown> }[];
		};

		expect(payload.rows.map((row) => row.values.interaction)).toContain(MAIN_TITLE);

		const pdf = await download('pdf');

		expect(pdf.name.endsWith('.pdf')).toBe(true);
		// PDF читается разборщиком, которого в проекте нет, поэтому проверяется
		// то, что проверить можно: это действительно PDF и он не пустышка.
		expect(pdf.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
		expect(pdf.body.byteLength).toBeGreaterThan(2000);
	});
});
