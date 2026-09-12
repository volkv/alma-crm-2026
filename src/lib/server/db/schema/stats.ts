/**
 * Данные об обучении: снимки импорта, их строки и показатели.
 *
 * Единица хранения — снимок, а не текущее значение: число обучающихся всегда
 * чьё-то и за какой-то период, поэтому у него есть источник, отчётный период,
 * область покрытия, режим и момент подтверждения. Показатель считается только
 * по подтверждённым снимкам — этим отчёт отличается от черновика.
 *
 * Актуальность живёт в двух признаках, а не в удалении строк:
 *
 * - `stat_snapshots.is_current` — снимок подтверждён и ещё не замещён. Полная
 *   выгрузка (`mode = 'full'`) при подтверждении снимает признак с прежней
 *   текущей того же источника, периода и области и записывает её в
 *   `supersedes_snapshot_id`;
 * - `stat_rows.replaced_by_row_id` — строку заменило исправление. Прежняя
 *   версия остаётся в базе: по ней видно, что именно поправили.
 *
 * Ничего не удаляется: загрузка, которую отклонили, остаётся со своими
 * строками и претензиями — иначе на вопрос «почему эти числа не в отчёте»
 * ответить нечем.
 *
 * Набор полей — гипотеза до технического задания; имена нейтральные, значения
 * перечислений берутся из контрактов, чтобы список вариантов был один на форму
 * и на базу.
 */
import { relations, sql } from 'drizzle-orm';
import {
	boolean,
	check,
	date,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	pgView,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	type AnyPgColumn
} from 'drizzle-orm/pg-core';
import type { StatCoverage, StatMapping, StatRowIssue } from '$lib/contracts/stats';
import {
	STAT_PERIOD_KINDS,
	STAT_SNAPSHOT_MODES,
	STAT_SNAPSHOT_STATUSES,
	STAT_SOURCES
} from '$lib/contracts/stats';
import { users } from './auth';
import { organizations, programs, sites } from './directory';
import { documents } from './documents';
import { timestamps } from './shared';

export const statSourceEnum = pgEnum('stat_source', STAT_SOURCES);
export const statSnapshotModeEnum = pgEnum('stat_snapshot_mode', STAT_SNAPSHOT_MODES);
export const statPeriodKindEnum = pgEnum('stat_period_kind', STAT_PERIOD_KINDS);
export const statSnapshotStatusEnum = pgEnum('stat_snapshot_status', STAT_SNAPSHOT_STATUSES);

export const statSnapshots = pgTable(
	'stat_snapshots',
	{
		id: uuid().primaryKey().defaultRandom(),
		source: statSourceEnum().notNull(),
		mode: statSnapshotModeEnum().notNull(),
		periodKind: statPeriodKindEnum().notNull(),
		periodStart: date().notNull(),
		periodEnd: date().notNull(),
		/**
		 * Что именно описывает снимок: `{organizationIds, siteIds, programIds}`.
		 * Пустая область — «всё, что есть в файле», и тогда замещение считается
		 * по источнику и периоду.
		 */
		coverage: jsonb().$type<StatCoverage>().notNull().default({
			organizationIds: [],
			siteIds: [],
			programIds: []
		}),
		status: statSnapshotStatusEnum().notNull().default('uploading'),
		/** Исходный файл в хранилище документов; у ручного ввода его нет. */
		fileDocumentId: uuid().references((): AnyPgColumn => documents.id, { onDelete: 'set null' }),
		rowCount: integer().notNull().default(0),
		errorCount: integer().notNull().default(0),
		/** Сопоставление колонок файла с полями строки: `{колонка: поле}`. */
		mapping: jsonb().$type<StatMapping>().notNull().default({}),
		/**
		 * Снимок учитывается в показателях. Признак ставится подтверждением и
		 * снимается замещающей полной выгрузкой: вычислять актуальность на лету
		 * пришлось бы в каждом запросе, а расходящийся ответ — это неверный отчёт.
		 */
		isCurrent: boolean().notNull().default(false),
		/** Кого замещает эта полная выгрузка. */
		supersedesSnapshotId: uuid().references((): AnyPgColumn => statSnapshots.id, {
			onDelete: 'set null'
		}),
		note: text(),
		createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
		confirmedAt: timestamp({ withTimezone: true }),
		confirmedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
		...timestamps
	},
	(table) => [
		index('stat_snapshots_period_idx').on(table.periodStart, table.periodEnd),
		index('stat_snapshots_status_idx').on(table.status),
		// Отбор текущих снимков — самый частый запрос показателей, и в нём
		// участвует только малая часть строк.
		index('stat_snapshots_current_idx')
			.on(table.source, table.periodStart, table.periodEnd)
			.where(sql`${table.isCurrent}`),
		check('stat_snapshots_period_ordered', sql`${table.periodEnd} >= ${table.periodStart}`),
		// В показателях участвует только подтверждённое. Признак и статус ставит
		// одна и та же команда, но расходятся они молча — и тогда в отчёт попадут
		// числа, которых никто не принимал.
		check(
			'stat_snapshots_current_is_confirmed',
			sql`not ${table.isCurrent} or ${table.status} = 'confirmed'`
		),
		check(
			'stat_snapshots_confirmed_has_moment',
			sql`(${table.status} = 'confirmed') = (${table.confirmedAt} is not null)`
		)
	]
);

