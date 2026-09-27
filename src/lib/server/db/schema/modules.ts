/**
 * Модули, включённые пространству.
 *
 * Строка есть — модуль включён явно; выключение удаляет строку. Действуют в
 * пространстве не только включённые: модуль, нужный стадии действующей
 * редакции, действует и без строки (`$lib/server/platform/workspace-modules`),
 * поэтому пространство, заведённое прямым SQL без единой строки здесь, всё
 * равно получает обучение, если его процесс подтверждает стадию данными LMS.
 *
 * Ключ модуля проверяется только по формату, а не по каталогу: каталог задаёт
 * конфиг установки (`crm.config.ts`), и проверка по нему в базе требовала бы
 * миграцию на каждый модуль. Строка модуля, которого в установке больше нет,
 * молча не действует.
 *
 * Данные самих модулей — договоры, потоки, отметки об оплате — выключение не
 * трогает: модуль включают обратно, и работа на месте.
 */
import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { workspaces } from './interactions';

export const workspaceModules = pgTable(
	'workspace_modules',
	{
		// `cascade`: пространство удаляют только вместе с его устройством —
		// так уходит пространство сценария e2e после прогона.
		workspaceId: uuid()
			.notNull()
			.references(() => workspaces.id, { onDelete: 'cascade' }),
		moduleKey: text().notNull(),
		/**
		 * Настройки модуля в пространстве. Пока ни одному модулю не нужны; когда
		 * понадобятся, выключение станет отметкой, а не удалением строки, чтобы
		 * настройки его пережили.
		 */
		settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
		enabledAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		/** Кто включил; `null` — включила миграция или сброс стенда. */
		enabledBy: uuid().references(() => users.id, { onDelete: 'set null' })
	},
	(table) => [
		primaryKey({ columns: [table.workspaceId, table.moduleKey] }),
		check('workspace_modules_key_format', sql`${table.moduleKey} ~ '^[a-z][a-z0-9-]{1,31}$'`)
	]
);
