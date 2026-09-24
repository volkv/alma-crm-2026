/**
 * Факты системы обучения по взаимодействию.
 *
 * Модуль намеренно листовой — из него не растёт ни одной ссылки на движок
 * стадий: его читает как раз движок (`stages/commands.ts`), решая, завершено ли
 * обучение. Обратная ссылка замкнула бы круг импортов.
 *
 * Факт живёт в двух местах, и это не дубль. Снимок в `stage_entries.lms_evidence`
 * объясняет **подтверждение конкретной записи стадии** и обязан пережить и
 * удаление группы, и смену процесса. История `learning_group_results` и отметки
 * на группах отвечают на другой вопрос — «завершено ли обучение по этому
 * взаимодействию», и по ним засчитывается итог, пришедший **до** входа на
 * стадию (`docs/exchange-contract.md`, раздел 6).
 *
 * Здесь же живёт правило «нужной группы»: стадию подтверждает только группа
 * этого взаимодействия, чья закреплённая программа входит в его программы, а
 * назначение — в назначения, которые допускает стадия
 * (`stages.lms_group_purposes`; пусто — любое). Второго места, где это правило
 * записано, в продукте нет.
 */
import { and, desc, eq, exists, gt, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import type { LearningPurpose, LmsEvidence } from '$lib/contracts/exchange';
import { getDb } from '../../db';
import { interactionPrograms, learningGroupResults, learningGroups } from '../../db/schema';
import type { Tx } from '../../db/transaction';

type Executor = Tx | ReturnType<typeof getDb>;

/**
 * Группа засчитывается стадии: её программа входит в программы
 * взаимодействия, а назначение — в назначения стадии. Группа без закреплённой
 * программы (заведена до закрепления, выбор не восстановить) не
 * засчитывается — завершить обучение по ней можно отметкой сотрудника, но
 * только после того, как станет ясно, что обучалось. Группа без назначения не
 * засчитывается стадии, которая назначения сужает: для кого шло обучение,
 * неизвестно.
 *
 * `purposes` — назначения, которые допускает стадия; `null` — любые. Поток
 * внутри взаимодействия любой: подтверждает итог любой подходящей группы.
 */
export function countsForStage(
	executor: Executor,
	purposes: readonly LearningPurpose[] | null
): SQL {
	const program = exists(
		executor
			.select({ one: sql`1` })
			.from(interactionPrograms)
			.where(
				and(
					eq(interactionPrograms.interactionId, learningGroups.interactionId),
					eq(interactionPrograms.programId, learningGroups.programId)
				)
			)
	);

	return purposes === null
		? program
		: sql`(${program} and ${inArray(learningGroups.purpose, [...purposes])})`;
}

/**
 * Итоговый результат строкой запроса: то же правило, что
 * `isFinalLearningResult` в контракте, — завершили больше нуля и есть дата
 * окончания.
 */
export function finalResultFilter() {
	return and(gt(learningGroupResults.completed, 0), isNotNull(learningGroupResults.finishedOn));
}

/**
 * Засчитывается ли группа стадии взаимодействия. Группа чужого взаимодействия —
 * нет, как бы её ни назвали. `purposes` — назначения стадии; `null` — любые.
 */
export async function groupCountsForStage(
	executor: Executor,
	interactionId: string,
	learningGroupId: string,
	purposes: readonly LearningPurpose[] | null
): Promise<boolean> {
	const [row] = await executor
		.select({ id: learningGroups.id })
		.from(learningGroups)
		.where(
			and(
				eq(learningGroups.id, learningGroupId),
				eq(learningGroups.interactionId, interactionId),
				countsForStage(executor, purposes)
			)
		)
		.limit(1);

	return row !== undefined;
}

/**
 * Факт завершения обучения по взаимодействию; `null` — обучение не завершено ни
 * по одной засчитываемой группе. `purposes` — назначения, которые допускает
 * стадия; `null` — любые.
 *
 * Засчитывается итоговый результат (завершили больше нуля и есть дата
 * окончания) или отметка сотрудника «обучение завершено». Промежуточный
 * результат — «данные получены», и сюда он не попадает. Из нескольких фактов
 * берётся самый свежий: по моменту отправителя (`occurred_at`) у результата и
 * по моменту отметки у отметки.
 */
export async function readLmsEvidence(
	executor: Executor,
	interactionId: string,
	purposes: readonly LearningPurpose[] | null
): Promise<LmsEvidence | null> {
	const [[result], [mark]] = await Promise.all([
		executor
			.select({
				system: learningGroups.system,
				instance: learningGroups.instance,
				groupExternalId: learningGroups.groupExternalId,
				learningGroupId: learningGroups.id,
				occurredAt: learningGroupResults.occurredAt,
				enrolled: learningGroupResults.enrolled,
				completed: learningGroupResults.completed,
				expelled: learningGroupResults.expelled,
				finishedOn: learningGroupResults.finishedOn,
				periodStart: learningGroupResults.periodStart,
				periodEnd: learningGroupResults.periodEnd
			})
			.from(learningGroupResults)
			.innerJoin(learningGroups, eq(learningGroups.id, learningGroupResults.learningGroupId))
			.where(
				and(
					eq(learningGroups.interactionId, interactionId),
					countsForStage(executor, purposes),
					finalResultFilter()
				)
			)
			.orderBy(desc(learningGroupResults.occurredAt))
			.limit(1),
		executor
			.select({
				learningGroupId: learningGroups.id,
				groupExternalId: learningGroups.groupExternalId,
				streamNumber: learningGroups.streamNumber,
				markedAt: learningGroups.completionMarkedAt,
				markedBy: learningGroups.completionMarkedBy,
				comment: learningGroups.completionComment
			})
			.from(learningGroups)
			.where(
				and(
					eq(learningGroups.interactionId, interactionId),
					countsForStage(executor, purposes),
					isNotNull(learningGroups.completionMarkedAt)
				)
			)
			.orderBy(desc(learningGroups.completionMarkedAt))
			.limit(1)
	]);

	const resultEvidence: LmsEvidence | null =
		result === undefined
			? null
			: {
					kind: 'result',
					system: result.system,
					instance: result.instance,
					groupExternalId: result.groupExternalId ?? '',
					learningGroupId: result.learningGroupId,
					occurredAt: result.occurredAt.toISOString(),
					enrolled: result.enrolled ?? 0,
					completed: result.completed ?? 0,
					expelled: result.expelled ?? 0,
					finishedOn: result.finishedOn,
					periodStart: result.periodStart,
					periodEnd: result.periodEnd
				};

	// Автор отметки мог уйти из системы (`set null`), а отметка остаётся фактом:
	// без автора её снимок не собрать, и такая группа засчитывается итогом, если
	// он есть, а не отметкой.
	const markEvidence: LmsEvidence | null =
		mark === undefined || mark.markedAt === null || mark.markedBy === null || mark.comment === null
			? null
			: {
					kind: 'manual',
					learningGroupId: mark.learningGroupId,
					groupExternalId: mark.groupExternalId,
					streamNumber: mark.streamNumber,
					markedAt: mark.markedAt.toISOString(),
					markedByUserId: mark.markedBy,
					comment: mark.comment
				};

	if (resultEvidence === null || markEvidence === null) {
		return resultEvidence ?? markEvidence;
	}

	return Date.parse(resultEvidence.occurredAt) >= Date.parse(markEvidence.markedAt)
		? resultEvidence
		: markEvidence;
}
