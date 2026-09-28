/**
 * Сброс демонстрационных данных: стенд возвращается к тому, каким его залил
 * сид.
 *
 * Зачем это действие вообще есть. Публичный стенд показывают по многу раз, и
 * каждый показ оставляет след: пройденные стадии, комментарии, загруженные
 * файлы, переименованные вузы. Через день данные перестают быть тем набором, по
 * которому написан сценарий демонстрации, а поднимать базу заново ради этого
 * нельзя — вместе с ней уедут учётные записи, роли и журнал.
 *
 * Поэтому сброс устроен как «стереть данные и залить их заново тем же сидом», а
 * не как «пересоздать базу»:
 *
 * - **каталог прав, роли и пользователи остаются.** Учётная запись связана с
 *   каталогом Keycloak (`external_subject`), и стереть её значило бы при
 *   следующем входе завести человеку двойника, а его прежние ключи, назначения
 *   и след в журнале оставить за записью, в которую уже никто не войдёт. А то,
 *   что на них правит показ, — выключение и подчинение, — сид возвращает к
 *   эталону (`restoreSeededAccounts` в `scripts/seed/users.ts`);
 * - **пространства остаются, а их редакции пересобираются заново.**
 *   Пространства кладёт миграция, а не сид, и на них ссылаются взаимодействия.
 *   Редакции же принадлежат показу: эталонный набор взаимодействий сид проводит
 *   по стадиям живой редакции, и стенд, где стадию удалили правкой процесса,
 *   залить эталоном уже нельзя — сид упрётся в стадию, которой нет. Поэтому
 *   редакции, стадии, переходы, правила переноса и реестр ключей всех
 *   пространств очищаются вместе с данными, а `ensureProcess` внутри сида
 *   заводит процесс заново. Имена эталонных пространств, их модули и состав
 *   карточки эталонных процессов живут вне редакций и возвращаются к эталону
 *   отдельно;
 * - **настройки делятся надвое.** То, что демонстрации открыто, стирается, и
 *   эталон кладёт сид; то, что задал штатный администратор стенда (адреса
 *   интеграций, расписание сброса, баннер входа), остаётся
 *   (`PRESERVED_SETTING_KEYS`);
 * - **журнал действий не трогается вовсе.** Он append-only на уровне базы
 *   (UPDATE и DELETE запрещает триггер), и запись о том, что стенд сбросили,
 *   ложится в него же — рядом с тем, что было до сброса.
 *
 * Действие существует только при `DEMO_MODE=true`. У заказчика те же данные —
 * не демонстрационные, и кнопка, стирающая их «до эталона», там означала бы
 * потерю работы.
 */
import { count, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { DocumentTemplateKey } from '$lib/contracts/documents';
import { INTEGRATION_SETTING_KEYS } from '$lib/contracts/integrations';
import type { CardPanel } from '$lib/contracts/process-card';
import type { ModuleKey } from '$lib/platform/registry';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getConfig } from '../config';
import { getDb } from '../db';
import {
	appSettings,
	documents,
	interactions,
	organizations,
	workflows,
	workspaceModules,
	workspaces,
	processRevisions,
	processStageKeys
} from '../db/schema';
import { withTransaction } from '../db/transaction';
import { removeStoredFiles } from '../documents/storage';
import { ConflictError } from '../errors';
import { restoreDemoMocks } from '../integrations/exchange/demo';
import { requirePermission } from '../rbac';
import { getRedis } from '../redis';
import { DEMO_LOCKED_SETTINGS } from '../settings';
import {
	B2B_WORKFLOW_KEY,
	B2B_WORKSPACE_KEY,
	B2C_WORKFLOW_KEY,
	B2C_WORKSPACE_KEY
} from '../stages/definitions';
import { invalidateStatsDashboard } from '../stats/dashboard';

