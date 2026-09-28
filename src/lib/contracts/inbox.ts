/**
 * Колокольчик сотрудника: где его упомянули, какие новые дела с сайта ему
 * назначены и какие его письма вузу ушли не всем или не ушли.
 *
 * Три вида строк в одном списке, свежие сверху: колокольчик отвечает на вопрос
 * «что меня ждёт», а упоминание, новое дело и неотправленное письмо — ответы
 * на него. Схема — для браузера: ответ приезжает JSON, и даты в нём строками.
 */
import { z } from 'zod';
import { id } from './common';
import { OUTBOUND_MAIL_NOTICE_STATUSES } from './outbound-mail';

/** Общее у строк: куда ведёт и прочитана ли. */
const inboxItemFields = {
	id: z.uuid(),
	interactionId: z.uuid(),
	/** Пространство дела: ссылка на карточку живёт под ним. */
	workspaceKey: z.string(),
	interactionTitle: z.string(),
	createdAt: z.coerce.date(),
	readAt: z.coerce.date().nullable()
};

export const inboxSchema = z.object({
	unread: z.number().int().nonnegative(),
	items: z.array(
		z.discriminatedUnion('kind', [
			z.object({
				kind: z.literal('mention'),
				...inboxItemFields,
				commentId: z.uuid(),
				/** Кто упомянул — автор комментария. */
				authorName: z.string(),
				/**
				 * Начало комментария одной строкой: упоминания — именами, почта и
				 * телефоны скрыты. Колокольчик виден на любом экране, и чужие
				 * контакты с него не читаются.
				 */
				excerpt: z.string()
			}),
			z.object({
				/** Новое дело с сайта назначено этому сотруднику при приёме. */
				kind: z.literal('application'),
				...inboxItemFields
			}),
			z.object({
				/**
				 * Письмо вузу, которое этот сотрудник отправил из карточки, ушло не
				 * всем или не ушло вовсе: письма уходят в фоне, и окна, которое
				 * сказало бы об этом, к тому времени уже нет.
				 */
				kind: z.literal('mail'),
				...inboxItemFields,
				/** Как письмо называется: «Описание программ», «Отмена встречи». */
				label: z.string(),
				status: z.enum(OUTBOUND_MAIL_NOTICE_STATUSES),
				sentCount: z.number().int().nonnegative(),
				failedCount: z.number().int().nonnegative(),
				/** Почему — словами; адреса почты в причине скрыты. */
				reason: z.string().nullable()
			})
		])
	)
});

export type Inbox = z.output<typeof inboxSchema>;
export type InboxItem = Inbox['items'][number];

/**
 * Что отметить прочитанным: одну строку (щелчок в колокольчике), всё по делу
 * (карточка открыта) или всё сразу.
 */
export const markInboxReadSchema = z.discriminatedUnion(
	'scope',
	[
		z.object({
			scope: z.literal('mention'),
			id: id('Некорректный идентификатор упоминания')
		}),
		z.object({
			scope: z.literal('application'),
			id: id('Некорректный идентификатор уведомления')
		}),
		z.object({
			scope: z.literal('mail'),
			id: id('Некорректный идентификатор уведомления о письме')
		}),
		z.object({
			scope: z.literal('interaction'),
			interactionId: id('Некорректный идентификатор взаимодействия')
		}),
		z.object({ scope: z.literal('all') })
	],
	{ error: 'Не указано, что отметить прочитанным' }
);

export type MarkInboxReadInput = z.output<typeof markInboxReadSchema>;
