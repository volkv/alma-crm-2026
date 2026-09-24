import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from '$lib/server/db/schema';
import { DEMO_DATA_TABLES } from '$lib/server/demo/reset';

/**
 * Сброс опустошает таблицы одной командой `TRUNCATE` без `CASCADE`, и PostgreSQL
 * отказывает ей, если на опустошаемую таблицу ссылается таблица вне списка.
 * Узнать об этом на стенде значит получить сломанную кнопку, поэтому то же
 * правило сверяется со схемой здесь.
 */
describe('список таблиц сброса демонстрационных данных', () => {
	it('включает каждую таблицу, которая ссылается на стираемые', () => {
		const cleared = new Set<string>(DEMO_DATA_TABLES);
		const tables = Object.values(schema).filter((value) => value instanceof PgTable);
		const missing = new Set<string>();

		for (const table of tables) {
			const config = getTableConfig(table);

			for (const foreignKey of config.foreignKeys) {
				const target = getTableConfig(foreignKey.reference().foreignTable).name;

				if (cleared.has(target) && !cleared.has(config.name)) {
					missing.add(`${config.name} → ${target}`);
				}
			}
		}

		expect(tables.length).toBeGreaterThan(cleared.size);
		expect([...missing]).toStrictEqual([]);
	});
});
