/**
 * Колокольчик сотрудника: упоминания в комментариях, новые дела с сайта,
 * назначенные ему, и его письма вузу, которые ушли не всем или не ушли, —
 * одним списком, свежие сверху.
 *
 * Строка о письме — само задание очереди писем (`mail/queue.ts`): отдельной
 * таблицы уведомлений ему не нужно, у задания уже есть отправитель, дело,
 * исход и причина. Своего письма о неудаче нет: письмо уходит вузу, а не
 * сотруднику, и сказать ему «почта не работает» почтой было бы странно.
 *
 * Строки обоих видов ставятся той же транзакцией, что их причина: упоминание —
 * вместе с комментарием (`mentions/index.ts`), новое дело — вместе с приёмом
 * заявки или оплаты с сайта (`queueApplicationNotice` ниже). Письма по ним
 * отправляет фоновый цикл уведомлений после фиксации (`notifications/inbox.ts`):
 * почтовый сервер отвечает до пяти секунд, и держать на нём транзакцию приёма
 * нельзя.
 */
import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Inbox, InboxItem, MarkInboxReadInput } from '$lib/contracts/inbox';
import { mentionExcerpt } from '$lib/contracts/mentions';
import { NOTIFICATION_CHANNELS } from '$lib/contracts/notifications';
import {
	OUTBOUND_MAIL_NOTICE_STATUSES,
	type OutboundMailStatus
} from '$lib/contracts/outbound-mail';
import type { ActorContext } from '../actor';
import { getConfig } from '../config';
import { getDb } from '../db';
import {
	applicationNotices,
	commentMentions,
	comments,
	interactions,
	notificationDeliveries,
	outboundMailJobs,
	users,
	workspaces
} from '../db/schema';
import type { Tx } from '../db/transaction';
import { ForbiddenError } from '../errors';
import { interactionScopeFilter } from '../interactions/access';
import { applicationNotificationMessage } from '../notifications/message';
import { can } from '../rbac';
import { getSetting } from '../settings';

/** Сколько строк показывает колокольчик. */
const INBOX_LIMIT = 15;

/**
 * Уведомить ответственного о новом деле с сайта — той же транзакцией, что
 * заводит дело: откатится приём — не останется ни дела, ни уведомления.
 *
 * Одно уведомление на дело и адресата: повтор сообщения и новая ревизия
 * заявки второго не заводят (уникальность `application_notices`). Письма
 * ставятся по каналам, включённым в момент приёма, и уходят фоновым циклом.
 */
export async function queueApplicationNotice(
	tx: Tx,
	facts: { interactionId: string; userId: string }
): Promise<boolean> {
	const [created] = await tx
		.insert(applicationNotices)
		.values({ interactionId: facts.interactionId, userId: facts.userId })
		.onConflictDoNothing({
			target: [applicationNotices.interactionId, applicationNotices.userId]
		})
		.returning({ id: applicationNotices.id });

	if (created === undefined) {
		return false;
	}

	const switches = await getSetting('notification_channels');
	const channels = NOTIFICATION_CHANNELS.filter((channel) => switches[channel]);

	if (channels.length > 0) {
		const message = applicationNotificationMessage(
			{ interactionId: facts.interactionId },
			getConfig().ORIGIN
		);

		await tx.insert(notificationDeliveries).values(
			channels.map((channel) => ({
				kind: 'site_application' as const,
				interactionId: facts.interactionId,
				applicationNoticeId: created.id,
				recipientUserId: facts.userId,
				channel,
				status: 'queued' as const,
				subject: message.subject,
				body: message.text,
				nextNotifyAt: sql`now()`
			}))
		);
	}

	return true;
}

function inboxUser(ctx: ActorContext): string {
	if (ctx.user === null) {
		throw new ForbiddenError('Колокольчик есть только у сотрудника, вошедшего в систему');
	}

	return ctx.user.id;
}

