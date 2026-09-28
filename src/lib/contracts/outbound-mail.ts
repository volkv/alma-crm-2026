/**
 * Письма вузу в фоне: состояния задания очереди и то, что окно письма видит
 * о последней отправке.
 *
 * Окно не ждёт почтового сервера. Нажатие «Отправить» проверяет всё, что
 * проверяется без него, ставит задание в очередь и сразу отвечает
 * «поставлено в отправку»; письма уходят фоновым обработчиком, а след в деле
 * появляется, когда они ушли.
 */

/**
 * Состояния задания.
 *
 * - `queued` — ждёт обработчика;
 * - `sending` — обработчик взял его и говорит с почтовым сервером;
 * - `sent` — ушло всем, кому собирались;
 * - `partial` — ушло не всем: след в деле называет тех, кому ушло;
 * - `failed` — сервер не принял ни одного письма, или отправка прервалась;
 * - `refused` — до сервера не дошло: песочница, закрытая почта, дело или
 *   файлы изменились так, что письмо больше не собрать.
 */
export const OUTBOUND_MAIL_STATUSES = [
	'queued',
	'sending',
	'sent',
	'partial',
	'failed',
	'refused'
] as const;

export type OutboundMailStatus = (typeof OUTBOUND_MAIL_STATUSES)[number];

/** Состояния, в которых задание ещё не закончено. */
export const OUTBOUND_MAIL_IN_FLIGHT = [
	'queued',
	'sending'
] as const satisfies readonly OutboundMailStatus[];

/** Состояния, о которых отправитель узнаёт из колокольчика: ушло не всем или не ушло. */
export const OUTBOUND_MAIL_NOTICE_STATUSES = [
	'partial',
	'failed',
	'refused'
] as const satisfies readonly OutboundMailStatus[];

/**
 * Отправка, которая ещё идёт: окно письма показывает её, чтобы второе нажатие
 * не делалось вслепую. `null` — ничего не ждёт.
 */
export type OutboundMailInFlightView = { queuedAt: string } | null;