export const statRows = pgTable(
	'stat_rows',
	{
		id: uuid().primaryKey().defaultRandom(),
		snapshotId: uuid()
			.notNull()
			.references(() => statSnapshots.id, { onDelete: 'cascade' }),
		/** Номер строки в файле, начиная с 1 (шапка не считается). */
		rowNo: integer().notNull(),
		/**
		 * К кому относится строка. Пусто у строки, которую не удалось отнести
		 * ни к одной записи справочника, — такая строка неверна и в показатели
		 * не попадает, но остаётся видна вместе со своей претензией.
		 */
		organizationId: uuid().references(() => organizations.id, { onDelete: 'restrict' }),
		siteId: uuid().references(() => sites.id, { onDelete: 'restrict' }),
		programId: uuid().references(() => programs.id, { onDelete: 'restrict' }),
		periodStart: date().notNull(),
		periodEnd: date().notNull(),
		/**
		 * Показатели строки. `null` — колонки не было или значение не разобралось;
		 * ноль — это заполненный ноль, и отчёт обязан отличать одно от другого.
		 */
		applications: integer(),
		enrolled: integer(),
		parallelStreams: integer(),
		completed: integer(),
		coveragePlan: integer(),
		coverageFact: integer(),
		/** Строка файла как есть: колонка → значение. */
		raw: jsonb().$type<Record<string, string>>().notNull().default({}),
		/** Претензии к строке: `[{field, message}]`. */
		issues: jsonb().$type<StatRowIssue[]>().notNull().default([]),
		isValid: boolean().notNull().default(false),
		/** Версия строки: исправление заводит следующую. */
		version: integer().notNull().default(1),
		/** Строку заменило исправление — в показателях она больше не участвует. */
		replacedByRowId: uuid().references((): AnyPgColumn => statRows.id, { onDelete: 'set null' }),
		...timestamps
	},
	(table) => [
		uniqueIndex('stat_rows_snapshot_row_key').on(table.snapshotId, table.rowNo),
		index('stat_rows_program_period_idx').on(table.programId, table.periodStart),
		index('stat_rows_organization_period_idx').on(table.organizationId, table.periodStart),
		check('stat_rows_period_ordered', sql`${table.periodEnd} >= ${table.periodStart}`),
		// Строка, которую не к чему отнести, не может быть верной: показатель
		// складывается по программе и организации, и без них складывать нечего.
		check(
			'stat_rows_valid_is_attributed',
			sql`not ${table.isValid} or (${table.organizationId} is not null and ${table.programId} is not null)`
		)
	]
);

/**
 * Показатели по программе, организации и периоду.
 *
 * Представление создаётся custom-миграцией (`.existing()` означает «Drizzle про
 * него знает, но не управляет им»): складываются только строки подтверждённых
 * текущих снимков, не заменённые исправлением. `sum` в PostgreSQL пропускает
 * `NULL` и отдаёт `NULL`, когда складывать нечего, — ровно этим ноль и
 * отсутствие данных здесь и различаются.
 */
export const statProgramIndicators = pgView('stat_program_indicators', {
	programId: uuid().notNull(),
	organizationId: uuid().notNull(),
	periodKind: statPeriodKindEnum().notNull(),
	periodStart: date().notNull(),
	periodEnd: date().notNull(),
	applications: integer(),
	enrolled: integer(),
	parallelStreams: integer(),
	completed: integer(),
	coveragePlan: integer(),
	coverageFact: integer(),
	rowCount: integer().notNull(),
	snapshotCount: integer().notNull(),
	lastConfirmedAt: timestamp({ withTimezone: true })
}).existing();

export const statSnapshotsRelations = relations(statSnapshots, ({ one, many }) => ({
	fileDocument: one(documents, {
		fields: [statSnapshots.fileDocumentId],
		references: [documents.id]
	}),
	author: one(users, { fields: [statSnapshots.createdBy], references: [users.id] }),
	rows: many(statRows)
}));

export const statRowsRelations = relations(statRows, ({ one }) => ({
	snapshot: one(statSnapshots, {
		fields: [statRows.snapshotId],
		references: [statSnapshots.id]
	}),
	organization: one(organizations, {
		fields: [statRows.organizationId],
		references: [organizations.id]
	}),
	site: one(sites, { fields: [statRows.siteId], references: [sites.id] }),
	program: one(programs, { fields: [statRows.programId], references: [programs.id] })
}));