/**
 * Таблицы демонстрационных данных — всё, что заливает сид, и всё, что
 * нарастает поверх него на показе.
 *
 * Порядок в списке значения не имеет: таблицы опустошаются одной командой
 * `TRUNCATE`, и внешние ключи внутри неё проверяются после. А вот полнота
 * списка имеет значение, и её проверяет сама PostgreSQL: `TRUNCATE` **без**
 * `CASCADE` отказывается работать, если на опустошаемую таблицу ссылается
 * таблица, которой в списке нет. `CASCADE` здесь был бы прямо опасен — он молча
 * дотянулся бы до всего, что ссылается на данные, включая то, что сброс обязан
 * сохранить.
 *
 * Отказ PostgreSQL здесь случается только на стенде, в момент нажатия кнопки,
 * поэтому ту же полноту заранее сверяет со схемой
 * `tests/unit/demo/reset-tables.test.ts`: новая таблица, которая ссылается на
 * данные показа, обязана попасть сюда.
 */
export const DEMO_DATA_TABLES = [
	// Взаимодействия и их история
	'interactions',
	'interaction_parties',
	'interaction_party_sites',
	'interaction_programs',
	'interaction_products',
	'interaction_contract_items',
	'interaction_changes',
	// Стоимость дела — условие самого дела и уходит вместе с ним.
	'interaction_terms',
	'stage_entries',
	'stage_pauses',
	'blockers',
	'comments',
	// Упоминания в комментариях показа: уходят вместе с комментариями, иначе
	// колокольчик звал бы в стёртые обсуждения.
	'comment_mentions',
	// Уведомления о новых делах с сайта: уходят вместе с делами.
	'application_notices',
	// Отправки описания программ вузу: след дела, уходит вместе с делами.
	'program_offer_sends',
	// Очередь писем вузу: задания и строки колокольчика о неушедших письмах
	// ссылаются на дела и уходят вместе с ними.
	'outbound_mail_jobs',
	// Документы
	'documents',
	'stage_entry_documents',
	'document_contract_items',
	// Материалы программ: связь уходит вместе с документами и программами.
	'program_documents',
	// Договоры
	'contracts',
	'contract_items',
	// Справочник
	'organizations',
	'sites',
	'people',
	'consents',
	'affiliations',
	'organization_responsibles',
	// Членство в пространствах: показ открывает раздел пользователей, и
	// исключённый посетителем демонстрационный менеджер не должен остаться
	// без своей доски до ручной правки. Эталонный состав заливает сид.
	'workspace_members',
	'directions',
	'programs',
	'program_versions',
	'products',
	'product_directions',
	// Контакты вендора по продуктам: ссылаются и на продукты, и на людей.
	'product_contacts',
	// Данные об обучении
	'stat_snapshots',
	'stat_rows',
	// Импорт каталога: сами загрузки и их строки. Ссылки строк на организации,
	// продукты и договоры — `set null`, но чистить их отдельно нельзя: загрузка
	// показа — это тоже след показа, и без неё карточка импорта осталась бы
	// ссылаться на справочник, которого больше нет.
	'directory_imports',
	'directory_import_rows',
	// Напоминания о зависших взаимодействиях: и сами доставки, и отметки
	// следующего напоминания. Без них сброшенный стенд помнил бы, что о стёртой
	// записи стадии уже написали, — а записи этой больше нет.
	'notification_deliveries',
	// Ключи доступа. Стенд отдаёт демонстрации их выпуск, а выпущенный ключ —
	// единственное, что она оставляет за собой работающим: он не привязан ни к
	// сессии, ни к записи посетителя и пускает в API стенда сам по себе.
	// Поэтому таблица чистится целиком, а два ключа обмена сид выпускает заново
	// из `EXCHANGE_API_KEY_CMS` и `EXCHANGE_API_KEY_LMS`
	// (`scripts/seed/api-keys.ts`) — и заодно снимает отзыв, если ключ стенда
	// на показе отозвали.
	'api_keys',
	// Обмен с внешними системами
	'exchange_messages',
	'learning_groups',
	'learning_group_products',
	'learning_group_results',
	'learning_group_learners'
] as const;

/**
 * Настройки, которые сброс сохраняет. Все остальные строки `app_settings`
 * стираются, и эталон заводит сид (`scripts/seed/settings.ts`), а чего сид не
 * заводит, то читается умолчанием (`SETTING_DEFAULTS`).
 *
 * Правило одно: сохраняется то, что демонстрационная сессия поменять не может, —
 * значит, это задал штатный администратор стенда, и эталона у этого нет:
 *
 * - адреса, токены и периодичность интеграций (`integrations.*`) — настоящие
 *   адреса стенда; демонстрации их право не выдаётся вовсе
 *   (`DEMO_DENIED_PERMISSIONS`);
 * - расписание сброса и баннер страницы входа — закрыты демонстрации поштучно
 *   (`DEMO_LOCKED_SETTINGS`). Верни их сброс к умолчанию, первый же ночной
 *   сброс выключил бы своё расписание.
 *
 * Всё прочее — порог зависания, каналы, сроки сессии, внешние источники —
 * демонстрации открыто, и сброс обязан это вернуть: иначе выключенные
 * посетителем напоминания так и остались бы выключенными для следующих.
 */
