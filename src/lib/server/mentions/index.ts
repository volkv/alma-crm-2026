/**
 * Упоминания в комментариях: кого можно позвать, постановка вместе с
 * комментарием и колокольчик сотрудника.
 *
 * Правило одно на все три места: **позвать в обсуждение можно только того,
 * кто видит дело**, и это проверяется от лица адресата тем же условием, по
 * которому ему открывается карточка (`live/viewers.ts`). Подсказка в браузере
 * показывает тот же список, но ей не доверяют: сервер достаёт адресатов из
 * текста сам и проверяет каждого при сохранении, а цикл доставки — ещё раз
 * перед отправкой письма (`notifications/mention.ts`): доступ мог пропасть
 * между комментарием и письмом.
 *
 * Членство в пространстве этим правилом не является: коллега по пространству
 * с другими вузами дела не видит, а администратор видит его и без членства.
 */
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import {
	MAX_MENTIONS_PER_COMMENT,
	mentionedUserIds,
	type MarkMentionsReadInput,
	type MentionInbox
} from '$lib/contracts/mentions';
import { NOTIFICATION_CHANNELS } from '$lib/contracts/notifications';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import {
	commentMentions,
	comments,
	interactions,
	notificationDeliveries,
	users,
	workspaces
} from '../db/schema';
import type { Tx } from '../db/transaction';
import { ForbiddenError, ValidationError } from '../errors';
import { interactionScopeFilter } from '../interactions/access';
import { canUserSeeInteraction } from '../live/viewers';
import { getConfig } from '../config';
import { mentionNotificationMessage } from '../notifications/message';
import { can } from '../rbac';
import { getSetting } from '../settings';

/** Сколько упоминаний показывает колокольчик. */
const INBOX_LIMIT = 15;

/**
 * Адресаты упоминаний из текста комментария, проверенные от их лица.
 *
 * Себя упомянуть можно — это просто текст, звать себя незачем, и такое
 * упоминание уведомления не даёт. Адресат, который дела не видит (чужой,
 * выключенный, несуществующий идентификатор), отклоняет комментарий целиком с
 * его подписью в тексте: молча выбросить упоминание значило бы оставить автора
 * уверенным, что коллегу позвали.
 */
export async function checkMentions(
	interactionId: string,
	body: string,
	authorId: string
): Promise<string[]> {
	const mentioned = mentionedUserIds(body).filter((mention) => mention.userId !== authorId);

	if (mentioned.length > MAX_MENTIONS_PER_COMMENT) {
		throw new ValidationError(
			`В одном комментарии можно упомянуть не больше ${MAX_MENTIONS_PER_COMMENT} сотрудников`
		);
	}

	const verdicts = await Promise.all(
		mentioned.map(async (mention) => ({
			...mention,
			sees: await canUserSeeInteraction(mention.userId, interactionId)
		}))
	);
	const blind = verdicts.filter((verdict) => !verdict.sees);

	if (blind.length > 0) {
		const names = blind.map((verdict) => `«${verdict.label}»`).join(', ');

		throw new ValidationError(
			`Упомянуть можно только сотрудника, который видит это дело. Не видят его: ${names}`,
			blind.map((verdict) => `${verdict.label}: нет доступа к делу`)
		);
	}

	return mentioned.map((mention) => mention.userId);
}

/**
 * Записать упоминания и поставить письма в очередь — той же транзакцией, что
 * и комментарий: откатится комментарий — не останется ни упоминаний, ни
 * писем о нём. Отправляет письма фоновый цикл уведомлений после фиксации
 * (`notifications/mention.ts`): почтовый сервер отвечает до пяти секунд, и
 * держать на нём транзакцию с блокировкой дела нельзя.
 *
 * Письма ставятся по каналам, включённым в момент комментария.
 */
