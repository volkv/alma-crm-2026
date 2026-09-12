/**
 * Импорт данных об обучении: файл → строки → подтверждение.
 *
 * Шагов четыре, и каждый из них — отдельное решение человека:
 *
 * 1. `createSnapshot` — файл принят и лежит в хранилище неизменяемым;
 * 2. `applyMapping` — колонки сопоставлены полям, строки разобраны, у неверных
 *    есть претензии;
 * 3. `validateSnapshot` — счётчики пересчитаны по тому, что в базе;
 * 4. `confirmSnapshot` / `rejectSnapshot` — снимок принят в показатели или
 *    отклонён с объяснением.
 *
 * Разделение не церемониальное: между шагами человек смотрит на предложенное
 * сопоставление и на построчные ошибки. Автоматический импорт «одной кнопкой»
 * означал бы, что в отчёт попадают числа, которых никто не видел.
 *
 * Ничего не удаляется и не перезаписывается: замещение — это признак на
 * снимке, исправление — новая версия строки. Поэтому на вопрос «откуда это
 * число» всегда есть ответ.
 */
import { and, count, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
	createStatSnapshotSchema,
	EMPTY_STAT_COVERAGE,
	statMappingSchema,
	STAT_FIELD_LABELS,
	STAT_PREVIEW_PARSE_LIMIT,
	type StatCoverage,
	type StatMapping,
	type StatSnapshotStatus,
	type StatSnapshotView
} from '$lib/contracts/stats';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { documents, statRows, statSnapshots } from '../db/schema';
import { withTransaction, type Tx } from '../db/transaction';
import { discardStaged, promoteBlob, stageBlob } from '../documents/storage';
import { ConflictError, ValidationError } from '../errors';
import { requirePermission } from '../rbac';
import { buildRows, missingRequiredFields, type StatRowDraft } from './build';
import { invalidateStatsDashboard } from './dashboard';
import { detectStatFile } from './format';
import { loadDirectoryIndex } from './lookup';
import { readTable } from './parse';
import { readSnapshotTable, selectSnapshotRow, toStatSnapshotView } from './read';

/**
 * Вид, под которым исходный файл лежит в разделе документов. Справочник видов
 * закрытый (`UPLOADED_DOCUMENT_KINDS`), и «выгрузка» в нём называется отчётом:
 * заводить ради импорта восьмой вид значило бы разойтись с фильтрами раздела.
 */
const STAT_FILE_DOCUMENT_KIND = 'report';

/** Название документа не длиннее того, что принимает контракт документов. */
const MAX_DOCUMENT_TITLE = 300;

/** Сколько строк уходит в базу одним запросом: у оператора PostgreSQL потолок на параметры. */
const INSERT_CHUNK = 500;

export type SnapshotFile = {
	/** Имя файла у человека: становится названием документа в хранилище. */
	name: string;
	bytes: Uint8Array;
};

export type CreateSnapshotCommand = {
	source: string;
	mode: string;
	periodKind: string;
	periodStart: string;
	periodEnd: string;
	coverage?: StatCoverage;
	note?: string | null;
	file: SnapshotFile;
};

function invalid(message: string, error: { issues: { message: string }[] }): ValidationError {
	return new ValidationError(
		message,
		error.issues.map((issue) => issue.message)
	);
}

/**
 * Область покрытия в каноническом виде: порядок идентификаторов в файле
 * случаен, а по области сравниваются снимки — «та же область» не должна
 * зависеть от порядка.
 */
function normalizeCoverage(coverage: StatCoverage): StatCoverage {
	return {
		organizationIds: [...new Set(coverage.organizationIds)].sort(),
		siteIds: [...new Set(coverage.siteIds)].sort(),
		programIds: [...new Set(coverage.programIds)].sort()
	};
}

/** Ключ области: по нему полная выгрузка находит ту, которую замещает. */
function coverageKey(coverage: StatCoverage): string {
	return JSON.stringify(normalizeCoverage(coverage));
}

function documentTitle(fileName: string, periodStart: string): string {
	const name = fileName.trim();

	return (name === '' ? `Выгрузка от ${periodStart}` : name).slice(0, MAX_DOCUMENT_TITLE);
}