/**
 * Колокольчик: свои упоминания и новые дела, свежие сверху, и сколько
 * непрочитанных.
 *
 * Считаются только строки по делам, которые сотрудник видит **сейчас**: ушёл
 * из пространства или потерял вуз — старые строки не ведут в карточку,
 * которая ответит «не найдено», и не выдают названий чужих дел.
 */
export async function listInbox(ctx: ActorContext): Promise<Inbox> {
	const userId = inboxUser(ctx);

	if (!can(ctx, 'interactions.read')) {
		return { unread: 0, items: [] };
	}

	const db = getDb();
	const scope = interactionScopeFilter(ctx);
	const mentionsVisible = and(eq(commentMentions.userId, userId), scope);
	const noticesVisible = and(eq(applicationNotices.userId, userId), scope);
	const mailVisible = and(
		eq(outboundMailJobs.senderUserId, userId),
		inArray(outboundMailJobs.status, [...OUTBOUND_MAIL_NOTICE_STATUSES]),
		scope
	);

	const [[mentionUnread], [noticeUnread], [mailUnread], mentionRows, noticeRows, mailRows] =
		await Promise.all([
			db
				.select({ value: count() })
				.from(commentMentions)
				.innerJoin(interactions, eq(interactions.id, commentMentions.interactionId))
				.where(and(mentionsVisible, isNull(commentMentions.readAt))),
			db
				.select({ value: count() })
				.from(applicationNotices)
				.innerJoin(interactions, eq(interactions.id, applicationNotices.interactionId))
				.where(and(noticesVisible, isNull(applicationNotices.readAt))),
			db
				.select({ value: count() })
				.from(outboundMailJobs)
				.innerJoin(interactions, eq(interactions.id, outboundMailJobs.interactionId))
				.where(and(mailVisible, isNull(outboundMailJobs.noticeReadAt))),
			db
				.select({
					id: commentMentions.id,
					commentId: commentMentions.commentId,
					interactionId: commentMentions.interactionId,
					workspaceKey: workspaces.key,
					interactionTitle: interactions.title,
					authorName: users.fullName,
					body: comments.body,
					createdAt: commentMentions.createdAt,
					readAt: commentMentions.readAt
				})
				.from(commentMentions)
				.innerJoin(interactions, eq(interactions.id, commentMentions.interactionId))
				.innerJoin(workspaces, eq(workspaces.id, interactions.workspaceId))
				.innerJoin(comments, eq(comments.id, commentMentions.commentId))
				.innerJoin(users, eq(users.id, comments.authorId))
				.where(mentionsVisible)
				.orderBy(desc(commentMentions.createdAt))
				.limit(INBOX_LIMIT),
			db
				.select({
					id: applicationNotices.id,
					interactionId: applicationNotices.interactionId,
					workspaceKey: workspaces.key,
					interactionTitle: interactions.title,
					createdAt: applicationNotices.createdAt,
					readAt: applicationNotices.readAt
				})
				.from(applicationNotices)
				.innerJoin(interactions, eq(interactions.id, applicationNotices.interactionId))
				.innerJoin(workspaces, eq(workspaces.id, interactions.workspaceId))
				.where(noticesVisible)
				.orderBy(desc(applicationNotices.createdAt))
				.limit(INBOX_LIMIT),
			db
				.select({
					id: outboundMailJobs.id,
					interactionId: outboundMailJobs.interactionId,
					workspaceKey: workspaces.key,
					interactionTitle: interactions.title,
					label: outboundMailJobs.label,
					status: outboundMailJobs.status,
					sentCount: outboundMailJobs.sentCount,
					failedCount: outboundMailJobs.failedCount,
					reason: outboundMailJobs.lastError,
					// Строка встаёт в список моментом исхода: неудача — новость тогда,
					// когда случилась, а не когда нажали «Отправить».
					createdAt: sql<Date>`coalesce(${outboundMailJobs.finishedAt}, ${outboundMailJobs.createdAt})`,
					readAt: outboundMailJobs.noticeReadAt
				})
				.from(outboundMailJobs)
				.innerJoin(interactions, eq(interactions.id, outboundMailJobs.interactionId))
				.innerJoin(workspaces, eq(workspaces.id, interactions.workspaceId))
				.where(mailVisible)
				.orderBy(desc(outboundMailJobs.createdAt))
				.limit(INBOX_LIMIT)
		]);

	const items: InboxItem[] = [
		...mentionRows.map(({ body, ...row }) => ({
			kind: 'mention' as const,
			...row,
			excerpt: mentionExcerpt(body)
		})),
		...noticeRows.map((row) => ({ kind: 'application' as const, ...row })),
		...mailRows.flatMap(({ status, createdAt, ...row }) =>
			isNoticeStatus(status)
				? [{ kind: 'mail' as const, ...row, status, createdAt: new Date(createdAt) }]
				: []
		)
	]
		.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
		.slice(0, INBOX_LIMIT);

	return { unread: mentionUnread.value + noticeUnread.value + mailUnread.value, items };
}