const PRESERVED_SETTING_KEYS: readonly string[] = [
	...Object.values(INTEGRATION_SETTING_KEYS),
	...Object.keys(DEMO_LOCKED_SETTINGS)
];

/**
 * Состав карточки эталонных процессов — тот, что задали им миграции
 * `drizzle/0025_process_card.sql`, `drizzle/0026_document_package.sql` и
 * `drizzle/0040_interaction_terms.sql` (договор у коммерческого обучения).
 *
 * Состав — свойство процесса, а не редакции, поэтому пересборка редакций его не
 * касается, а показ правит его редактором процесса. Процессы, заведённые
 * посетителем, сброс не трогает: эталона у них нет.
 */
const REFERENCE_CARDS: readonly {
	workflowKey: string;
	cardPanels: CardPanel[];
	documentTemplateKeys: DocumentTemplateKey[];
}[] = [
	{
		workflowKey: B2B_WORKFLOW_KEY,
		cardPanels: ['terms', 'contract', 'learning', 'documents'],
		documentTemplateKeys: ['agreement', 'sublicense', 'handover_act']
	},
	{
		workflowKey: B2C_WORKFLOW_KEY,
		cardPanels: [
			'terms',
			'payment',
			'contract',
			'learners',
			'learning',
			'training_document',
			'documents'
		],
		documentTemplateKeys: ['offer', 'legal_entity_contract', 'services_act']
	}
];

/**
 * Имена и описания эталонных пространств — те, что задали им миграции
 * `drizzle/0006_process_groups_backfill.sql` и
 * `drizzle/0022_workspace_process_names.sql`. Имя видно в меню и заголовке
 * доски, и переименованное посетителем пространство путало бы сценарий показа.
 */
const REFERENCE_WORKSPACES: readonly { key: string; name: string; description: string }[] = [
	{
		key: B2B_WORKSPACE_KEY,
		name: 'Работа с ВУЗ',
		description:
			'Полный цикл работы с вузом: от поиска контактов до контроля исполнения обязательств.'
	},
	{
		key: B2C_WORKSPACE_KEY,
		name: 'Коммерческое обучение',
		description: 'Обучение сотрудников заказчика и частных слушателей.'
	}
];

/**
 * Модули эталонных пространств — те, что включила им миграция
 * `drizzle/0038_workspace_modules.sql`. Показ включает и выключает модули в
 * настройках пространств, и стенд, где у вуза выключили «Встречи», расходился бы
 * со сценарием. Пространства, заведённые посетителем, сброс не трогает.
 */
const REFERENCE_MODULES: readonly { workspaceKey: string; modules: readonly ModuleKey[] }[] = [
	{ workspaceKey: B2B_WORKSPACE_KEY, modules: ['contracts', 'learning', 'meetings'] },
	{ workspaceKey: B2C_WORKSPACE_KEY, modules: ['contracts', 'payment', 'learning', 'meetings'] }
];

/**
 * Ключ блокировки сброса и её срок.
 *
 * Блокировка нужна потому, что сброс — это не одна транзакция и быть ею не
 * может: очистка фиксируется до заливки, а сид ведёт историю взаимодействий
 * движком стадий, и каждая его команда открывает собственную транзакцию. Два
 * сброса внахлёст означали бы, что второй опустошает базу посреди заливки
 * первого.
 *
 * Отсюда же и то, что блокировка живёт в Redis, а не в советующей блокировке
 * PostgreSQL: последняя действует, пока жива транзакция (`pg_advisory_xact_lock`)
 * или соединение (`pg_advisory_lock`), а сброс переживает и то, и другое.
 * Срок жизни ключа — потолок всей операции: процесс, упавший посреди сброса, не
 * должен запереть кнопку навсегда.
 */
