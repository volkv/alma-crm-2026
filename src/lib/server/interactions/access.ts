/**
 * Кому видно взаимодействие.
 *
 * Взаимодействие привязано не к одной организации, а к сторонам процесса,
 * поэтому область доступа работает через них: запись видна тому, в чью область
 * попала хотя бы одна из сторон. Записи вне области отдаются как «не найдено» —
 * иначе перебором идентификаторов можно узнать, что существует за её пределами.
 */
import { and, eq, exists, sql, type SQL } from 'drizzle-orm';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import { interactionParties, interactions } from '../db/schema';
import { NotFoundError } from '../errors';
import { scopeFilter } from '../rbac';

/**
 * Условие «это взаимодействие в области доступа». Коррелирует со столбцом
 * `interactions.id`, поэтому годится только для выборок из `interactions`.
 */
export function interactionScopeFilter(ctx: ActorContext): SQL {
	if (ctx.scope.kind === 'all') {
		// Полный доступ видит и взаимодействие, у которого сторон ещё нет;
		// подзапрос ниже такое взаимодействие отверг бы — сверять не с чем.
		return sql`true`;
	}

	return exists(
		getDb()
			.select({ one: sql`1` })
			.from(interactionParties)
			.where(
				and(
					eq(interactionParties.interactionId, interactions.id),
					scopeFilter(ctx, interactionParties.organizationId)
				)
			)
	);
}

/**
 * Взаимодействие, которое вызывающему разрешено видеть, или `NotFoundError`.
 * Возвращает идентификатор маршрута: он нужен почти всем, кто это проверяет.
 */
export async function assertInteractionVisible(
	ctx: ActorContext,
	interactionId: string
): Promise<{ id: string; routeId: string; ownerUserId: string; lastActivityAt: Date }> {
	const [row] = await getDb()
		.select({
			id: interactions.id,
			routeId: interactions.routeId,
			ownerUserId: interactions.ownerUserId,
			lastActivityAt: interactions.lastActivityAt
		})
		.from(interactions)
		.where(and(eq(interactions.id, interactionId), interactionScopeFilter(ctx)))
		.limit(1);

	if (row === undefined) {
		throw new NotFoundError('Взаимодействие не найдено');
	}

	return row;
}
