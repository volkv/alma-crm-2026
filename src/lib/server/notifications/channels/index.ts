/**
 * Каналы доставки уведомлений: один интерфейс на все.
 *
 * Канал знает ровно две вещи — кому и что. Ни кого уведомлять, ни когда
 * повторять, ни что писать в журнал он не решает: это работа наблюдателя.
 * Поэтому добавить канал — значит добавить строку в реестр и функцию отправки,
 * а не править цикл.
 *
 * Реестр закрыт типом `Record<NotificationChannel, …>`: завести канал в словаре
 * контракта и забыть про его отправку нельзя — проект не соберётся.
 */
import type { NotificationChannel } from '$lib/contracts/notifications';
import type { NotificationMessage } from '../message';
import { sendEmail } from './email';
import { sendStub } from './stub';

/** Кому уходит уведомление. Адрес может быть не заполнен — канал скажет об этом. */
export type NotificationRecipient = {
	userId: string;
	fullName: string;
	email: string | null;
};

/**
 * Чем кончилась попытка. `stub` — отдельный исход, а не «успех»: строка журнала
 * обязана отличать доставленное от изображённого.
 */
export type ChannelOutcome = {
	status: 'sent' | 'failed' | 'stub';
	/** Что не так или почему отправки не было — словами, для экрана и журнала. */
	error: string | null;
};

export type NotificationSender = (
	recipient: NotificationRecipient,
	message: NotificationMessage
) => Promise<ChannelOutcome>;

export const NOTIFICATION_SENDERS: Record<NotificationChannel, NotificationSender> = {
	email: sendEmail,
	telegram: sendStub,
	max: sendStub
};

export function sendThroughChannel(
	channel: NotificationChannel,
	recipient: NotificationRecipient,
	message: NotificationMessage
): Promise<ChannelOutcome> {
	return NOTIFICATION_SENDERS[channel](recipient, message);
}
