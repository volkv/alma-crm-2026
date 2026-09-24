/**
 * Сообщить открытым карточкам, что дело изменилось, — строго после фиксации.
 *
 * Команда подключает это одной строкой внутри своей транзакции:
 *
 * ```ts
 * publishAfterCommit(tx, input.interactionId, { type: 'comment.added', commentId: comment.id });
 * ```
 *
 * Сообщение уходит, когда зафиксируется транзакция, открытая
 * `withTransaction`, — у команды, принявшей чужую транзакцию, это фиксация
 * внешней операции. При откате оно не уходит вовсе: карточки не увидят
 * комментарий, которого в базе не оказалось.
 */
import type { LiveEvent } from '$lib/contracts/live';
import { afterCommit, type Tx } from '../db/transaction';
import { publishLive } from './bus';

export function publishAfterCommit(tx: Tx, interactionId: string, event: LiveEvent): void {
	afterCommit(tx, () => publishLive(interactionId, event));
}

/**
 * Изменились дела, которые поимённо не перечислить (обезличивание переписывает
 * заголовки всех дел человека): перечитаться всем открытым карточкам. Зовётся
 * после фиксации тем, кто её дождался.
 */
export function publishEverythingChanged(): Promise<void> {
	return publishLive(null, { type: 'interaction.changed' });
}
