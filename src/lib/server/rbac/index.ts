/**
 * Проверка прав и области доступа.
 *
 * Право — про действие («можно ли вообще»), область — про строки («какие
 * организации видно»). Оба вопроса решаются здесь и нигде больше: сервис
 * вызывает `requirePermission` и подмешивает `scopeFilter` в условие выборки.
 *
 * Отказ, о котором должен узнать администратор, записывается в журнал здесь же:
 * у `requirePermission` есть форма с описанием события, и другой формы «проверил
 * право и отметил отказ» в приложении нет.
 */
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { AuditEventType } from '$lib/contracts/audit';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getDb } from '../db';
import { organizationResponsibles, rolePermissions } from '../db/schema';
import { ForbiddenError } from '../errors';
import { PERMISSION_KEYS, type PermissionKey } from './permissions';

/**
 * Может ли действующее лицо выполнить действие.
 *
 * Фоновые задачи (`source: 'system'`) проходят любую проверку: у них нет
 * пользователя, а запускает их код, который уже принял решение. Контекст с
 * таким источником собирается только в `systemActor()` и никогда из запроса.
 */
export function can(ctx: ActorContext, key: PermissionKey): boolean {
	if (ctx.source === 'system') {
		return true;
	}

	return ctx.user?.permissions.has(key) ?? false;
}

/**
 * Чем отказ должен отметиться в журнале: видом события и, если есть, записью,
 * над которой действовали.
 */
export type PermissionDenial = {
	type: AuditEventType;
	subject?: { type: string; id: string };
};

/** То же самое, но отказ — это ошибка, а не `false`. */
export function requirePermission(ctx: ActorContext, key: PermissionKey): void;
/**
 * Проверка с отметкой в журнале: попытка сделать то, на что нет права, —
 * это то, о чём администратор должен узнать, а не молчаливая ошибка в ответе.
 * Отсюда и вторая форма: со `denial` функция асинхронная, потому что перед
 * тем, как бросить ошибку, она дописывает событие.
 */
export function requirePermission(
	ctx: ActorContext,
	key: PermissionKey,
	denial: PermissionDenial
): Promise<void>;
export function requirePermission(
	ctx: ActorContext,
	key: PermissionKey,
	denial?: PermissionDenial
): void | Promise<void> {
	if (denial !== undefined) {
		return denyWithRecord(ctx, key, denial);
	}

	if (!can(ctx, key)) {
		throw forbidden(key);
	}
}

function forbidden(key: PermissionKey): ForbiddenError {
	return new ForbiddenError(`Недостаточно прав: требуется «${key}»`);
}

/**
 * Запись об отказе идёт отдельным соединением: транзакции вокруг проверки ещё
 * нет, а начинать её ради одной строки незачем — и откат того, что не
 * случилось, не должен унести с собой след попытки.
 */
async function denyWithRecord(
	ctx: ActorContext,
	key: PermissionKey,
	denial: PermissionDenial
): Promise<void> {
	if (can(ctx, key)) {
		return;
	}

	await recordAuditEvent(ctx, {
		type: denial.type,
		outcome: 'denied',
		subject: denial.subject
	});

	throw forbidden(key);
}

/**
 * Права роли из базы. Кэш на процесс: набор меняется редко, а читается на
 * каждый вход в систему. После правки ролей вызывают `invalidateRoleCache()`.
 */
const roleCache = new Map<string, ReadonlySet<PermissionKey>>();

const knownPermissions = new Set<string>(PERMISSION_KEYS);

export async function loadRolePermissions(roleId: string): Promise<ReadonlySet<PermissionKey>> {
	const cached = roleCache.get(roleId);
	if (cached !== undefined) {
		return cached;
	}

	const rows = await getDb()
		.select({ key: rolePermissions.permissionKey })
		.from(rolePermissions)
		.where(eq(rolePermissions.roleId, roleId));

	// Право, которого больше нет в каталоге, ничего не разрешает: набор кодов
	// сужается вместе с кодом, а не вместе с содержимым базы.
	const granted = new Set<PermissionKey>();
	for (const row of rows) {
		if (knownPermissions.has(row.key)) {
			granted.add(row.key as PermissionKey);
		}
	}

	roleCache.set(roleId, granted);
	return granted;
}

