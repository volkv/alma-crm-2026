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
 *   и след в журнале оставить за записью, в которую уже никто не войдёт;
 * - **группы процесса остаются, а их редакции пересобираются заново.** Группы
 *   кладёт миграция, а не сид, и на них ссылаются взаимодействия. Редакции же
 *   принадлежат показу: эталонный набор взаимодействий сид проводит по стадиям
 *   живой редакции, и стенд, где стадию удалили правкой процесса, залить
 *   эталоном уже нельзя — сид упрётся в стадию, которой нет. Поэтому редакции,
 *   стадии, переходы, правила переноса и реестр ключей всех групп очищаются
 *   вместе с данными, а `ensureProcess` внутри сида заводит процесс заново;
 * - **журнал действий не трогается вовсе.** Он append-only на уровне базы
 *   (UPDATE и DELETE запрещает триггер), и запись о том, что стенд сбросили,
 *   ложится в него же — рядом с тем, что было до сброса.
 *
 * Действие существует только при `DEMO_MODE=true`. У заказчика те же данные —
 * не демонстрационные, и кнопка, стирающая их «до эталона», там означала бы
 * потерю работы.
 */
import { count, sql } from 'drizzle-orm';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getConfig } from '../config';
import { getDb } from '../db';
import {
	documents,
	interactions,
	organizations,
	processGroups,
	processRevisions,
	processStageKeys
} from '../db/schema';
import { withTransaction } from '../db/transaction';
import { removeStoredFiles } from '../documents/storage';
import { ConflictError } from '../errors';
import { requirePermission } from '../rbac';
import { getRedis } from '../redis';
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
 */
const DEMO_DATA_TABLES = [
	// Взаимодействия и их история
	'interactions',
	'interaction_parties',
	'interaction_party_sites',
	'interaction_programs',
	'interaction_products',
	'interaction_contract_items',
	'interaction_changes',
	'stage_entries',
	'stage_pauses',
	'blockers',
	'comments',
	// Документы
	'documents',
	'stage_entry_documents',
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
	'directions',
	'programs',
	'program_versions',
	'products',
	'product_directions',
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
	// Обмен с внешними системами
	'exchange_messages',
	'learning_groups',
	'learning_group_results'
] as const;

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

		// Процесс каждой группы — тоже демонстрационные данные: показ правит его
		// той же кнопкой, что и всё остальное. Порядок обязателен: указатель на
		// действующую редакцию снимается первым (внешний ключ группы запрещает
		// удалять редакцию, на которую она смотрит), записи стадий к этому
		// моменту уже опустошены `TRUNCATE` (их ключ на `stages` — `restrict`), а
		// стадии, переходы и правила переноса уезжают каскадом за редакциями.
		// Реестр ключей чистится явно: иначе ключ, заведённый или снятый на
		// показе, остался бы в группе архивным и редактор отказал бы завести
		// стадию под ним заново.
		await tx.update(processGroups).set({ activeRevisionId: null });
		await tx.delete(processRevisions);
		await tx.delete(processStageKeys);

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
export async function resetDemoData(ctx: ActorContext): Promise<DemoResetResult> {
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

		const result = await countDemoData();

		// Числами, а не словами: подробности события — это закрытый набор ссылок
		// и счётчиков, и «стенд сброшен» без чисел не отвечает на вопрос, к
		// какому набору его вернули.
		await recordAuditEvent(ctx, {
			type: 'settings.demo_reset',
			outcome: 'success',
			details: result
		});

		return result;
	} finally {
		await redis.eval(RELEASE_LOCK, 1, LOCK_KEY, token);
	}
}
