/**
 * Проверка прав и области доступа.
 *
 * Право — про действие («можно ли вообще»), область — про строки («какие
 * организации видно»). Оба вопроса решаются здесь и нигде больше: сервис
 * вызывает `requirePermission` и подмешивает `scopeFilter` в условие выборки.
 */
import { eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import { rolePermissions } from '../db/schema';
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

/** То же самое, но отказ — это ошибка, а не `false`. */
export function requirePermission(ctx: ActorContext, key: PermissionKey): void {
	if (!can(ctx, key)) {
		throw new ForbiddenError(`Недостаточно прав: требуется «${key}»`);
	}
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
 * Демонстрация — это открытый стенд с общими учётными записями: тот, кто на
 * него зашёл, не сотрудник оператора и не должен уметь оставить после себя
 * ничего постоянного. Заведение учётной записи и выпуск ключа переживают
 * демонстрацию и дают доступ дальше неё; правка настроек и маршрутов меняет
 * стенд для всех следующих посетителей; выгрузка журнала уносит адреса и
 * клиентов тех, кто заходил до тебя. Всё остальное — чтение и работа с
 * синтетическими данными — остаётся: иначе показывать нечего.
 */
const DEMO_DENIED_PERMISSIONS: readonly PermissionKey[] = [
	'users.manage',
	'api_keys.manage',
	'settings.write',
	'audit.export',
	'stages.configure'
];

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
 * Условие «эта строка в области доступа». Возвращает SQL, пригодный для
 * `and(...)`: при полном доступе — `true`, при пустой области — `false`
 * (а не `in ()`, что синтаксически невозможно).
 *
 * Аргумент — столбец с идентификатором организации: у самой организации это её
 * `id`, у площадки или роли — `organization_id`.
 */
export function scopeFilter(ctx: ActorContext, organizationId: PgColumn): SQL {
	if (ctx.scope.kind === 'all') {
		return sql`true`;
	}

	const ids = [...ctx.scope.organizationIds];
	if (ids.length === 0) {
		return sql`false`;
	}

	return inArray(organizationId, ids);
}