export async function queueMentions(
	tx: Tx,
	facts: { commentId: string; interactionId: string; userIds: readonly string[] }
): Promise<number> {
	if (facts.userIds.length === 0) {
		return 0;
	}

	const created = await tx
		.insert(commentMentions)
		.values(
			facts.userIds.map((userId) => ({
				commentId: facts.commentId,
				interactionId: facts.interactionId,
				userId
			}))
		)
		.onConflictDoNothing({ target: [commentMentions.commentId, commentMentions.userId] })
		.returning({ id: commentMentions.id, userId: commentMentions.userId });

	const switches = await getSetting('notification_channels');
	const channels = NOTIFICATION_CHANNELS.filter((channel) => switches[channel]);
	const message = mentionNotificationMessage(
		{ interactionId: facts.interactionId },
		getConfig().ORIGIN
	);

	if (created.length > 0 && channels.length > 0) {
		await tx.insert(notificationDeliveries).values(
			created.flatMap((mention) =>
				channels.map((channel) => ({
					kind: 'mention' as const,
					interactionId: facts.interactionId,
					mentionId: mention.id,
					recipientUserId: mention.userId,
					channel,
					status: 'queued' as const,
					subject: message.subject,
					body: message.text,
					nextNotifyAt: sql`now()`
				}))
			)
		);
	}

	return created.length;
}

function inboxUser(ctx: ActorContext): string {
	if (ctx.user === null) {
		throw new ForbiddenError('Колокольчик есть только у сотрудника, вошедшего в систему');
	}

	return ctx.user.id;
}

/**
 * Колокольчик: свои упоминания, свежие сверху, и сколько непрочитанных.
 *
 * Считаются только упоминания в делах, которые сотрудник видит **сейчас**: ушёл
 * из пространства или потерял вуз — старые упоминания не ведут в карточку,
 * которая ответит «не найдено», и не выдают названий чужих дел.
 */
export async function listMentionInbox(ctx: ActorContext): Promise<MentionInbox> {
	const userId = inboxUser(ctx);

	if (!can(ctx, 'interactions.read')) {
		return { unread: 0, items: [] };
	}

	const db = getDb();
	const visible = and(eq(commentMentions.userId, userId), interactionScopeFilter(ctx));

	const [[{ unread }], items] = await Promise.all([
		db
			.select({ unread: count() })
			.from(commentMentions)
			.innerJoin(interactions, eq(interactions.id, commentMentions.interactionId))
			.where(and(visible, isNull(commentMentions.readAt))),
		db
			.select({
				id: commentMentions.id,
				commentId: commentMentions.commentId,
				interactionId: commentMentions.interactionId,
				workspaceKey: workspaces.key,
				interactionTitle: interactions.title,
				authorName: users.fullName,
				createdAt: commentMentions.createdAt,
				readAt: commentMentions.readAt
			})
			.from(commentMentions)
			.innerJoin(interactions, eq(interactions.id, commentMentions.interactionId))
			.innerJoin(workspaces, eq(workspaces.id, interactions.workspaceId))
			.innerJoin(comments, eq(comments.id, commentMentions.commentId))
			.innerJoin(users, eq(users.id, comments.authorId))
			.where(visible)
			.orderBy(desc(commentMentions.createdAt))
			.limit(INBOX_LIMIT)
	]);

	return { unread, items };
}

/**
 * Отметить прочитанным. Трогает только свои упоминания: чужой идентификатор
 * просто ничего не находит, и ответ не выдаёт, существует ли он.
 */
export async function markMentionsRead(
	ctx: ActorContext,
	input: MarkMentionsReadInput
): Promise<number> {
	const userId = inboxUser(ctx);
	const conditions = [eq(commentMentions.userId, userId), isNull(commentMentions.readAt)];

	if (input.scope === 'mention') {
		conditions.push(eq(commentMentions.id, input.mentionId));
	} else if (input.scope === 'interaction') {
		conditions.push(eq(commentMentions.interactionId, input.interactionId));
	}

	const marked = await getDb()
		.update(commentMentions)
		.set({ readAt: sql`now()`, updatedAt: sql`now()` })
		.where(and(...conditions))
		.returning({ id: commentMentions.id });

	return marked.length;
}