const LOCK_KEY = 'lct:demo:reset';
const LOCK_TTL_SECONDS = 600;

/**
 * Снятие блокировки сравнением с меткой владельца: за время операции ключ мог
 * истечь и достаться другому вызову, и тогда снимать его нельзя. `EVAL` — чтобы
 * сравнение и удаление были одной командой.
 */
const RELEASE_LOCK = `
	if redis.call('get', KEYS[1]) == ARGV[1] then
		return redis.call('del', KEYS[1])
	end
	return 0
`;

/**
 * Чем сброс вызван: кнопкой администратора или расписанием стенда
 * (`./schedule.ts`). Уезжает в журнал подробностью события: «куда делась
 * запись, которую я вёл вчера» — вопрос, на который ответ «ночью стенд
 * сбросился сам» и «кто-то нажал кнопку» это разные ответы.
 */
export type DemoResetTrigger = 'manual' | 'schedule';

/** Сколько строк оказалось на стенде после сброса. */
export type DemoResetResult = {
	interactionCount: number;
	organizationCount: number;
	documentCount: number;
};

/**
 * Опустошает таблицы данных и отдаёт ключи файлов, на которые больше никто не
 * ссылается. Ключи читаются до `TRUNCATE` и в той же транзакции: после неё
 * узнать их будет неоткуда, а хранилище и база не фиксируются вместе.
 */
async function clearDemoData(ctx: ActorContext): Promise<string[]> {
	return withTransaction(ctx, async (tx) => {
		const files = await tx.select({ filePath: documents.filePath }).from(documents);

		await tx.execute(
			sql.raw(
				`truncate table ${DEMO_DATA_TABLES.map((table) => `"${table}"`).join(', ')} restart identity`
			)
		);

		// Процессы — тоже демонстрационные данные: показ правит их той же
		// кнопкой, что и всё остальное. Порядок обязателен: указатель на
		// действующую редакцию снимается первым (внешний ключ процесса запрещает
		// удалять редакцию, на которую он смотрит), записи стадий к этому моменту
		// уже опустошены `TRUNCATE` (их ключ на `stages` — `restrict`), а стадии,
		// переходы и правила переноса уезжают каскадом за редакциями. Реестр
		// ключей чистится явно: иначе ключ, заведённый или снятый на показе,
		// остался бы в процессе архивным и редактор отказал бы завести стадию под
		// ним заново. Назначение процесса пространству сброс переживает: место
		// работы — это устройство стенда, а не его данные.
		await tx.update(workflows).set({ activeRevisionId: null });
		await tx.delete(processRevisions);
		await tx.delete(processStageKeys);

		// Вид рабочего места и имена мест — то, что показ правит в обход
		// редакций, и что поэтому не уезжает вместе с ними.
		const at = new Date();

		for (const card of REFERENCE_CARDS) {
			await tx
				.update(workflows)
				.set({
					cardPanels: card.cardPanels,
					documentTemplateKeys: card.documentTemplateKeys,
					updatedAt: at
				})
				.where(eq(workflows.key, card.workflowKey));
		}

		for (const workspace of REFERENCE_WORKSPACES) {
			await tx
				.update(workspaces)
				.set({ name: workspace.name, description: workspace.description, updatedAt: at })
				.where(eq(workspaces.key, workspace.key));
		}

		// Модули эталонных пространств — удалить и включить заново: строки,
		// которых в эталоне нет, иначе пережили бы сброс.
		const referenceWorkspaces = await tx
			.select({ id: workspaces.id, key: workspaces.key })
			.from(workspaces)
			.where(
				inArray(
					workspaces.key,
					REFERENCE_MODULES.map((reference) => reference.workspaceKey)
				)
			);

		if (referenceWorkspaces.length > 0) {
			await tx.delete(workspaceModules).where(
				inArray(
					workspaceModules.workspaceId,
					referenceWorkspaces.map((workspace) => workspace.id)
				)
			);

			const rows = referenceWorkspaces.flatMap((workspace) =>
				(
					REFERENCE_MODULES.find((reference) => reference.workspaceKey === workspace.key)
						?.modules ?? []
				).map((moduleKey) => ({ workspaceId: workspace.id, moduleKey }))
			);

			if (rows.length > 0) {
				await tx.insert(workspaceModules).values(rows);
			}
		}

		// Настройки, которые правит показ, стираются, и эталон кладёт сид той же
		// заливкой. Не перезапись поверх: строки, которых в эталоне нет, иначе
		// пережили бы сброс.
		await tx.delete(appSettings).where(notInArray(appSettings.key, [...PRESERVED_SETTING_KEYS]));

		return files.map((file) => file.filePath);
	});
}

