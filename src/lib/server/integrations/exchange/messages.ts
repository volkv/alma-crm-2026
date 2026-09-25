/**
 * Журнал обмена: чтение для экрана «Внешние системы» и два действия сотрудника.
 *
 * Журнал лежит в PostgreSQL, а не в Redis, в отличие от очереди вебхуков.
 * Критерий один: состояние интеграции живёт в Redis, пока за ним нет истории, за
 * которую кто-то отвечает. Здесь она есть — сотрудник спрашивает «ушла ли
 * группа в LMS и что ответили», ссылка на сообщение стоит в карточке
 * взаимодействия, и перезапуск она обязана переживать.
 *
 * Кроме сообщений четырёх направлений, здесь же лежат записи загруженной
 * выгрузки оплат с сайта (`payment.confirmed`, `payments.ts`): входящие строки
 * с ключом `payment:<номер заявки>`. Повтора у них, как у всякого входящего,
 * нет — упавшую запись применяет повторная загрузка файла.
 */
import { and, desc, eq, inArray, like, or, sql, type SQL } from 'drizzle-orm';
import {
	RETRIABLE_STATES,
	type DismissMessageInput,
	type ExchangeMessageView,
	type ExchangeQuery
} from '$lib/contracts/exchange';
import type { PageResult } from '$lib/contracts/common';
import type { ActorContext } from '../../actor';
import { recordAuditEvent } from '../../audit';
import { getDb } from '../../db';
import { exchangeMessages, interactions } from '../../db/schema';
import { ConflictError, NotFoundError } from '../../errors';
import { requirePermission } from '../../rbac';
import { deliverMessage } from './delivery';

/** Строка поиска ищет по ключу объекта и по идентификатору события. */
function searchCondition(query: string): SQL {
	const pattern = `%${query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;

	return or(
		like(exchangeMessages.externalId, pattern),
		like(exchangeMessages.eventId, pattern)
	) as SQL;
}

function filterConditions(filter: ExchangeQuery): SQL[] {
	const conditions: SQL[] = [];

	if (filter.direction !== null) {
		conditions.push(eq(exchangeMessages.direction, filter.direction));
	}

	if (filter.system !== null) {
		conditions.push(eq(exchangeMessages.system, filter.system));
	}

	if (filter.state !== null) {
		conditions.push(eq(exchangeMessages.state, filter.state));
	}

	if (filter.q !== null) {
		conditions.push(searchCondition(filter.q));
	}

	return conditions;
}

/**
 * Журнал обмена страницей. Область доступа здесь не применяется: это
 * техническая хроника обмена, а не работа по вузу, и право на неё — общее
 * `integrations.manage` (`docs/access-matrix.md`, раздел 4).
 */
export async function listExchangeMessages(
	ctx: ActorContext,
	filter: ExchangeQuery
): Promise<PageResult<ExchangeMessageView>> {
	requirePermission(ctx, 'integrations.manage');

	const db = getDb();
	const conditions = filterConditions(filter);
	const where = conditions.length === 0 ? undefined : and(...conditions);

	const [{ total }] = await db
		.select({ total: sql<number>`count(*)::int` })
		.from(exchangeMessages)
		.where(where);

	const rows = await db
		.select({
			id: exchangeMessages.id,
			direction: exchangeMessages.direction,
			system: exchangeMessages.system,
			instance: exchangeMessages.instance,
			eventType: exchangeMessages.eventType,
			eventId: exchangeMessages.eventId,
			externalId: exchangeMessages.externalId,
			interactionId: exchangeMessages.interactionId,
			interactionTitle: interactions.title,
			state: exchangeMessages.state,
			attempt: exchangeMessages.attempt,
			nextAttemptAt: exchangeMessages.nextAttemptAt,
			responseStatus: exchangeMessages.responseStatus,
			lastError: exchangeMessages.lastError,
			createdAt: exchangeMessages.createdAt,
			closedAt: exchangeMessages.closedAt
		})
		.from(exchangeMessages)
		.leftJoin(interactions, eq(interactions.id, exchangeMessages.interactionId))
		.where(where)
		.orderBy(desc(exchangeMessages.createdAt))
		.limit(filter.pageSize)
		.offset((filter.page - 1) * filter.pageSize);

	return { items: rows, total, page: filter.page, pageSize: filter.pageSize };
}

/**
 * Повторить доставку.
 *
 * Сообщение встаёт в очередь на ближайший проход **с тем же `eventId`**: дубля
 * не будет, потому что получатель узнаёт сообщение именно по нему. Отдельного
 * события журнала у нажатия нет — след оставляет сама попытка
 * (`exchange.message_sent` или `exchange.message_failed` от имени нажавшего).
 */
export async function retryExchangeMessage(
	ctx: ActorContext,
	messageId: string
): Promise<{ ok: boolean; error: string | null }> {
	requirePermission(ctx, 'integrations.manage');

	const [row] = await getDb()
		.update(exchangeMessages)
		.set({ state: 'pending', nextAttemptAt: sql`now()`, closedAt: null })
		.where(
			and(
				eq(exchangeMessages.id, messageId),
				eq(exchangeMessages.direction, 'outbound'),
				inArray(exchangeMessages.state, [...RETRIABLE_STATES])
			)
		)
		.returning({ id: exchangeMessages.id });

	if (row === undefined) {
		throw new ConflictError(
			'Повторить можно только исходящее сообщение, которое не доставлено или ждёт повтора'
		);
	}

	const attempt = await deliverMessage(ctx, row.id);

	return { ok: attempt?.ok ?? false, error: attempt?.error ?? null };
}

/**
 * Пометить сообщение разобранным вручную.
 *
 * Это признание «разобрано мимо системы», а не тихое удаление, поэтому причина
 * обязательна и остаётся в строке журнала обмена рядом с последней ошибкой: в
 * подробностях события журнала действий свободному тексту места нет
 * (`validateAuditDetails`).
 */
export async function dismissExchangeMessage(
	ctx: ActorContext,
	input: DismissMessageInput
): Promise<void> {
	await requirePermission(ctx, 'integrations.manage', { type: 'exchange.message_dismissed' });

	const [row] = await getDb()
		.update(exchangeMessages)
		.set({
			state: 'dismissed',
			closedAt: sql`now()`,
			nextAttemptAt: null,
			lastError: sql`coalesce(${exchangeMessages.lastError} || ' — ', '') || ${`разобрано вручную: ${input.reason}`}`
		})
		.where(and(eq(exchangeMessages.id, input.messageId), eq(exchangeMessages.state, 'failed')))
		.returning({ id: exchangeMessages.id, interactionId: exchangeMessages.interactionId });

	if (row === undefined) {
		throw new NotFoundError('Недоставленного сообщения с таким идентификатором нет');
	}

	await recordAuditEvent(ctx, {
		type: 'exchange.message_dismissed',
		outcome: 'success',
		...(row.interactionId === null
			? {}
			: { subject: { type: 'interaction', id: row.interactionId } }),
		details: { exchangeMessageId: row.id }
	});
}
