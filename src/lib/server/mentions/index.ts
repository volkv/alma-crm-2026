/**
 * Упоминания в комментариях: кого можно позвать и постановка вместе с
 * комментарием. Колокольчик сотрудника — `inbox/index.ts`.
 *
 * Правило одно на все места: **позвать в обсуждение можно только того,
 * кто видит дело**, и это проверяется от лица адресата тем же условием, по
 * которому ему открывается карточка (`live/viewers.ts`). Подсказка в браузере
 * показывает тот же список, но ей не доверяют: сервер достаёт адресатов из
 * текста сам и проверяет каждого при сохранении, а цикл доставки — ещё раз
 * перед отправкой письма (`notifications/inbox.ts`): доступ мог пропасть
 * между комментарием и письмом.
 *
 * Членство в пространстве этим правилом не является: коллега по пространству
 * с другими вузами дела не видит, а администратор видит его и без членства.
 */
import { sql } from 'drizzle-orm';
import { MAX_MENTIONS_PER_COMMENT, mentionedUserIds } from '$lib/contracts/mentions';
import { NOTIFICATION_CHANNELS } from '$lib/contracts/notifications';
import { commentMentions, notificationDeliveries } from '../db/schema';
import type { Tx } from '../db/transaction';
import { ValidationError } from '../errors';
import { canUserSeeInteraction } from '../live/viewers';
import { getConfig } from '../config';
import { mentionNotificationMessage } from '../notifications/message';
import { getSetting } from '../settings';

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
 * (`notifications/inbox.ts`): почтовый сервер отвечает до пяти секунд, и
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
