/**
 * Коммерческие условия дела: стоимость обучения.
 *
 * Отдельной таблицей, а не колонкой взаимодействия: условия ведёт модуль
 * «Оплата», и правка стоимости не должна двигать версию плана — две вкладки,
 * где одна меняет сроки, а другая стоимость, не мешают друг другу. Своя версия
 * строки ловит две правки самой стоимости.
 *
 * Стоимость — в копейках целым числом: деньги в плавающей точке не хранят, а
 * `numeric` приезжает в приложение строкой. Валюта одна — рубли; колонка
 * стоит, чтобы стоимость в базе читалась без знания о приложении, и проверкой
 * держит единственное значение.
 */
import { sql } from 'drizzle-orm';
import { bigint, check, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { interactions } from './interactions';
import { timestamps } from './shared';

export const interactionTerms = pgTable(
	'interaction_terms',
	{
		interactionId: uuid()
			.primaryKey()
			.references(() => interactions.id, { onDelete: 'cascade' }),
		/** Стоимость в копейках; `null` — стоимость сняли, строка осталась ради версии. */
		priceKopecks: bigint({ mode: 'number' }),
		currency: text().notNull().default('RUB'),
		version: integer().notNull().default(1),
		updatedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
		...timestamps
	},
	(table) => [
		check(
			'interaction_terms_price_nonnegative',
			sql`${table.priceKopecks} is null or ${table.priceKopecks} >= 0`
		),
		check('interaction_terms_currency_rub', sql`${table.currency} = 'RUB'`)
	]
);