/**
 * Отметить прочитанным. Трогает только свои строки: чужой идентификатор
 * просто ничего не находит, и ответ не выдаёт, существует ли он.
 */
export async function markInboxRead(ctx: ActorContext, input: MarkInboxReadInput): Promise<number> {
	const userId = inboxUser(ctx);
	const db = getDb();

	const markMentions = async (): Promise<number> => {
		const conditions = [eq(commentMentions.userId, userId), isNull(commentMentions.readAt)];

		if (input.scope === 'mention') {
			conditions.push(eq(commentMentions.id, input.id));
		} else if (input.scope === 'interaction') {
			conditions.push(eq(commentMentions.interactionId, input.interactionId));
		}

		const marked = await db
			.update(commentMentions)
			.set({ readAt: sql`now()`, updatedAt: sql`now()` })
			.where(and(...conditions))
			.returning({ id: commentMentions.id });

		return marked.length;
	};

	const markNotices = async (): Promise<number> => {
		const conditions = [eq(applicationNotices.userId, userId), isNull(applicationNotices.readAt)];

		if (input.scope === 'application') {
			conditions.push(eq(applicationNotices.id, input.id));
		} else if (input.scope === 'interaction') {
			conditions.push(eq(applicationNotices.interactionId, input.interactionId));
		}

		const marked = await db
			.update(applicationNotices)
			.set({ readAt: sql`now()`, updatedAt: sql`now()` })
			.where(and(...conditions))
			.returning({ id: applicationNotices.id });

		return marked.length;
	};

	// Только законченные неудачи: отправка, которая ещё идёт, прочитанной не
	// становится оттого, что человек открыл карточку, — иначе неудача, случившаяся
	// минутой позже, пришла бы в колокольчик уже прочитанной.
	const markMail = async (): Promise<number> => {
		const conditions = [
			eq(outboundMailJobs.senderUserId, userId),
			inArray(outboundMailJobs.status, [...OUTBOUND_MAIL_NOTICE_STATUSES]),
			isNull(outboundMailJobs.noticeReadAt)
		];

		if (input.scope === 'mail') {
			conditions.push(eq(outboundMailJobs.id, input.id));
		} else if (input.scope === 'interaction') {
			conditions.push(eq(outboundMailJobs.interactionId, input.interactionId));
		}

		const marked = await db
			.update(outboundMailJobs)
			.set({ noticeReadAt: sql`now()`, updatedAt: sql`now()` })
			.where(and(...conditions))
			.returning({ id: outboundMailJobs.id });

		return marked.length;
	};

	if (input.scope === 'mention') {
		return markMentions();
	}

	if (input.scope === 'application') {
		return markNotices();
	}

	if (input.scope === 'mail') {
		return markMail();
	}

	const [mentions, notices, mail] = await Promise.all([markMentions(), markNotices(), markMail()]);

	return mentions + notices + mail;
}

function isNoticeStatus(
	status: OutboundMailStatus
): status is (typeof OUTBOUND_MAIL_NOTICE_STATUSES)[number] {
	return (OUTBOUND_MAIL_NOTICE_STATUSES as readonly OutboundMailStatus[]).includes(status);
}