/** Снимок, который ещё можно править: подтверждённый и отклонённый — уже нет. */
function assertEditable(status: StatSnapshotStatus): void {
	if (status === 'confirmed') {
		throw new ConflictError(
			'Снимок уже подтверждён: чтобы поправить данные, загрузите исправление'
		);
	}

	if (status === 'rejected') {
		throw new ConflictError('Снимок отклонён: загрузите файл заново');
	}
}

export async function createSnapshot(
	ctx: ActorContext,
	input: CreateSnapshotCommand
): Promise<StatSnapshotView> {
	await requirePermission(ctx, 'stats.import', { type: 'stats.snapshot_created' });

	const parsed = createStatSnapshotSchema.safeParse({
		source: input.source,
		mode: input.mode,
		periodKind: input.periodKind,
		periodStart: input.periodStart,
		periodEnd: input.periodEnd,
		coverage: input.coverage ?? EMPTY_STAT_COVERAGE,
		note: input.note ?? null
	});

	if (!parsed.success) {
		throw invalid('Снимок не прошёл проверку', parsed.error);
	}

	const command = parsed.data;
	const { format, mime } = detectStatFile(input.file.bytes);

	// Файл разбирается до записи в хранилище: принять и положить на диск то,
	// в чём нет ни одной строки, значит отложить отказ на шаг вперёд.
	await readTable(format, input.file.bytes, STAT_PREVIEW_PARSE_LIMIT);

	const staged = await stageBlob(input.file.bytes, mime);

	try {
		return await withTransaction(ctx, async (tx) => {
			await promoteBlob(staged);

			// Запись в `documents` делается здесь, а не через `uploadDocument`:
			// право на загрузку данных — `stats.import`, и оно не должно зависеть
			// от права прикладывать документы к взаимодействиям. Протокол записи
			// хранилища при этом соблюдён целиком.
			const [file] = await tx
				.insert(documents)
				.values({
					interactionId: null,
					kind: STAT_FILE_DOCUMENT_KIND,
					title: documentTitle(input.file.name, command.periodStart),
					filePath: staged.relativePath,
					mime: staged.mime,
					sizeBytes: staged.sizeBytes,
					sha256: staged.sha256,
					uploadedBy: ctx.user?.id ?? null
				})
				.returning();

			const [row] = await tx
				.insert(statSnapshots)
				.values({
					source: command.source,
					mode: command.mode,
					periodKind: command.periodKind,
					periodStart: command.periodStart,
					periodEnd: command.periodEnd,
					coverage: normalizeCoverage(command.coverage),
					status: 'uploading',
					fileDocumentId: file.id,
					note: command.note,
					createdBy: ctx.user?.id ?? null
				})
				.returning();

			await recordAuditEvent(
				ctx,
				{
					type: 'stats.snapshot_created',
					outcome: 'success',
					subject: { type: 'stat_snapshot', id: row.id },
					details: { documentId: file.id }
				},
				tx
			);

			return toStatSnapshotView(row);
		});
	} catch (error) {
		await discardStaged([staged], error);
		throw error;
	}
}

function toInsertValues(snapshotId: string, draft: StatRowDraft): typeof statRows.$inferInsert {
	return {
		snapshotId,
		rowNo: draft.rowNo,
		organizationId: draft.organizationId,
		siteId: draft.siteId,
		programId: draft.programId,
		periodStart: draft.periodStart,
		periodEnd: draft.periodEnd,
		applications: draft.applications,
		enrolled: draft.enrolled,
		parallelStreams: draft.parallelStreams,
		completed: draft.completed,
		coveragePlan: draft.coveragePlan,
		coverageFact: draft.coverageFact,
		raw: draft.raw,
		issues: draft.issues,
		isValid: draft.isValid
	};
}

/**
 * Применяет сопоставление колонок и разбирает файл построчно.
 *
 * Строки снимка переписываются целиком: сопоставление можно поменять и
 * применить заново, и остаток прежнего разбора рядом с новым был бы вторым
 * ответом на тот же вопрос.
 */
