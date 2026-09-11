/**
 * Столбцы, которые повторяются почти в каждой таблице, объявлены один раз.
 *
 * Соглашения схемы: идентификаторы — `uuid` с `gen_random_uuid()`, моменты
 * времени — `timestamptz`, календарные даты (учебные и договорные) — `date`.
 * Имена в TypeScript camelCase, в PostgreSQL snake_case: за перевод отвечает
 * `casing: 'snake_case'` в `drizzle.config.ts` и в `drizzle()`.
 */
import { sql } from 'drizzle-orm';
import { text, timestamp, uniqueIndex, type PgColumn } from 'drizzle-orm/pg-core';

/** Когда запись появилась и когда её последний раз меняли. */
export const timestamps = {
	createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow()
};

/** Для связующих таблиц: менять в них нечего, важно только когда связали. */
export const createdAt = {
	createdAt: timestamp({ withTimezone: true }).notNull().defaultNow()
};

/**
 * Ссылка на запись во внешней системе. Пара «источник + идентификатор» —
 * основа идемпотентного импорта: повторная загрузка той же выгрузки обновляет
 * запись, а не создаёт дубль.
 */
export const externalRef = {
	externalSource: text(),
	externalId: text()
};

/**
 * Частичная уникальность внешней ссылки: строки без источника не мешают друг
 * другу, а одна и та же запись внешней системы не может попасть в базу дважды.
 */
export function externalRefUnique(
	name: string,
	columns: { externalSource: PgColumn; externalId: PgColumn }
) {
	return uniqueIndex(name)
		.on(columns.externalSource, columns.externalId)
		.where(sql`${columns.externalSource} is not null`);
}
