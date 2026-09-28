/**
 * Пакет документов вузу письмом из карточки дела: что окно отправки получает
 * от сервера и что присылает обратно.
 *
 * Как у описания программ (`program-offer.ts`), адресов почты в контракте нет
 * ни в одну сторону: окно видит контакты стороны именем и должностью и
 * присылает идентификаторы ролей, адреса к ним подставляет сервер. Файлы окно
 * тоже называет идентификаторами — сервер отправит только текущие редакции
 * документов пакета этого дела, а не любой документ, который назвали.
 */
import { z } from 'zod';
import { id } from './common';
import type { DocumentTemplateKey } from './documents';
import type { OutboundMailInFlightView } from './outbound-mail';

/**
 * Поле истории дела, которым отправка ложится в ленту карточки: значение —
 * готовая фраза без имён и идентификаторы того, что ушло (`{ text, data }`).
 */
export const PACKAGE_SEND_CHANGE_FIELD = 'document_package';

/** Сколько получателей за одну отправку: письмо вузу, а не рассылка. */
export const PACKAGE_SEND_MAX_RECIPIENTS = 20;

export const sendDocumentPackageSchema = z.object({
	interactionId: id('Некорректный идентификатор взаимодействия'),
	/** Роли контактных лиц основной стороны; у тестового письма — чьё обращение показать. */
	recipientIds: z
		.array(id('Некорректный идентификатор получателя'))
		.max(PACKAGE_SEND_MAX_RECIPIENTS, {
			error: `За раз — не больше ${PACKAGE_SEND_MAX_RECIPIENTS} получателей`
		})
		.default([]),
	/** Отмеченные в окне файлы пакета. */
	documentIds: z.array(id('Некорректный идентификатор документа')).max(20).default([]),
	/** Тестовое письмо себе: в деле ничего не меняет, кроме журнала. */
	test: z.boolean().default(false)
});

export type SendDocumentPackageInput = z.infer<typeof sendDocumentPackageSchema>;

/** Контакт стороны в списке получателей — как у описания программ. */
export type PackageSendRecipientView = {
	affiliationId: string;
	name: string;
	position: string;
	/** Контактное лицо дела: отмечено по умолчанию. */
	isCaseContact: boolean;
	/** Можно ли отметить; `false` — причина в `unavailableReason`. */
	available: boolean;
	unavailableReason: string | null;
};

/** Файл пакета: текущая редакция документа, собранного по шаблону, в PDF. */
export type PackageSendDocumentView = {
	documentId: string;
	templateKey: DocumentTemplateKey;
	title: string;
	fileName: string;
	sizeBytes: number;
	/** Когда собрана или загружена эта редакция. */
	createdAt: string;
	/** Редакция загружена руками поверх собранной (скан подписанного). */
	uploaded: boolean;
};

export type PackageSendDraftView = {
	recipients: PackageSendRecipientView[];
	/** Почему список пуст или все недоступны — словами; `null` — список обычный. */
	recipientsNotice: string | null;
	/** Файлы пакета; пусто — пакет ещё не собирали. */
	documents: PackageSendDocumentView[];
	subject: string;
	/** Письмо целиком со всеми файлами пакета: окно показывает его в песочнице. */
	previewHtml: string;
	/** Чьё обращение в превью; `null` — «Здравствуйте!». */
	previewFor: string | null;
	attachmentsLimitBytes: number;
	/** Отправитель — текущий пользователь; на его адрес уходит тестовое письмо. */
	sender: { name: string; email: string };
	/** Политика почты установки: окно показывает её заранее, а не отказом после нажатия. */
	policy: { allowed: boolean; sandboxed: boolean; reason: string | null };
	/** Последняя отправка пакета по делу; `null` — ещё не отправляли. */
	lastSent: { sentAt: string; recipientCount: number; documentCount: number } | null;
	/** Отправка пакета, которая ещё идёт в фоне; `null` — ничего не ждёт. */
	inFlight: OutboundMailInFlightView;
};

/**
 * Исход нажатия. Письма уходят в фоне (`mail/queue.ts`): `queued` — задание
 * поставлено; когда письма уйдут, в ленте появится запись, а пункт «Пакет
 * отправлен» открытой стадии отметится сам (у дела на другой стадии или без
 * права менять чек-лист пункт остаётся как был). Неудачу отправитель увидит в
 * колокольчике. `refused` — почта установки закрыта, ставить нечего.
 */
export type PackageSendOutcome =
	{ status: 'queued'; test: boolean } | { status: 'refused'; test: boolean; error: string };
