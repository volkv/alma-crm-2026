/**
 * Снимок данных об обучении из результатов учебных групп.
 *
 * Результаты, которые система обучения присылает по обмену, ложатся фактом на
 * взаимодействие и закрывают стадию, но в показатели сами не попадают: число,
 * которое никто не принимал, в отчёт не идёт. Эта сборка — тот же путь, что у
 * файла, без файла: сервер складывает группы периода в строки «организация ×
 * программа», снимок встаёт в состояние «проверен», а в показатели его
 * принимает человек той же кнопкой, что и любую выгрузку.
 *
 * **Защита от двойного счёта.**
 *
 * - Внутри снимка: у группы один результат — последний (`stats/facts.ts`), и
 *   одна строка на пару «организация × программа».
 * - Между сборками: снимок всегда **полный**, источник — `lms`, область пуста.
 *   Подтверждение повторной сборки того же периода замещает прежнюю
 *   (`supersedeCurrent` в `stats/import.ts`), а не складывается с ней. Режим
 *   исправления здесь не подошёл бы: он заменяет строки по ключу, и пара,
 *   которая из новой сборки пропала (группу перенесли на другой период),
 *   осталась бы в показателях старой строкой; к тому же он заменял бы строки
 *   чужих источников — файла от вуза — с тем же ключом.
 *
 * Сборка идёт **по всей базе**, а не по области вызывающего: снимок описывает
 * период целиком, и частичная полная сборка при подтверждении вытеснила бы
 * картину остальных вузов. Это то же правило, что у загрузки файла: область
 * доступа применяется к показателям, а не к самим снимкам.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
	isEmptyCoverage,
	type GroupSnapshotPeriod,
	type GroupSnapshotPreview,
	type GroupSnapshotReplaced,
	type GroupSnapshotRow,
	type StatSnapshotView
} from '$lib/contracts/stats';
import { formatNumber, pluralize } from '$lib/format';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getDb } from '../db';
import { documents, organizations, programs, statRows, statSnapshots } from '../db/schema';
import { withTransaction } from '../db/transaction';
import { ConflictError } from '../errors';
import { requirePermission } from '../rbac';
import { addNullable, readGroupFacts, type GroupFact } from './facts';
import { toStatSnapshotView } from './read';

/** Источник сборки: результаты системы обучения (см. `STAT_SOURCES`). */
const GROUP_SNAPSHOT_SOURCE = 'lms';

type Draft = Omit<GroupSnapshotRow, 'organizationName' | 'programCode' | 'programName'>;

/** Группы периода в строки «организация × программа». Чистая функция. */
export function groupRows(groups: readonly GroupFact[]): {
	rows: Draft[];
	skipped: GroupSnapshotPreview['skipped'];
} {
	const rows = new Map<string, Draft>();
	let withoutProgram = 0;
	let withoutOrganization = 0;

	for (const group of groups) {
		if (group.programId === null) {
			withoutProgram += 1;
			continue;
		}

		if (group.organizationId === null) {
			withoutOrganization += 1;
			continue;
		}

		const key = `${group.organizationId} ${group.programId}`;
		const row = rows.get(key) ?? {
			organizationId: group.organizationId,
			programId: group.programId,
			streams: 0,
			withResult: 0,
			enrolled: null,
			completed: null,
			groupLabels: []
		};

		row.streams += 1;
		row.withResult += group.hasResult ? 1 : 0;
		row.enrolled = addNullable(row.enrolled, group.enrolled);
		row.completed = addNullable(row.completed, group.completed);
		row.groupLabels.push(group.label);
		rows.set(key, row);
	}

	return { rows: [...rows.values()], skipped: { withoutProgram, withoutOrganization } };
}

/** Текущие снимки, которые полная сборка того же периода заместит. */
async function currentToReplace(period: GroupSnapshotPeriod): Promise<GroupSnapshotReplaced[]> {
	const rows = await getDb()
		.select({
			snapshotId: statSnapshots.id,
			coverage: statSnapshots.coverage,
			fileName: documents.title,
			confirmedAt: statSnapshots.confirmedAt,
			rowCount: statSnapshots.rowCount
		})
		.from(statSnapshots)
		.leftJoin(documents, eq(documents.id, statSnapshots.fileDocumentId))
		.where(
			and(
				eq(statSnapshots.isCurrent, true),
				eq(statSnapshots.source, GROUP_SNAPSHOT_SOURCE),
				eq(statSnapshots.periodKind, period.periodKind),
				eq(statSnapshots.periodStart, period.periodStart),
				eq(statSnapshots.periodEnd, period.periodEnd)
			)
		);

	// Замещение сравнивает области; у сборки область пуста, поэтому
	// вытесняется только снимок с такой же пустой областью.
	return rows
		.filter((row) => isEmptyCoverage(row.coverage))
		.map(({ coverage: _coverage, ...row }) => row);
}

