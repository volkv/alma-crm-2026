/**
 * Каналы-заглушки: Telegram и MAX.
 *
 * Это **заглушка функционала**, а не канал, который временно не работает.
 * Интерфейс у неё тот же, что у почты, строка в журнале доставок появляется
 * такая же, — но наружу не уходит ничего, и об этом сказано прямо: и в
 * состоянии доставки (`stub`), и в названии канала на экране, и в справке.
 *
 * Молчаливая заглушка была бы хуже отсутствующего канала: включённый Telegram,
 * который «как будто отправляет», однажды окажется единственным каналом
 * эскалации, и никто об этом не узнает.
 */
import type { NotificationMessage } from '../message';
import type { ChannelOutcome, NotificationRecipient } from './index';

/** Что пишется в журнал вместо ошибки: почему письма нет. */
export const STUB_NOTICE =
	'Заглушка: реальная отправка не выполняется — канал заведён как образец интерфейса';

export function sendStub(
	_recipient: NotificationRecipient,
	_message: NotificationMessage
): Promise<ChannelOutcome> {
	return Promise.resolve({ status: 'stub', error: STUB_NOTICE });
}
