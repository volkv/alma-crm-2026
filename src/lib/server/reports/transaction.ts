/**
 * Один снимок базы на весь отчёт.
 *
 * Отчёт читает базу несколькими запросами: стадии процесса, названия выбранных
 * фильтров, итоги с воронкой и разрезами, строки таблицы. Прочитанные порознь,
 * они видят базу в разные моменты: переход, сделанный между подсчётом итогов и
 * чтением строк, дал бы «Взаимодействий: 12» над таблицей из тринадцати строк,
 * и такой отчёт не проверить ничем — ни экраном, ни файлом.
 *
 * Поэтому все чтения одного отчёта идут в одной транзакции `repeatable read`:
 * PostgreSQL показывает каждому её запросу один и тот же снимок, взятый на
 * первом из них. Транзакция только читает — `read only` запрещает ей писать,
 * и отчёт физически не может ничего поменять, пока его собирают. Момент сборки
 * берётся из той же транзакции: он и есть момент снимка, по которому посчитаны
 * числа.
 */
import { sql } from 'drizzle-orm';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import type { Tx } from '../db/transaction';

/** Чем отчёт читает базу: транзакцией снимка или, вне отчёта, самим пулом. */
export type ReportExecutor = Tx | ReturnType<typeof getDb>;

/** Транзакция снимка и её момент. */
export type ReportSnapshot = {
	tx: Tx;
	/** Начало транзакции по часам базы — момент, на который взят снимок. */
	takenAt: Date;
};

export async function readReportSnapshot<TResult>(
	ctx: ActorContext,
	read: (snapshot: ReportSnapshot) => Promise<TResult>
): Promise<TResult> {
	return getDb().transaction(
		async (tx) => {
			// Идентификатор запроса виден в логах PostgreSQL, как у любой другой
			// транзакции продукта (`db/transaction.ts`). Этот же оператор — первый в
			// транзакции, и снимок берётся на нём.
			const [moment] = (await tx.execute(
				sql`select set_config('app.request_id', ${ctx.requestId}, true), now() as "takenAt"`
			)) as unknown as { takenAt: Date | string }[];

			return read({ tx, takenAt: new Date(moment.takenAt) });
		},
		{ isolationLevel: 'repeatable read', accessMode: 'read only' }
	);
}
