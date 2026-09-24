/**
 * Кому видно взаимодействие.
 *
 * Условие одно на всё приложение. Пересказывать его подзапросом по месту
 * нельзя: слагаемое «владелец» добавили бы в одном месте и забыли в другом, и
 * документы чужого взаимодействия остались бы видны, а свои — пропали.
 *
 * Записи вне области отдаются как «не найдено» — иначе перебором
 * идентификаторов можно узнать, что существует за её пределами.
 */
import { and, eq, exists, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import { interactionParties, interactions } from '../db/schema';
import { NotFoundError } from '../errors';
import { actorScopeFilter, scopeFilter, workspaceFilter } from '../rbac';

/**
 * Условие «это взаимодействие в области доступа». Коррелирует со столбцом
 * `interactions.id`, поэтому годится только для выборок из `interactions`.
 *
 * Видимость — это **пространство** и «или» из двух слагаемых области:
 *
 * 0. **пространство записи** — одно из пространств вызывающего. Это граница, а
 *    не слагаемое: вне своих пространств сотрудник не видит ничего, даже
 *    записи своих подчинённых и свои собственные, если его исключили;
 * 1. **владелец записи** в области. Взаимодействие остаётся у своего ведущего и
 *    после того, как ответственность за вуз ушла другому: иначе смена
 *    ответственного обрывала бы незавершённую работу на полуслове;
 * 2. **основная сторона** в области. Именно основная, а не любая: сторон у
 *    взаимодействия несколько (вуз, плательщик, организация-оператор), и если
 *    считать видимость по любой из них, достаточно назначить кому-нибудь
 *    организацию-оператора — и он немедленно увидит все взаимодействия продукта
 *    разом, потому что оператор стоит стороной почти везде.
 */
export function interactionScopeFilter(ctx: ActorContext): SQL {
	if (ctx.scope.kind === 'all') {
		// Полный доступ видит и взаимодействие, у которого сторон ещё нет;
		// подзапрос ниже такое взаимодействие отверг бы — сверять не с чем.
		return sql`true`;
	}

	// Взаимодействия, чья основная сторона в области, — один набор на запрос,
	// а не подзапрос на строку: условие стоит за «или», и коррелированный
	// подзапрос база повторяла бы на каждом взаимодействии пространства
	// (`docs/performance.md`, замер 2026-09-24).
	const byPrimaryParty = getDb()
		.select({ id: interactionParties.interactionId })
		.from(interactionParties)
		.where(
			and(
				eq(interactionParties.isPrimary, true),
				scopeFilter(ctx, interactionParties.organizationId)
			)
		);

	return sql`(${workspaceFilter(ctx, interactions.workspaceId)} and (${actorScopeFilter(ctx, interactions.ownerUserId)} or ${interactions.id} in (${byPrimaryParty})))`;
}

/**
 * Взаимодействие, которое вызывающему разрешено видеть, или `NotFoundError`.
 * Возвращает пространство: оно нужно почти всем, кто это проверяет.
 */
export async function assertInteractionVisible(
	ctx: ActorContext,
	interactionId: string
): Promise<{ id: string; workspaceId: string; ownerUserId: string; lastActivityAt: Date }> {
	const [row] = await getDb()
		.select({
			id: interactions.id,
			workspaceId: interactions.workspaceId,
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

/**
 * Условие «это взаимодействие в области» для выборок, которые идут **не** из
 * `interactions`: документов, контактов, отчётов по строкам-спутникам.
 *
 * Вызывающий передаёт свой столбец со ссылкой на взаимодействие, а условие
 * оборачивается в `exists` по самой таблице — так внутри снова работает
 * корреляция по `interactions.id`, на которую рассчитан
 * {@link interactionScopeFilter}.
 */
export function visibleInteractionFilter(ctx: ActorContext, interactionId: PgColumn): SQL {
	if (ctx.scope.kind === 'all') {
		return sql`true`;
	}

	return exists(
		getDb()
			.select({ one: sql`1` })
			.from(interactions)
			.where(and(eq(interactions.id, interactionId), interactionScopeFilter(ctx)))
	);
}

/**
 * Условие «эта организация видна вызывающему»: она в его области **или** она —
 * основная сторона взаимодействия, которое он видит.
 *
 * Второе слагаемое нужно тому, у кого вуз забрали, а незавершённое
 * взаимодействие осталось: карточка стороны, её площадки и контактные лица
 * этой записи обязаны остаться доступны. Иначе карточка открывается, а файл не
 * скачивается и правка отклоняется — доступ, который обрывается на зависимых
 * записях, доступом не является.
 *
 * Условие применяется к **карточкам**, а не к спискам: список вузов и
 * справочник людей от него не расширяются — туда идёт `scopeFilter`, то есть
 * только назначения.
 */
export function visibleOrganizationFilter(ctx: ActorContext, organizationId: PgColumn): SQL {
	if (ctx.scope.kind === 'all') {
		return sql`true`;
	}

	const asPrimaryParty = exists(
		getDb()
			.select({ one: sql`1` })
			.from(interactionParties)
			.innerJoin(interactions, eq(interactions.id, interactionParties.interactionId))
			.where(
				and(
					eq(interactionParties.organizationId, organizationId),
					eq(interactionParties.isPrimary, true),
					interactionScopeFilter(ctx)
				)
			)
	);

	return sql`(${scopeFilter(ctx, organizationId)} or ${asPrimaryParty})`;
}