async function collect(period: GroupSnapshotPeriod): Promise<GroupSnapshotPreview> {
	const groups = await readGroupFacts(
		{ start: period.periodStart, end: period.periodEnd },
		sql`true`
	);
	const { rows, skipped } = groupRows(groups);

	const organizationIds = [...new Set(rows.map((row) => row.organizationId))];
	const programIds = [...new Set(rows.map((row) => row.programId))];
	const db = getDb();

	const [organizationRows, programRows, replaces] = await Promise.all([
		organizationIds.length === 0
			? []
			: db
					.select({ id: organizations.id, name: organizations.shortName })
					.from(organizations)
					.where(inArray(organizations.id, organizationIds)),
		programIds.length === 0
			? []
			: db
					.select({ id: programs.id, code: programs.code, name: programs.name })
					.from(programs)
					.where(inArray(programs.id, programIds)),
		currentToReplace(period)
	]);

	const organizationName = new Map(organizationRows.map((row) => [row.id, row.name]));
	const programById = new Map(programRows.map((row) => [row.id, row]));

	const named = rows
		.map((row) => {
			const program = programById.get(row.programId);
			const name = organizationName.get(row.organizationId);

			if (program === undefined || name === undefined) {
				throw new Error('Строка сборки ссылается на запись, которой нет в справочнике');
			}

			return {
				...row,
				organizationName: name,
				programCode: program.code,
				programName: program.name
			};
		})
		.sort(
			(left, right) =>
				left.organizationName.localeCompare(right.organizationName) ||
				left.programCode.localeCompare(right.programCode)
		);

	return {
		period,
		rows: named,
		totals: {
			groups: named.reduce((total, row) => total + row.streams, 0),
			withResult: named.reduce((total, row) => total + row.withResult, 0),
			enrolled: named.reduce<number | null>((total, row) => addNullable(total, row.enrolled), null),
			completed: named.reduce<number | null>(
				(total, row) => addNullable(total, row.completed),
				null
			)
		},
		skipped,
		replaces
	};
}

/** Предпросмотр: что попадёт в снимок, сколько групп и слушателей. */
export async function previewGroupSnapshot(
	ctx: ActorContext,
	period: GroupSnapshotPeriod
): Promise<GroupSnapshotPreview> {
	requirePermission(ctx, 'stats.import');

	return collect(period);
}

/**
 * Собирает снимок и оставляет его проверенным: в показатели он попадёт после
 * подтверждения человеком на шаге проверки, как и загруженный файл.
 */
export async function buildGroupSnapshot(
	ctx: ActorContext,
	period: GroupSnapshotPeriod
): Promise<StatSnapshotView> {
	await requirePermission(ctx, 'stats.import', { type: 'stats.snapshot_created' });

	const preview = await collect(period);

	if (preview.rows.length === 0) {
		throw new ConflictError('Собирать нечего: за период нет учебных групп с программой и вузом');
	}

	const note = `Собран из результатов учебных групп: ${pluralize(preview.totals.groups, ['группа', 'группы', 'групп'])}, из них с результатом — ${formatNumber(preview.totals.withResult)}.`;

	return withTransaction(ctx, async (tx) => {
		const [snapshot] = await tx
			.insert(statSnapshots)
			.values({
				source: GROUP_SNAPSHOT_SOURCE,
				mode: 'full',
				periodKind: period.periodKind,
				periodStart: period.periodStart,
				periodEnd: period.periodEnd,
				status: 'validated',
				rowCount: preview.rows.length,
				errorCount: 0,
				note,
				createdBy: ctx.user?.id ?? null
			})
			.returning();

		await tx.insert(statRows).values(
			preview.rows.map((row, index) => ({
				snapshotId: snapshot.id,
				rowNo: index + 1,
				organizationId: row.organizationId,
				programId: row.programId,
				periodStart: period.periodStart,
				periodEnd: period.periodEnd,
				applications: null,
				enrolled: row.enrolled,
				parallelStreams: row.streams,
				completed: row.completed,
				// Происхождение строки — имена групп: по ним строку находят в
				// системе обучения, как строку файла находят по номеру.
				raw: {
					Организация: row.organizationName,
					Программа: `${row.programCode} · ${row.programName}`,
					'Учебные группы': row.groupLabels.join(', '),
					'Групп с результатом': String(row.withResult)
				},
				issues: [],
				isValid: true
			}))
		);

		await recordAuditEvent(
			ctx,
			{
				type: 'stats.snapshot_created',
				outcome: 'success',
				subject: { type: 'stat_snapshot', id: snapshot.id }
			},
			tx
		);

		return toStatSnapshotView(snapshot);
	});
}