async function countDemoData(): Promise<DemoResetResult> {
	const db = getDb();

	const [[interactionRow], [organizationRow], [documentRow]] = await Promise.all([
		db.select({ value: count() }).from(interactions),
		db.select({ value: count() }).from(organizations),
		db.select({ value: count() }).from(documents)
	]);

	return {
		interactionCount: interactionRow.value,
		organizationCount: organizationRow.value,
		documentCount: documentRow.value
	};
}

/**
 * Возвращает стенд к эталонному набору сида.
 *
 * Порядок шагов выбран так, чтобы отказ на любом из них оставлял стенд в
 * рабочем состоянии, а не в пустом: сначала очистка и заливка, и только потом
 * уборка файлов, на которые уже никто не ссылается. Хранилище, не ответившее на
 * удаление, — это оставшийся мусор и ошибка наружу, а не стенд без данных.
 *
 * Данные и процесс очищаются одной транзакцией, а заводит процесс заново тот же
 * сид, что и всё остальное: разорвать эти два шага значило бы получить стенд
 * без процесса, на котором не открывается ни одна карточка.
 */
export async function resetDemoData(
	ctx: ActorContext,
	trigger: DemoResetTrigger = 'manual'
): Promise<DemoResetResult> {
	// Право проверяется первым и с отметкой в журнале: попытка стереть стенд без
	// права на это — ровно то, о чём администратор должен узнать.
	await requirePermission(ctx, 'settings.write', { type: 'settings.demo_reset' });

	if (!getConfig().DEMO_MODE) {
		throw new ConflictError(
			'Сброс демонстрационных данных доступен только на демонстрационном стенде (DEMO_MODE=true). Здесь данные принадлежат установке, и эталона, к которому их возвращать, нет'
		);
	}

	const redis = getRedis();
	const token = crypto.randomUUID();
	const acquired = await redis.set(LOCK_KEY, token, 'EX', LOCK_TTL_SECONDS, 'NX');

	if (acquired === null) {
		throw new ConflictError(
			'Сброс демонстрационных данных уже идёт. Дождитесь его окончания и обновите страницу'
		);
	}

	try {
		// Сид тянет за собой весь набор данных стенда и все его сервисы. Ветка
		// демонстрационного режима — единственное место продукта, которое его
		// зовёт, поэтому загружается он по месту: статический импорт утащил бы
		// набор в сборку страницы настроек, откуда кнопку и нажимают.
		const { seedAll } = await import('../../../../scripts/seed/run');

		const files = await clearDemoData(ctx);

		await seedAll();

		// Файлы стёртых документов: записей, которые на них ссылались, уже нет,
		// и найти эти объекты после сброса будет нечем.
		await removeStoredFiles(files);

		// Показатели дашборда собраны по снимкам, которых больше нет: собранное
		// до сброса читать нельзя.
		await invalidateStatsDashboard();

		// Отказ имитатора, оставленный прошлым показом, сбросу не принадлежит
		// данным, но стенду принадлежит: после сброса обмен обязан работать.
		// Недоступное управление имитатора сброс не отменяет — данные уже
		// залиты, а отказ снимется сам по сроку, — но и не проходит молча.
		for (const problem of await restoreDemoMocks()) {
			console.error('[demo] сброс не вернул имитатор в рабочий режим:', problem);
		}

		const result = await countDemoData();

		// Числами, а не словами: подробности события — это закрытый набор ссылок
		// и счётчиков, и «стенд сброшен» без чисел не отвечает на вопрос, к
		// какому набору его вернули. Рядом с числами — чем сброс вызван: с
		// системным актором в строке журнала это и есть «по расписанию».
		await recordAuditEvent(ctx, {
			type: 'settings.demo_reset',
			outcome: 'success',
			details: { ...result, mode: trigger }
		});

		return result;
	} finally {
		await redis.eval(RELEASE_LOCK, 1, LOCK_KEY, token);
	}
}