export async function applyMapping(
	ctx: ActorContext,
	snapshotId: string,
	mapping: StatMapping
): Promise<StatSnapshotView> {
	await requirePermission(ctx, 'stats.import', {
		type: 'stats.snapshot_mapped',
		subject: { type: 'stat_snapshot', id: snapshotId }
	});

	const snapshot = await selectSnapshotRow(snapshotId);
	assertEditable(snapshot.status);

	const parsed = statMappingSchema.safeParse(mapping);

	if (!parsed.success) {
		throw invalid('Сопоставление колонок не прошло проверку', parsed.error);
	}

	const table = await readSnapshotTable(snapshot);
	const unknown = Object.keys(parsed.data).filter((column) => !table.headers.includes(column));

	if (unknown.length > 0) {
		throw new ValidationError('В файле нет таких колонок', [
			`Сопоставлены колонки, которых нет в шапке: ${unknown.join(', ')}`
		]);
	}

	const missing = missingRequiredFields(parsed.data);

	if (missing.length > 0) {
		throw new ValidationError('Сопоставлены не все обязательные поля', [
			`Без этих полей строку не к чему отнести: ${missing
				.map((field) => STAT_FIELD_LABELS[field])
				.join(', ')}`
		]);
	}

	const drafts = buildRows({
		table,
		mapping: parsed.data,
		index: await loadDirectoryIndex(),
		period: { start: snapshot.periodStart, end: snapshot.periodEnd }
	});

	const errorCount = drafts.filter((draft) => !draft.isValid).length;

	return withTransaction(ctx, async (tx) => {
		await tx.delete(statRows).where(eq(statRows.snapshotId, snapshot.id));

		for (let from = 0; from < drafts.length; from += INSERT_CHUNK) {
			await tx
				.insert(statRows)
				.values(
					drafts.slice(from, from + INSERT_CHUNK).map((draft) => toInsertValues(snapshot.id, draft))
				);
		}

		const [row] = await tx
			.update(statSnapshots)
			.set({
				mapping: parsed.data,
				status: 'mapped',
				rowCount: drafts.length,
				errorCount,
				updatedAt: new Date()
			})
			.where(eq(statSnapshots.id, snapshot.id))
			.returning();

		await recordAuditEvent(
			ctx,
			{
				type: 'stats.snapshot_mapped',
				outcome: 'success',
				subject: { type: 'stat_snapshot', id: snapshot.id }
			},
			tx
		);

		return toStatSnapshotView(row);
	});
}

/**
 * Пересчитывает счётчики по тому, что лежит в базе, и переводит снимок в
 * «проверен». Отдельного события журнала у проверки нет: она ничего не решает
 * — считает по уже записанным строкам, — а решение человека это следующий шаг.
 */
export async function validateSnapshot(
	ctx: ActorContext,
	snapshotId: string
): Promise<StatSnapshotView> {
	await requirePermission(ctx, 'stats.import', {
		type: 'stats.snapshot_mapped',
		subject: { type: 'stat_snapshot', id: snapshotId }
	});

	const snapshot = await selectSnapshotRow(snapshotId);
	assertEditable(snapshot.status);

	if (snapshot.status === 'uploading') {
		throw new ConflictError('Сначала сопоставьте колонки файла с полями');
	}

	return withTransaction(ctx, async (tx) => {
		const [counts] = await tx
			.select({
				total: count(),
				invalidRows: sql<number>`count(*) filter (where not ${statRows.isValid})::integer`
			})
			.from(statRows)
			.where(eq(statRows.snapshotId, snapshot.id));

		const [row] = await tx
			.update(statSnapshots)
			.set({
				status: 'validated',
				rowCount: counts?.total ?? 0,
				errorCount: counts?.invalidRows ?? 0,
				updatedAt: new Date()
			})
			.where(eq(statSnapshots.id, snapshot.id))
			.returning();

		return toStatSnapshotView(row);
	});
}

/**
 * Замещение полной выгрузкой: прежняя текущая того же источника, периода и
 * области перестаёт учитываться. Строки её остаются на месте — по ним видно,
 * что показатель когда-то считался иначе.
 */
