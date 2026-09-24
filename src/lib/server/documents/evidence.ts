/**
 * Отметки по документам взаимодействия как доказательство исполнения стадии.
 *
 * Модуль намеренно листовой — из него не растёт ни одной ссылки на движок
 * стадий: его читает как раз движок (`stages/commands.ts`), решая, получена ли
 * отметка, которую требует стадия. Обратная ссылка замкнула бы круг импортов;
 * так же устроены факты системы обучения (`integrations/exchange/evidence.ts`).
 *
 * Факт живёт в двух местах, и это не дубль. Снимок в
 * `stage_entries.document_mark_evidence` объясняет **подтверждение конкретной
 * записи стадии** и обязан пережить и новую редакцию документа, и его
 * переименование. Сами колонки отметок в `documents` отвечают на другой вопрос —
 * «что вообще отмечено по этому делу», и по ним засчитывается отметка,
 * поставленная **до** входа на стадию.
 */
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type {
	DocumentMarkEvidence,
	DocumentStatusFact,
	DocumentTemplateKey
} from '$lib/contracts/documents';
import { getDb } from '../db';
import { documents } from '../db/schema';
import type { Tx } from '../db/transaction';

type Executor = Tx | ReturnType<typeof getDb>;

/**
 * Столбец с моментом каждой отметки. Одна карта на весь продукт: по ней отметку
 * и ставят (`documents/status.ts`), и ищут здесь — две карты разошлись бы на
 * первой же правке, и «утверждён» начал бы означать разное в двух местах.
 */
type MarkMomentColumn =
	typeof documents.agreedAt | typeof documents.approvedAt | typeof documents.inEffectAt;

export const MARK_MOMENT_COLUMNS: Record<DocumentStatusFact, MarkMomentColumn> = {
	agreed: documents.agreedAt,
	approved: documents.approvedAt,
	in_effect: documents.inEffectAt
};

/**
 * Самая свежая отметка нужного вида по документам взаимодействия; `null` — её
 * не ставили. С ключом шаблона ищется только на документах этого шаблона
 * (`documents.template_key`): утверждённое соглашение — не подписанный акт
 * передачи, хотя отметка у них одна и та же.
 *
 * «Самая свежая» — по моменту самой отметки, а не по моменту записи: отметку
 * ставят задним числом, и порядок фактов задаёт названный день, а не очередь, в
 * которой до них дошли руки. Заменённые редакции отсюда не исключаются:
 * утверждение случилось, и новая редакция его не отменяет — она лишь начинает
 * собственную цепочку отметок.
 */
export async function readDocumentMark(
	executor: Executor,
	interactionId: string,
	mark: DocumentStatusFact,
	templateKey: DocumentTemplateKey | null
): Promise<DocumentMarkEvidence | null> {
	const moment = MARK_MOMENT_COLUMNS[mark];

	const [row] = await executor
		.select({ id: documents.id, title: documents.title, markedAt: moment })
		.from(documents)
		.where(
			and(
				eq(documents.interactionId, interactionId),
				isNotNull(moment),
				templateKey === null ? undefined : eq(documents.templateKey, templateKey)
			)
		)
		.orderBy(desc(moment), desc(documents.id))
		.limit(1);

	if (row === undefined || row.markedAt === null) {
		return null;
	}

	return {
		documentId: row.id,
		title: row.title,
		mark,
		markedAt: row.markedAt.toISOString()
	};
}
