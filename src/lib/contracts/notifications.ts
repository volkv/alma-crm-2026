/**
 * Уведомления о зависших взаимодействиях: виды, каналы, состояния доставки и
 * фильтр журнала.
 *
 * Уведомление — это не событие журнала действий и не сообщение обмена. Журнал
 * действий отвечает на вопрос «кто и что сделал», обмен — «что уехало чужой
 * системе», а здесь один вопрос: **дошло ли до человека то, что система решила
 * ему сказать**. Поэтому у доставки своё состояние, свой счётчик попыток и своя
 * последняя ошибка — как у сообщения обмена и по той же причине: за ними стоит
 * история, за которую кто-то отвечает.
 */
import { z } from 'zod';
import { pageQuerySchema } from './common';

/**
 * Виды уведомлений. Пока один: взаимодействие стоит на одной стадии дольше
 * порога. Вид входит в ключ дедупликации, поэтому второй вид по той же записи
 * стадии уедет своей строкой, а не перезапишет первую.
 */
export const NOTIFICATION_KINDS = ['stage_stuck'] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, string> = {
	stage_stuck: 'Зависшее взаимодействие'
};

/**
 * Каналы доставки. `email` отправляет по-настоящему; `telegram` и `max` —
 * **заглушки функционала**: интерфейс у них тот же, строка в журнале появляется,
 * а сообщение никуда не уходит. Слово «заглушка» стоит и в названии канала, и в
 * состоянии доставки: канал, который молча ничего не делает, хуже выключенного.
 */
export const NOTIFICATION_CHANNELS = ['email', 'telegram', 'max'] as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_CHANNEL_LABELS: Record<NotificationChannel, string> = {
	email: 'Почта',
	telegram: 'Telegram (заглушка)',
	max: 'MAX (заглушка)'
};

/** Каналы-заглушки: интерфейс тот же, отправки нет. */
export const STUB_CHANNELS: readonly NotificationChannel[] = ['telegram', 'max'];

export function isStubChannel(channel: NotificationChannel): boolean {
	return STUB_CHANNELS.includes(channel);
}

/**
 * Состояние доставки.
 *
 * `queued` — строка заведена, отправка ещё не состоялась; `sent` — ушло;
 * `failed` — не ушло и ждёт человека или следующей попытки; `skipped` —
 * получатель не определён (у ответственного не указан руководитель), и письма
 * не будет, пока иерархию не поправят; `stub` — канал-заглушка.
 */
export const NOTIFICATION_DELIVERY_STATUSES = [
	'queued',
	'sent',
	'failed',
	'skipped',
	'stub'
] as const;

export type NotificationDeliveryStatus = (typeof NOTIFICATION_DELIVERY_STATUSES)[number];

export const NOTIFICATION_STATUS_LABELS: Record<NotificationDeliveryStatus, string> = {
	queued: 'Ждёт отправки',
	sent: 'Отправлено',
	failed: 'Не отправлено',
	skipped: 'Получатель не определён',
	stub: 'Заглушка: реальная отправка не выполняется'
};

/** Из какого состояния доставку имеет смысл повторять кнопкой. */
export const RETRIABLE_DELIVERY_STATUSES: readonly NotificationDeliveryStatus[] = ['failed'];

/**
 * Включённость каналов — настройка приложения. Тип шире схемы намеренно:
 * `satisfies` ниже не даст завести канал и забыть про его выключатель.
 */
export type NotificationChannelSwitches = Record<NotificationChannel, boolean>;

export const notificationChannelsSchema = z.object({
	email: z.boolean(),
	telegram: z.boolean(),
	max: z.boolean()
}) satisfies z.ZodType<NotificationChannelSwitches>;

/** Строка журнала доставок в том виде, в каком её показывает экран. */
export type NotificationDeliveryView = {
	id: string;
	kind: NotificationKind;
	interactionId: string;
	interactionTitle: string | null;
	stageEntryId: string;
	/** Название стадии из слепка записи: маршрут могли переиздать. */
	stageName: string | null;
	recipientUserId: string | null;
	recipientName: string | null;
	channel: NotificationChannel;
	status: NotificationDeliveryStatus;
	attempts: number;
	lastError: string | null;
	sentAt: Date | null;
	nextNotifyAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
};

export const notificationFilterSchema = z.object({
	status: z.enum(NOTIFICATION_DELIVERY_STATUSES).nullable().default(null),
	channel: z.enum(NOTIFICATION_CHANNELS).nullable().default(null)
});

export type NotificationFilter = z.output<typeof notificationFilterSchema>;

/** Тот же фильтр вместе со страницей: журнал читают глазами и по одной. */
export const notificationQuerySchema = notificationFilterSchema.extend(pageQuerySchema.shape);

export type NotificationQuery = z.output<typeof notificationQuerySchema>;

export const retryNotificationSchema = z.object({
	deliveryId: z.uuid({ error: 'Некорректный идентификатор доставки' })
});

export type RetryNotificationInput = z.output<typeof retryNotificationSchema>;
