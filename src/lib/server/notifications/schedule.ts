/**
 * Когда напоминать в следующий раз.
 *
 * Правило одно на наблюдателя и на кнопку «Повторить», поэтому оно вынесено
 * отдельным модулем и не знает ни про базу, ни про каналы: чистые числа
 * проверяются числами.
 */
import { MOSCOW_OFFSET_MS } from '$lib/contracts/calendar';
import type { NotificationDeliveryStatus } from '$lib/contracts/notifications';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * Реже какого срока напоминание не повторяется.
 *
 * Повтор идёт с тем же шагом, что и порог: стоит запись вдвое дольше порога —
 * пришло второе напоминание. Но порог бывает и нулевым («напоминать сразу», так
 * настраивают стенд), а нулевой шаг означал бы письмо на каждый проход цикла,
 * то есть раз в пятнадцать секунд. Это не напоминание, а отказ в обслуживании
 * почтового ящика, поэтому у шага есть дно — сутки.
 */
export const MIN_REPEAT_DAYS = 1;

/**
 * Через сколько минут пробовать снова после неудачной отправки.
 *
 * Не через шаг повтора: неудача — это обычно недоступный почтовый сервер, и
 * откладывать напоминание на неделю из-за пятиминутной аварии нельзя. Не через
 * пятнадцать секунд — тоже: очередь стучалась бы в мёртвый сервер каждым
 * проходом цикла.
 */
export const FAILURE_RETRY_MINUTES = 60;

/**
 * Сколько раз наблюдатель пробует сам. Дальше строка остаётся в журнале со
 * статусом «не отправлено» и ждёт человека: почта, которая не уходит пятый час
 * подряд, — это не сетевая рябь, а настройка, которую надо чинить.
 */
export const MAX_ATTEMPTS = 5;

/** Шаг повтора в миллисекундах для заданного порога. */
export function repeatAfterMs(thresholdDays: number): number {
	if (!Number.isInteger(thresholdDays) || thresholdDays < 0) {
		throw new RangeError(
			`Порог зависания — целое число дней не меньше нуля, получено ${thresholdDays}`
		);
	}

	return Math.max(thresholdDays, MIN_REPEAT_DAYS) * DAY_MS;
}

/**
 * Момент следующего напоминания по этой записи стадии. `null` — сам наблюдатель
 * больше не пробует.
 *
 * `attempts` — сколько попыток отправки уже сделано, включая только что
 * завершившуюся.
 */
export function nextNotifyAt(
	outcome: { status: NotificationDeliveryStatus; attempts: number },
	thresholdDays: number,
	now: Date
): Date | null {
	if (outcome.status === 'failed') {
		return outcome.attempts >= MAX_ATTEMPTS
			? null
			: new Date(now.getTime() + FAILURE_RETRY_MINUTES * MINUTE_MS);
	}

	// Отправленное, пропущенное и заглушенное повторяются одинаково: пока запись
	// стадии открыта, о ней напоминают с шагом порога. Незаполненная иерархия —
	// тоже повод напомнить ещё раз: её однажды заполнят.
	return new Date(now.getTime() + repeatAfterMs(thresholdDays));
}

/**
 * Момент следующей попытки по уведомлению о лицензии; `null` — больше не
 * пробовать.
 *
 * Лицензия напоминает **один раз на срок**: ушло (или изображено заглушкой) —
 * и всё, до тех пор пока срок не сменят; новый срок — новая строка журнала.
 * Повтор каждым порогом, как у зависшей стадии, здесь был бы спамом: о сроке,
 * который не движется, второе письмо ничего нового не говорит. Неудачная
 * отправка повторяется по тому же правилу, что и у зависших. Получатель не
 * определён — проверяется раз в сутки: назначат ответственного, и письмо
 * уйдёт ему.
 */
export function licenseNextNotifyAt(
	outcome: { status: NotificationDeliveryStatus; attempts: number },
	now: Date
): Date | null {
	if (outcome.status === 'failed') {
		return nextNotifyAt(outcome, MIN_REPEAT_DAYS, now);
	}

	if (outcome.status === 'skipped' || outcome.status === 'queued') {
		return new Date(now.getTime() + MIN_REPEAT_DAYS * DAY_MS);
	}

	return null;
}

/**
 * Пора ли слать утреннюю сводку: включена и московские часы дошли до часа
 * сводки. Позже в тот же день — тоже пора: процесс, перезапущенный в девять,
 * не должен оставить людей без сводки, а второй раз за день её не отправит
 * ключ дедупликации (получатель × день × канал).
 */
export function digestIsDue(schedule: { enabled: boolean; hour: number }, now: Date): boolean {
	if (!schedule.enabled) {
		return false;
	}

	return new Date(now.getTime() + MOSCOW_OFFSET_MS).getUTCHours() >= schedule.hour;
}

/**
 * Следующая попытка по сводке; `null` — больше не пробовать. Сводка одна на
 * день: ушла (или изображена заглушкой) — и всё. Неудачная отправка
 * повторяется, как у остальных видов, но только в тот же день — это отбирает
 * сам цикл: вчерашняя сводка сегодня уже неправда.
 */
export function digestNextNotifyAt(
	outcome: { status: NotificationDeliveryStatus; attempts: number },
	now: Date
): Date | null {
	return outcome.status === 'failed' ? nextNotifyAt(outcome, MIN_REPEAT_DAYS, now) : null;
}
