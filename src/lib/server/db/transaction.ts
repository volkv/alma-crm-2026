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

export async function withTransaction<TResult>(
	ctx: ActorContext,
	fn: (tx: Tx) => Promise<TResult>
): Promise<TResult> {
	return getDb().transaction(async (tx) => {
		// Идентификатор запроса виден в логах PostgreSQL: по нему медленный или
		// упавший оператор связывается с записью журнала и строкой лога приложения.
		await tx.execute(sql`select set_config('app.request_id', ${ctx.requestId}, true)`);

		return fn(tx);
	});
}