/**
 * Права, которых не получает публичная демонстрация, какой бы ролью ни вошли.
 *
 * Стенд показывают целиком: под демонстрационными записями проходится весь
 * процесс, правка процесса, обмен, настройка обмена, управление учётными
 * записями, выпуск ключей и обезличивание. Раздел, закрытый от посетителя,
 * читается им как раздел, которого в продукте нет, — и это ровно тот вывод,
 * который стенд делать не должен.
 *
 * Держится это не на доверии к посетителю, а на том, что стенд возвращается к
 * эталону раз в сутки (`$lib/server/demo/schedule`) и сброс теперь доводит до
 * эталона именно те строки, которые перечисленные права правят
 * (`$lib/server/demo/reset`):
 *
 * - `users.manage` — выключенная или перевешенная на другого руководителя
 *   учётная запись возвращается сидом (`scripts/seed/users.ts`), а
 *   демонстрационную выключить нельзя и так (`$lib/server/auth/users.ts`);
 * - `api_keys.manage` — выпущенный посетителем ключ уезжает вместе с таблицей
 *   `api_keys`, а два ключа обмена сид выпускает заново;
 * - `people.anonymize` — необратимо внутри показа, но `people` заливается
 *   сидом заново, то есть до следующего сброса, а не насовсем.
 *
 * Не открыт один `integrations.manage_endpoints` — и не потому, что адрес
 * опасен сам по себе: куда система ходит, проверяет `outboundAddressIssue`
 * (`$lib/server/integrations/outbound.ts`), и проверяет дважды, при сохранении
 * и в момент отправки. Дело в том, что под этим правом лежат адреса и токены
 * подключений, а живут они в `app_settings` — таблице, которую сброс не чистит
 * и чистить не может: там же настройки самого стенда. Подменённый посетителем
 * приёмник подписки и адрес с токеном системы обучения остались бы подменены и
 * после показа, то есть это единственное здесь, чего сброс не отменяет.
 * Открыть право можно вместе со сбросом ключей интеграций до эталона — до тех
 * пор оно остаётся вычтенным.
 *
 * Под оставшимся `integrations.manage` — то, что демонстрация показывает и что
 * кончается вместе с ней: журнал обмена, повтор и ручной разбор сообщения,
 * заход в систему обучения по кнопке, проверочное событие в уже заведённую
 * подписку, состояние подключений на экране.
 */
export const DEMO_DENIED_PERMISSIONS: readonly PermissionKey[] = ['integrations.manage_endpoints'];

/**
 * Права демонстрационной сессии: те же, что у её роли, минус перечисленные.
 *
 * Граница проходит по правам, а не по интерфейсу: `can()` читают и загрузчики
 * страниц, и сервисы, и публичный API, поэтому спрятанной кнопки достаточно
 * ровно настолько, насколько её достаточно от `curl`. Набор роли при этом
 * остаётся нетронутым — он общий и кэшируется на процесс.
 */
export function demoSessionPermissions(
	granted: ReadonlySet<PermissionKey>
): ReadonlySet<PermissionKey> {
	const allowed = new Set(granted);

	for (const key of DEMO_DENIED_PERMISSIONS) {
		allowed.delete(key);
	}

	return allowed;
}

/** Сбрасывает кэш прав. Зовут после любого изменения ролей. */
export function invalidateRoleCache(): void {
	roleCache.clear();
}

/**
 * Условие «эта организация в области доступа». Возвращает SQL, пригодный для
 * `and(...)`: при полном доступе — `true`, при пустой области — `false`.
 *
 * Аргумент — столбец с идентификатором организации: у самой организации это её
 * `id`, у площадки или аффилиации — `organization_id`.
 *
 * Организация видна, если у кого-то из людей области есть на неё **действующее**
 * назначение. Условие — подзапрос, а не список, посчитанный при входе: смена
 * ответственного обязана менять доступ немедленно, а не со следующего входа.
 * Отсюда и частичные индексы по `valid_to is null` в `docs/domain.md`.
 *
 * Организация-оператор и организации-вендоры под это условие не попадают
 * никогда: ответственного у них не бывает, и назначить его им нельзя.
 */
export function scopeFilter(ctx: ActorContext, organizationId: PgColumn): SQL {
	if (ctx.scope.kind === 'all') {
		return sql`true`;
	}

	const ids = [...ctx.scope.userIds];
	if (ids.length === 0) {
		return sql`false`;
	}

	return sql`exists (${getDb()
		.select({ one: sql`1` })
		.from(organizationResponsibles)
		.where(
			and(
				eq(organizationResponsibles.organizationId, organizationId),
				sql`${organizationResponsibles.userId} = any(${sql.param(ids)}::uuid[])`,
				isNull(organizationResponsibles.validTo)
			)
		)})`;
}

/**
 * Условие «эта запись принадлежит человеку из области»: владелец, исполнитель,
 * действующее лицо события журнала. Отдельно от `scopeFilter`, потому что
 * отвечает на другой вопрос — не «чей это вуз», а «чья это работа».
 *
 * Пустая область — `false`, как и у `scopeFilter`: ни одной строки.
 */
export function actorScopeFilter(ctx: ActorContext, userId: PgColumn): SQL {
	if (ctx.scope.kind === 'all') {
		return sql`true`;
	}

	const ids = [...ctx.scope.userIds];
	if (ids.length === 0) {
		return sql`false`;
	}

	return sql`${userId} = any(${sql.param(ids)}::uuid[])`;
}

/**
 * Отпечаток области для ключей кэша. Две разные области обязаны получить два
 * разных ключа, иначе руководитель однажды прочитает сводку менеджера.
 */
export function scopeFingerprint(ctx: ActorContext): string {
	return ctx.scope.kind === 'all' ? 'all' : [...ctx.scope.userIds].sort().join(',');
}
