/**
 * Колокольчик сотрудника: где его упомянули и какие новые дела с сайта ему
 * назначены.
 *
 * Два вида строк в одном списке, свежие сверху: колокольчик отвечает на вопрос
 * «что меня ждёт», а упоминание и новое дело — два ответа на него. Схема — для
 * браузера: ответ приезжает JSON, и даты в нём строками.
 */
import { z } from 'zod';
import { id } from './common';

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
			scope: z.literal('interaction'),
			interactionId: id('Некорректный идентификатор взаимодействия')
		}),
		z.object({ scope: z.literal('all') })
	],
	{ error: 'Не указано, что отметить прочитанным' }
);

export type MarkInboxReadInput = z.output<typeof markInboxReadSchema>;
