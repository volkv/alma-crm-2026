/**
 * Письмо «информация о программах» из карточки дела: что окно письма получает
 * от сервера и что присылает обратно.
 *
 * Адресов почты в контракте нет ни в одну сторону. Окно видит контакты стороны
 * так же, как диалог контактного лица, — именем и должностью, плюс можно ли
 * этому человеку написать и если нет, то почему. Присылает оно идентификаторы
 * ролей (`affiliations`), а адреса к ним подставляет сервер при отправке, по
 * действующему праву на контакты: адрес с экрана письмо не принимает вовсе.
 */
import { z } from 'zod';
import { id } from './common';

/**
 * Поле истории дела, которым отправка ложится в ленту карточки: значение —
 * готовая фраза без имён (`{ text, data }`, как у факта модуля).
 */
export const PROGRAM_OFFER_CHANGE_FIELD = 'program_offer';

/** Сколько получателей за одну отправку: письмо вузу, а не рассылка. */
export const PROGRAM_OFFER_MAX_RECIPIENTS = 20;

export const sendProgramOfferSchema = z.object({
	interactionId: id('Некорректный идентификатор взаимодействия'),
	/** Роли контактных лиц основной стороны; у тестового письма — чьё обращение показать. */
	recipientIds: z
		.array(id('Некорректный идентификатор получателя'))
		.max(PROGRAM_OFFER_MAX_RECIPIENTS, {
			error: `За раз — не больше ${PROGRAM_OFFER_MAX_RECIPIENTS} получателей`
		})
		.default([]),
	/** Тестовое письмо себе: в деле ничего не меняет, кроме журнала. */
	test: z.boolean().default(false)
});

export type SendProgramOfferInput = z.infer<typeof sendProgramOfferSchema>;

/** Контакт стороны в списке получателей. */
export type ProgramOfferRecipientView = {
	affiliationId: string;
	name: string;
	position: string;
	/** Контактное лицо дела: отмечено по умолчанию. */
	isCaseContact: boolean;
	/** Можно ли отметить; `false` — причина в `unavailableReason`. */
	available: boolean;
	unavailableReason: string | null;
};

export type ProgramOfferAttachmentView = {
	documentId: string;
	programName: string;
	fileName: string;
	sizeBytes: number;
};

export type ProgramOfferDraftView = {
	/** Кому можно написать: контакты основной стороны. */
	recipients: ProgramOfferRecipientView[];
	/**
	 * Почему список пуст или все недоступны — словами; `null` — список обычный.
	 * Без права видеть людей организации список пуст именно поэтому.
	 */
	recipientsNotice: string | null;
	subject: string;
	/** Письмо целиком, как его увидит получатель: окно показывает его в песочнице. */
	previewHtml: string;
	/** Чьё обращение в превью; `null` — «Здравствуйте!». */
	previewFor: string | null;
	programCount: number;
	attachments: ProgramOfferAttachmentView[];
	attachmentsBytes: number;
	attachmentsLimitBytes: number;
	/** Отправитель — текущий пользователь; на его адрес уходит тестовое письмо. */
	sender: { name: string; email: string };
	/** Политика почты установки: окно показывает её заранее, а не отказом после нажатия. */
	policy: { allowed: boolean; sandboxed: boolean; reason: string | null };
	/** Последняя отправка по делу; `null` — описание ещё не отправляли. */
	lastSent: { sentAt: string; recipientCount: number } | null;
};

/** Исход отправки. Отказ до соединения и неудача сервера различаются, как у почты. */
export type ProgramOfferOutcome =
	| {
			status: 'sent';
			test: boolean;
			sentCount: number;
			/** Кому не ушло, когда ушло не всем: роль и причина словами. */
			failed: { affiliationId: string; error: string }[];
	  }
	| { status: 'refused' | 'failed'; test: boolean; error: string };
