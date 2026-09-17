/**
 * Факты системы обучения по взаимодействию.
 *
 * Модуль намеренно листовой — из него не растёт ни одной ссылки на движок
 * стадий: его читает как раз движок (`stages/commands.ts`), решая, получены ли
 * данные обучения. Обратная ссылка замкнула бы круг импортов.
 *
 * Факт живёт в двух местах, и это не дубль. Снимок в `stage_entries.lms_evidence`
 * объясняет **подтверждение конкретной записи стадии** и обязан пережить и
 * удаление группы, и смену процесса. История `learning_group_results` отвечает
 * на другой вопрос — «что вообще известно про обучение по этому взаимодействию»,
 * и по ней засчитывается результат, пришедший **до** входа на стадию
 * (`docs/exchange-contract.md`, раздел 6).
 */
import { desc, eq } from 'drizzle-orm';
import type { LmsEvidence } from '$lib/contracts/exchange';
import { getDb } from '../../db';
import { learningGroupResults, learningGroups } from '../../db/schema';
import type { Tx } from '../../db/transaction';

type Executor = Tx | ReturnType<typeof getDb>;

/**
 * Самый свежий факт обучения по взаимодействию; `null` — результатов не было.
 *
 * «Самый свежий» — по моменту отправителя (`occurred_at`), а не по моменту
 * записи: промежуточный результат и итоговый различает LMS, а не порядок, в
 * котором их доставила сеть.
 */
export async function readLmsEvidence(
	executor: Executor,
	interactionId: string
): Promise<LmsEvidence | null> {
	const [row] = await executor
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
		.where(eq(learningGroups.interactionId, interactionId))
		.orderBy(desc(learningGroupResults.occurredAt))
		.limit(1);

	if (row === undefined) {
		return null;
	}

	return {
		system: row.system,
		instance: row.instance,
		groupExternalId: row.groupExternalId ?? '',
		learningGroupId: row.learningGroupId,
		occurredAt: row.occurredAt.toISOString(),
		enrolled: row.enrolled ?? 0,
		completed: row.completed ?? 0,
		expelled: row.expelled ?? 0,
		finishedOn: row.finishedOn,
		periodStart: row.periodStart,
		periodEnd: row.periodEnd
	};
}
