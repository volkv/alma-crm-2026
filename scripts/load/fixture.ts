/**
 * Список карточек для нагрузочного сценария.
 *
 * Сценарий k6 не умеет открывать диалоги и читать разметку: чтобы он мог
 * повторить настоящую работу — открыть карточку и перевести её на следующую
 * стадию с комментарием, — ему нужны идентификаторы, которые в интерфейсе
 * человек получает нажатием. Их и считает этот скрипт: по каждой записи
 * нагрузочного набора он говорит, где она стоит и куда с этой стадии можно
 * шагнуть.
 *
 * Скрипт читает базу и ничего в ней не меняет. Запускается внутри контейнера
 * приложения нагрузочного стенда, печатает JSON в стандартный вывод:
 *
 *   docker compose -p lct-load … exec -T app node scripts/load/fixture.ts
 *
 * Почему список неоднородный. Стадии процесса работы с вузом делятся надвое:
 * до подписания соглашения шаг вперёд требует только решения человека, после —
 * результата и подтверждения данными. Переводить карточку, которой по процессу
 * переходить нельзя, значило бы мерить скорость отказа, поэтому в `advance`
 * попадают только те записи, у которых шаг вперёд действительно разрешён;
 * остальные остаются в `cards` и участвуют в чтении.
 */
import { installKitAliases } from '../seed/aliases.ts';

installKitAliases();

const { and, count, desc, eq, isNull } = await import('drizzle-orm');
const { closeDatabase, getDb } = await import('$lib/server/db');
const { comments, interactions, stageEntries } = await import('$lib/server/db/schema');
const { B2B_WORKSPACE_KEY } = await import('$lib/server/stages/definitions');
const { readActiveRevision, readWorkflowForWorkspace, readWorkspaceByKey } =
	await import('$lib/server/stages/process');

type StageSnapshotShape = {
	key: string;
	requiresResult: boolean;
	requiresConfirmation: boolean;
	requiresLmsData: boolean;
	requiresDocumentMark: string | null;
	isFinal: boolean;
	checklist: { key: string; required: boolean }[];
};

try {
	const db = getDb();
	const workspace = await readWorkspaceByKey(db, B2B_WORKSPACE_KEY);
	const workflow = await readWorkflowForWorkspace(db, workspace.id);
	const revision = workflow === null ? null : await readActiveRevision(db, workflow);

	if (revision === null) {
		throw new Error('У пространства «b2b» нет действующего процесса');
	}

	/** Куда ведёт шаг вперёд с каждой стадии редакции. */
	const forward = new Map<string, string>();

	for (const transition of revision.transitions) {
		if (transition.kind === 'forward' && !forward.has(transition.fromStageId)) {
			forward.set(transition.fromStageId, transition.toStageId);
		}
	}

	const rows = await db
		.select({
			id: interactions.id,
			stageId: stageEntries.stageId,
			snapshot: stageEntries.stageSnapshot,
			checklistState: stageEntries.checklistState
		})
		.from(interactions)
		.innerJoin(stageEntries, eq(stageEntries.interactionId, interactions.id))
		.where(and(eq(interactions.status, 'active'), isNull(stageEntries.leftAt)))
		.orderBy(interactions.id);

	// Записи с длинной историей: на них видно, что даёт кэш повторного открытия.
	// Порядок — по длине ленты, поэтому первые в списке самые тяжёлые.
	const longest = await db
		.select({ id: comments.interactionId, rows: count() })
		.from(comments)
		.groupBy(comments.interactionId)
		.orderBy(desc(count()))
		.limit(200);

	const cards: string[] = [];
	const advance: { id: string; fromStageId: string; toStageId: string }[] = [];

	for (const row of rows) {
		cards.push(row.id);

		const snapshot = row.snapshot as unknown as StageSnapshotShape;
		const toStageId = forward.get(row.stageId);

		const blocked =
			snapshot.requiresResult ||
			snapshot.requiresConfirmation ||
			snapshot.requiresLmsData ||
			snapshot.requiresDocumentMark !== null ||
			snapshot.isFinal ||
			snapshot.checklist.some((item) => item.required && row.checklistState[item.key] !== true);

		if (toStageId !== undefined && !blocked) {
			advance.push({ id: row.id, fromStageId: row.stageId, toStageId });
		}
	}

	process.stdout.write(
		`${JSON.stringify(
			{ revision: revision.version, cards, advance, longest: longest.map((row) => row.id) },
			null,
			'\t'
		)}\n`
	);
} finally {
	await closeDatabase();
}