async function supersedeCurrent(
	tx: Tx,
	snapshot: typeof statSnapshots.$inferSelect
): Promise<string | null> {
	const candidates = await tx
		.select()
		.from(statSnapshots)
		.where(
			and(
				eq(statSnapshots.isCurrent, true),
				eq(statSnapshots.source, snapshot.source),
				eq(statSnapshots.periodKind, snapshot.periodKind),
				eq(statSnapshots.periodStart, snapshot.periodStart),
				eq(statSnapshots.periodEnd, snapshot.periodEnd),
				ne(statSnapshots.id, snapshot.id)
			)
		)
		// Блокировка строк-кандидатов: две загрузки, подтверждённые одновременно,
		// иначе обе сочли бы себя единственной текущей.
		.for('update');

	const key = coverageKey(snapshot.coverage);
	const replaced = candidates.filter((candidate) => coverageKey(candidate.coverage) === key);

	if (replaced.length === 0) {
		return null;
	}

	await tx
		.update(statSnapshots)
		.set({ isCurrent: false, updatedAt: new Date() })
		.where(
			inArray(
				statSnapshots.id,
				replaced.map((candidate) => candidate.id)
			)
		);

	// Замещённых может оказаться несколько (дополнения к той же области);
	// ссылка ведёт на последнюю подтверждённую — с неё и начинают разбираться.
	return replaced.reduce((latest, candidate) =>
		(candidate.confirmedAt?.getTime() ?? 0) > (latest.confirmedAt?.getTime() ?? 0)
			? candidate
			: latest
	).id;
}

/**
 * Исправление: строка с тем же ключом перестаёт учитываться, а новая получает
 * следующую версию. Строка исправления, которой нечего заменять, просто
 * добавляется — это видно по её версии, она остаётся первой.
 */
async function applyCorrections(
	tx: Tx,
	snapshot: typeof statSnapshots.$inferSelect
): Promise<number> {
	const incoming = await tx
		.select()
		.from(statRows)
		.where(and(eq(statRows.snapshotId, snapshot.id), eq(statRows.isValid, true)));

	if (incoming.length === 0) {
		return 0;
	}

	// Верная строка всегда отнесена к организации и программе — это держит CHECK
	// `stat_rows_valid_is_attributed`, — поэтому ключи собираются без пропусков.
	const organizationIds = [
		...new Set(incoming.map((row) => row.organizationId).filter((id): id is string => id !== null))
	];
	const programIds = [
		...new Set(incoming.map((row) => row.programId).filter((id): id is string => id !== null))
	];

	const current = await tx
		.select({ row: statRows })
		.from(statRows)
		.innerJoin(statSnapshots, eq(statSnapshots.id, statRows.snapshotId))
		.where(
			and(
				eq(statSnapshots.isCurrent, true),
				eq(statRows.isValid, true),
				isNull(statRows.replacedByRowId),
				ne(statRows.snapshotId, snapshot.id),
				inArray(statRows.organizationId, organizationIds),
				inArray(statRows.programId, programIds)
			)
		)
		.for('update');

	const rowKey = (row: typeof statRows.$inferSelect): string =>
		[row.organizationId, row.programId, row.periodStart, row.periodEnd].join(' ');

	const byKey = new Map(current.map((entry) => [rowKey(entry.row), entry.row]));
	let replaced = 0;

	for (const row of incoming) {
		const previous = byKey.get(rowKey(row));

		if (previous === undefined) {
			continue;
		}

		await tx
			.update(statRows)
			.set({ replacedByRowId: row.id, updatedAt: new Date() })
			.where(eq(statRows.id, previous.id));

		await tx
			.update(statRows)
			.set({ version: previous.version + 1, updatedAt: new Date() })
			.where(eq(statRows.id, row.id));

		replaced += 1;
	}

	return replaced;
}

export type ConfirmResult = {
	snapshot: StatSnapshotView;
	/** Сколько строк заменило исправление; у остальных режимов — ноль. */
	replacedRows: number;
};

