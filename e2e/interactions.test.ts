import postgres from 'postgres';
import { processDefinitionSchema } from '$lib/contracts/interactions';
import { B2B_PROCESS } from '$lib/server/stages/definitions';
import { expect, test } from './fixtures';
import { E2E_USER } from './global-setup';
import { waitForHydration } from './helpers/hydration';
import { seedProcessGroup } from './helpers/process-group';

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

/**
 * Процесс, стадию которого закрывает отметка по документу дела.
 *
 * Своя группа, а не `b2b`: в процессе стенда требование стоит на подписании
 * соглашения, но редакция той группы заводится один раз и переживает прогон —
 * на базе, залитой прежней версией, проверка говорила бы о вчерашнем процессе.
 * Ключ группы новый, поэтому её редакция описывает ровно эти стадии.
 */
const MARK_ROUTE = {
	group: 'e2e-document-mark',
	name: `${MARK} Процесс с отметкой документа`,
	interactionTitle: `${MARK} Отметка документа`,
	stages: [
		{ key: 'agreement_signing', name: 'Подписание соглашения', category: 'documents' },
		{ key: 'agreement_done', name: 'Соглашение действует', category: 'control' }
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
 * Процессы групп и две организации. Идемпотентно и под блокировкой: замок
 * берёт общий хелпер первым же запросом, и под ним идёт вся подготовка — файлы
 * прогона выполняются параллельно, и два рабочих процесса не должны заводить
 * редакцию одновременно.
 */
async function seed(): Promise<void> {
	const process = processDefinitionSchema.parse(B2B_PROCESS);
	const sql = postgres(databaseUrl(), { max: 1, connect_timeout: 10 });

	try {
		await sql.begin(async (tx) => {
			// Процесс учебных заведений: его кладёт набор данных стенда, но прогон
			// не обязан на это полагаться — без стадий взаимодействие не завести.
			// Группа при этом своя не бывает: за `b2b` закреплён вид контрагента.
			await seedProcessGroup(tx, {
				key: 'b2b',
				name: null,
				revisionName: process.name,
				revisionNote: process.note,
				stages: process.stages,
				transitions: process.transitions
			});

			// Процесс с обязательным объяснением — в своей группе: там своя
			// редакция и свои записи.
			await seedProcessGroup(tx, {
				key: REASON_ROUTE.group,
				name: 'Проверка обязательного объяснения',
				revisionName: REASON_ROUTE.name,
				stages: REASON_ROUTE.stages.map((stage) => ({
					...stage,
					slaDays: 7,
					isFinal: stage.key === 'terms_closed'
				})),
				transitions: [
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
			});

			// Процесс с отметкой по документу — в своей группе: в `b2b` требование
			// стоит на подписании соглашения, но редакция той группы заводится
			// один раз и переживает прогон, и на базе, залитой прежней версией,
			// проверка говорила бы о вчерашнем процессе.
			await seedProcessGroup(tx, {
				key: MARK_ROUTE.group,
				name: 'Проверка отметки по документу',
				revisionName: MARK_ROUTE.name,
				stages: MARK_ROUTE.stages.map((stage) => ({
					...stage,
					slaDays: 7,
					requiresDocumentMark: stage.key === 'agreement_signing' ? ('approved' as const) : null,
					isFinal: stage.key === 'agreement_done'
				})),
				transitions: [
					{
						fromStageKey: 'agreement_signing',
						toStageKey: 'agreement_done',
						kind: 'forward',
						requiredPermissionKey: 'stages.transition'
					}
				]
			});

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
						requiresDocumentMark: null,
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

/** Взаимодействие на стадии, которую закрывает отметка по документу дела. */
async function createMarkInteraction(): Promise<string> {
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
				where g.key = ${MARK_ROUTE.group} and s.position = 1
			`;

			const [interaction] = await tx<{ id: string }[]>`
				insert into interactions ${tx({
					title: `${MARK_ROUTE.interactionTitle} ${crypto.randomUUID().slice(0, 8)}`,
					process_group_id: stage.group_id,
					owner_user_id: owner.id
				})}
				returning id
			`;

			await tx`
				insert into interaction_parties ${tx({
					interaction_id: interaction.id,
					organization_id: INSTITUTION.id,
					party_role: 'educational_institution',
					is_primary: true
				})}
			`;

			await tx`
				insert into stage_entries ${tx({
					interaction_id: interaction.id,
					stage_id: stage.id,
					responsible_user_id: owner.id,
					stage_snapshot: JSON.stringify({
						key: MARK_ROUTE.stages[0].key,
						name: MARK_ROUTE.stages[0].name,
						position: 1,
						category: MARK_ROUTE.stages[0].category,
						slaDays: 7,
						staleAfterDays: null,
						requiresResult: false,
						requiresConfirmation: false,
						requiresLmsData: false,
						requiresDocumentMark: 'approved',
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

test('отметка по документу закрывает стадию, а отметка ответственного — нет', async ({ page }) => {
	const interactionId = await createMarkInteraction();
	const title = `Соглашение ${crypto.randomUUID().slice(0, 8)}`;
	const note = 'Протокол учёного совета № 14';

	await page.goto(`/interactions/${interactionId}`);
	await waitForHydration(page);

	const advance = page.getByRole('button', { name: `Перейти: ${MARK_ROUTE.stages[1].name}` });

	// Пока отметки нет, стадия говорит об этом словами, а не пустым местом, и
	// шаг вперёд отказывает по той же причине.
	await expect(page.getByText(/Стадии нужна отметка «Утверждён»/)).toBeVisible();
	await expect(advance).toBeDisabled();
	await expect(advance.locator('xpath=following-sibling::p')).toContainText(
		'нет документа с отметкой «Утверждён»'
	);

	// Отметка ответственного подтверждает стадию, но требование не закрывает:
	// подписан документ или нет — это факт о самой бумаге.
	await page.getByRole('button', { name: 'Подтвердить стадию' }).click();
	await expect(page.getByText('Подтверждено', { exact: false }).first()).toBeVisible();
	await expect(advance).toBeDisabled();

	await page.getByRole('tab', { name: 'Документы' }).click();

	const upload = page.locator('[data-slot="card"]').filter({ hasText: 'Загрузить документ' });

	await upload.getByLabel('Название').fill(title);
	await upload.getByLabel('Файл').setInputFiles({
		name: 'agreement.txt',
		mimeType: 'text/plain',
		buffer: Buffer.from('Подписанный экземпляр соглашения', 'utf8')
	});
	await upload.getByRole('button', { name: 'Загрузить' }).click();

	const row = page.locator('li').filter({ hasText: title });

	await expect(row).toBeVisible();
	await row.getByRole('button', { name: 'Отметить' }).click();

	const dialog = page.getByRole('dialog');
	const approved = page.getByRole('option', { name: 'Утверждён', exact: true });

	await expect(async () => {
		await dialog.getByRole('combobox', { name: 'Отметка' }).click();
		await expect(approved).toBeVisible({ timeout: 3000 });
	}).toPass({ timeout: 20_000 });

	await approved.click();
	await dialog.getByLabel('Комментарий').fill(note);
	await dialog.getByRole('button', { name: 'Поставить отметку' }).click();

	// Комментарий стоит рядом с отметкой: дата отвечает «когда», но не «чем».
	await expect(page.getByText(`Утверждён: ${note}`)).toBeVisible();

	await page.getByRole('tab', { name: 'Стадия' }).click();

	// Стадию закрыла сама отметка: отдельной команды «подтвердить» человек не
	// отдавал, а движок засчитал факт в той же транзакции.
	await expect(page.getByText('Подтверждено отметкой документа')).toBeVisible();
	await expect(page.getByText(new RegExp(`«${title}» от \\d{2}\\.\\d{2}\\.\\d{4}`))).toBeVisible();
	await expect(page.getByRole('link', { name: 'Открыть документ' })).toBeVisible();
	await expect(advance).toBeEnabled();
});

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
	// Причина написана дважды и по делу: в панели «Что мешает» — списком того,
	// что держит запись, и под самой кнопкой — почему не нажимается она. Здесь
	// проверяется вторая: абзац сразу под кнопкой перехода.
	await expect(advance.locator('xpath=following-sibling::p')).toContainText(
		'Не закрыт обязательный пункт чек-листа'
	);

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

/**
 * Диалог перехода против случайного `Esc`.
 *
 * Объяснение перехода набирают руками и один раз: `Esc`, клик вне слоя и
 * крестик стирали его молча, и после повторного открытия поле было пустым.
 * Теперь уход спрашивает подтверждение, а отказ от ухода оставляет набранное
 * на месте.
 */
test('закрытие диалога перехода не выбрасывает набранное молча', async ({ page }) => {
	const comment = 'Деканат подтвердил контактное лицо письмом';

	await createInteraction(page);
	await waitForHydration(page);

	await page.getByRole('switch', { name: 'Найдено профильное подразделение' }).click();
	await page.getByRole('switch', { name: 'Подтверждён контакт ответственного лица' }).click();

	const advance = page.getByRole('button', { name: 'Перейти: Коммуникация и сверка программ' });

	await expect(advance).toBeEnabled();
	await advance.click();

	const dialog = page.getByRole('dialog');
	const field = dialog.getByLabel('Комментарий');

	await expect(field).toBeVisible();
	await field.fill(comment);

	await page.keyboard.press('Escape');

	// Вопрос — отдельным слоем: у него своя роль, и диалог перехода под ним жив.
	const discard = page.getByRole('alertdialog');

	await expect(discard).toBeVisible();
	await discard.getByRole('button', { name: 'Вернуться к вводу' }).click();
	await expect(discard).toHaveCount(0);
	await expect(field).toHaveValue(comment);

	// Второй раз — с подтверждением: ввод выброшен осознанно, а не молча.
	await page.keyboard.press('Escape');
	await expect(discard).toBeVisible();
	await discard.getByRole('button', { name: 'Закрыть без сохранения' }).click();

	await expect(dialog).toHaveCount(0);
	await expect(advance).toBeEnabled();
});

/**
 * Лента стадий на рабочем экране.
 *
 * Процесс работы с вузом — четырнадцать стадий, и в тысячу точек они не
 * помещаются: на экране семь, остальные за краем. Лента прокручивается внутри
 * себя, документ вбок не уезжает, а до последней стадии можно добраться
 * кнопкой — то есть и с клавиатуры, а не только колесом.
 */
test('лента стадий прокручивается до последней, не распирая страницу', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await createInteraction(page);
	await waitForHydration(page);

	const timeline = page.locator('[data-slot="stage-timeline"]');
	const rail = timeline.locator('[data-slot="stage-timeline-rail"]');
	const last = rail.locator('[data-stage]').last();

	await expect(rail).toBeVisible();

	const railBox = await rail.boundingBox();
	const beforeBox = await last.boundingBox();

	if (railBox === null || beforeBox === null) {
		throw new Error('лента стадий обязана быть на экране');
	}

	// Пока не прокрутили — последняя стадия за краем ленты: ровно та ситуация,
	// в которой подпись у правого края обрезана и об этом надо сказать.
	expect(beforeBox.x + beforeBox.width).toBeGreaterThan(railBox.x + railBox.width);

	const forward = timeline.getByRole('button', { name: 'Следующие стадии' });

	await expect(forward).toBeVisible();

	// Кнопка — код страницы: нажатие до гидратации теряется, а само нажатие
	// безопасно повторить — лента упирается в конец и дальше не едет.
	await expect(async () => {
		if (await forward.isEnabled()) {
			await forward.click({ timeout: 5_000 });
		}

		await expect(forward).toBeDisabled({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	const afterBox = await last.boundingBox();

	if (afterBox === null) {
		throw new Error('последняя стадия обязана быть на экране');
	}

	// Докрутили до конца: последняя стадия видна целиком, ничем не обрезана.
	expect(afterBox.x).toBeGreaterThanOrEqual(railBox.x - 1);
	expect(afterBox.x + afterBox.width).toBeLessThanOrEqual(railBox.x + railBox.width + 1);

	// Прокручивается лента, а не документ.
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);

	expect(overflow).toBeLessThanOrEqual(0);
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

	// Причина выбирается из справочника. Роль выбора — `combobox`: так эту пару
	// «кнопка и список» описывает ARIA. Список bits-ui открывает клиентский код,
	// и нажатие до гидратации теряется совсем — отсюда повтор.
	const reason = page.getByRole('option', { name: 'Не отвечают на запрос' });

	await expect(async () => {
		await page.getByRole('combobox', { name: 'Причина', exact: true }).click();
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

test('выбранное представление раздел помнит, а ссылка с адресом — важнее памяти', async ({
	page
}) => {
	await createInteraction(page);

	await page.goto('/interactions');
	await waitForHydration(page);
	await expect(page.locator('[data-slot="data-table"]')).toBeVisible();

	await page.getByRole('button', { name: 'Доска' }).click();
	await expect(page).toHaveURL(/[?&]view=board/);

	// Ушли из раздела и вернулись адресом без параметра: «как обычно» — это то,
	// чем раздел смотрели в прошлый раз, и приходит оно сразу с сервера —
	// таблицей по дороге не мелькает.
	await page.goto('/');
	await page.goto('/interactions');
	await expect(page.locator('[data-slot="data-table"]')).toHaveCount(0);
	await waitForHydration(page);
	await expect(page.locator('[data-slot="data-table"]')).toHaveCount(0);

	// Память личная, а ссылка — общая: пришли по адресу с представлением —
	// показывается ровно то, чем поделились.
	await page.goto('/interactions?view=table');
	await waitForHydration(page);
	await expect(page.locator('[data-slot="data-table"]')).toBeVisible();

	// И этот выбор становится новым «как обычно».
	await page.goto('/interactions');
	await expect(page.locator('[data-slot="data-table"]')).toBeVisible();
});
