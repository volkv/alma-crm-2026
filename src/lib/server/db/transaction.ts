/**
 * Граница бизнес-транзакции.
 *
 * Транзакцию открывает сервис, который отвечает за целостность операции
 * целиком; вложенные вызовы получают `tx` параметром и новой транзакции не
 * начинают. Так «создать взаимодействие со сторонами и первой стадией» либо
 * происходит целиком, либо не происходит вовсе.
 */
import { sql } from 'drizzle-orm';
import type { ActorContext } from '../actor';
import { getDb } from './index';

/** Дескриптор транзакции Drizzle. Выводится из клиента, чтобы не разъезжаться. */
export type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

/** Что сделать, когда транзакция зафиксирована. */
type CommitFollowUp = () => Promise<void>;

/**
 * Очереди «после фиксации» открытых транзакций. Ключ — сам дескриптор: его
 * получает каждый вложенный вызов, поэтому команда, которая принимает чужую
 * транзакцию, ставит своё в очередь того, кто её открыл, и не знает, когда
 * она закончится.
 */
const followUps = new WeakMap<Tx, CommitFollowUp[]>();

export async function withTransaction<TResult>(
	ctx: ActorContext,
	fn: (tx: Tx) => Promise<TResult>
): Promise<TResult> {
	const queue: CommitFollowUp[] = [];

	const result = await getDb().transaction(async (tx) => {
		followUps.set(tx, queue);

		// Идентификатор запроса виден в логах PostgreSQL: по нему медленный или
		// упавший оператор связывается с записью журнала и строкой лога приложения.
		await tx.execute(sql`select set_config('app.request_id', ${ctx.requestId}, true)`);

		return fn(tx);
	});

	await runFollowUps(ctx, queue);

	return result;
}

/**
 * Сделать это, когда транзакция `tx` зафиксируется; при откате — не делать
 * вовсе.
 *
 * Нужна тому, кто сообщает о записи наружу: живой карточке, чужому процессу.
 * Сообщение до фиксации показало бы то, чего в базе может и не оказаться, —
 * комментарий, который следом откатился вместе с внешней операцией.
 *
 * Транзакцию обязан открыть {@link withTransaction}: только она знает момент
 * фиксации. Дескриптор, открытый в обход неё (или точка сохранения внутри
 * неё), — ошибка вызывающего, и она видна сразу, а не пропавшим сообщением.
 */
export function afterCommit(tx: Tx, followUp: CommitFollowUp): void {
	const queue = followUps.get(tx);

	if (queue === undefined) {
		throw new Error('afterCommit: транзакция открыта не через withTransaction');
	}

	queue.push(followUp);
}

/**
 * Отказ продолжения после фиксации в ответ не уходит: запись уже в базе, и
 * сказать человеку «не получилось» значило бы соврать ему — он повторил бы
 * то, что уже сделано. Отказ пишется в лог с идентификатором запроса, а
 * остальные продолжения выполняются: одно не отменяет другого.
 */
async function runFollowUps(ctx: ActorContext, queue: CommitFollowUp[]): Promise<void> {
	for (const followUp of queue) {
		try {
			await followUp();
		} catch (failure) {
			console.error(
				`[db] запрос ${ctx.requestId}: продолжение после фиксации транзакции не выполнено`,
				failure
			);
		}
	}
}