export async function confirmSnapshot(
	ctx: ActorContext,
	snapshotId: string
): Promise<ConfirmResult> {
	await requirePermission(ctx, 'stats.import', {
		type: 'stats.snapshot_confirmed',
		subject: { type: 'stat_snapshot', id: snapshotId }
	});

	// Идентификатор из адреса проверяется до транзакции: непохожая на UUID
	// строка — это запрос несуществующей записи.
	await selectSnapshotRow(snapshotId);

	const result = await withTransaction(ctx, async (tx) => {
		// Состояние перечитывается под блокировкой строки: между проверкой и
		// записью снимок мог подтвердить кто-то другой.
		const [snapshot] = await tx
			.select()
			.from(statSnapshots)
			.where(eq(statSnapshots.id, snapshotId))
			.for('update');

		if (snapshot === undefined) {
			throw new ConflictError('Снимок данных больше не существует');
		}

		assertEditable(snapshot.status);

		if (snapshot.status !== 'validated') {
			throw new ConflictError('Снимок ещё не проверен: сначала разберите ошибки строк');
		}

		const [valid] = await tx
			.select({ value: count() })
			.from(statRows)
			.where(and(eq(statRows.snapshotId, snapshot.id), eq(statRows.isValid, true)));

		if ((valid?.value ?? 0) === 0) {
			throw new ConflictError('Подтверждать нечего: в снимке нет ни одной верной строки');
		}

		const supersedesSnapshotId =
			snapshot.mode === 'full' ? await supersedeCurrent(tx, snapshot) : null;

		const [row] = await tx
			.update(statSnapshots)
			.set({
				status: 'confirmed',
				isCurrent: true,
				confirmedAt: new Date(),
				confirmedBy: ctx.user?.id ?? null,
				supersedesSnapshotId,
				updatedAt: new Date()
			})
			.where(eq(statSnapshots.id, snapshot.id))
			.returning();

		// Исправления применяются после того, как снимок стал текущим: иначе
		// собственные строки снимка не попали бы в выборку заменяемых.
		const replacedRows = snapshot.mode === 'correction' ? await applyCorrections(tx, row) : 0;

		await recordAuditEvent(
			ctx,
			{
				type: 'stats.snapshot_confirmed',
				outcome: 'success',
				subject: { type: 'stat_snapshot', id: row.id },
				details: supersedesSnapshotId === null ? {} : { supersededSnapshotId: supersedesSnapshotId }
			},
			tx
		);

		return { snapshot: toStatSnapshotView(row), replacedRows };
	});

	// Подтверждение — единственное действие, которое меняет показатели, поэтому
	// собранный дашборд после него недействителен. Инвалидация идёт после
	// фиксации транзакции: изнутри неё показателей ещё нет, и дашборд, собранный
	// в этот момент соседним запросом, лёг бы в кэш прежним.
	await invalidateStatsDashboard();

	return result;
}

export async function rejectSnapshot(
	ctx: ActorContext,
	snapshotId: string,
	reason: string
): Promise<StatSnapshotView> {
	await requirePermission(ctx, 'stats.import', {
		type: 'stats.snapshot_rejected',
		subject: { type: 'stat_snapshot', id: snapshotId }
	});

	const explanation = reason.trim();

	if (explanation === '') {
		throw new ValidationError('Объясните, почему снимок отклонён', [
			'Причина остаётся в карточке снимка: по ней видно, что именно не приняли'
		]);
	}

	const snapshot = await selectSnapshotRow(snapshotId);

	// Подтверждённый снимок уже в показателях, и «отклонить» его задним числом
	// значит поменять отчёт молча. Правильный ход — загрузить исправление или
	// полную выгрузку, которая его заместит.
	assertEditable(snapshot.status);

	return withTransaction(ctx, async (tx) => {
		const [row] = await tx
			.update(statSnapshots)
			.set({ status: 'rejected', isCurrent: false, note: explanation, updatedAt: new Date() })
			.where(eq(statSnapshots.id, snapshot.id))
			.returning();

		await recordAuditEvent(
			ctx,
			{
				type: 'stats.snapshot_rejected',
				outcome: 'success',
				subject: { type: 'stat_snapshot', id: row.id }
			},
			tx
		);

		return toStatSnapshotView(row);
	});
}
