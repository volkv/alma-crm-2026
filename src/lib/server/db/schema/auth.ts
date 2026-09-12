/**
 * Пользователи, роли и права.
 *
 * Права — плоский список кодов; роль раздаёт набор кодов; пользователь имеет
 * ровно одну роль. Счётчиков неудачных входов и блокировок здесь нет: они
 * живут в Redis, потому что это состояние попытки, а не факт о пользователе.
 */
import { relations } from 'drizzle-orm';
import {
	boolean,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { timestamps } from './shared';

/** Справочник прав. Ключ совпадает с константой в `$lib/server/rbac`. */
export const permissions = pgTable('permissions', {
	key: text().primaryKey(),
	description: text().notNull(),
	...timestamps
});

export const roles = pgTable('roles', {
	id: text().primaryKey(),
	name: text().notNull(),
	description: text().notNull(),
	/** Системную роль нельзя удалить из интерфейса: на ней держится доступ. */
	isSystem: boolean().notNull().default(false),
	...timestamps
});

export const rolePermissions = pgTable(
	'role_permissions',
	{
		roleId: text()
			.notNull()
			.references(() => roles.id, { onDelete: 'cascade' }),
		permissionKey: text()
			.notNull()
			.references(() => permissions.key, { onDelete: 'cascade' })
	},
	(table) => [primaryKey({ columns: [table.roleId, table.permissionKey] })]
);

export const users = pgTable(
	'users',
	{
		id: uuid().primaryKey().defaultRandom(),
		email: text().notNull(),
		fullName: text().notNull(),
		roleId: text()
			.notNull()
			.references(() => roles.id, { onDelete: 'restrict' }),
		/** Argon2id. Алгоритм и параметры — забота модуля аутентификации. */
		passwordHash: text().notNull(),
		passwordChangedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		isActive: boolean().notNull().default(true),
		/**
		 * Учётная запись публичной демонстрации. Пока `DEMO_MODE` включён, она
		 * входит без пароля, не выключается, а открытая ею сессия не получает прав
		 * из `demoSessionPermissions` (см. `$lib/server/rbac`). При выключенном
		 * режиме столбец ни на что не влияет: это обычная учётная запись.
		 */
		isDemo: boolean().notNull().default(false),
		/**
		 * Секрет второго фактора в base32 (TOTP, RFC 6238). Лежит как есть:
		 * проверка кода требует самого секрета, поэтому хеш здесь невозможен, а
		 * шифровать его нечем — ключ пришлось бы держать рядом, в том же
		 * приложении. Граница проходит по доступу к базе: наружу — ни в API, ни
		 * в интерфейс, ни в журнал — секрет не выходит никогда.
		 */
		totpSecret: text(),
		/** Когда фактор подтвердили кодом. `null` — фактора у записи нет. */
		totpEnabledAt: timestamp({ withTimezone: true }),
		/**
		 * Резервные коды: SHA-256 от каждого, использованный удаляется из списка.
		 * Медленный хеш здесь не нужен — коды случайные и длинные, перебирать их
		 * нечем, — а рядом в той же строке всё равно лежит секрет, из которого
		 * коды и восстанавливаются. Подробно — `docs/auth.md`.
		 */
		totpBackupCodes: jsonb().$type<string[]>(),
		lastLoginAt: timestamp({ withTimezone: true }),
		deactivatedAt: timestamp({ withTimezone: true }),
		...timestamps
	},
	(table) => [
		// Почта уникальна без учёта регистра: «Ivanov@» и «ivanov@» — один человек.
		uniqueIndex('users_email_lower_key').on(sql`lower(${table.email})`)
	]
);

export const rolesRelations = relations(roles, ({ many }) => ({
	permissions: many(rolePermissions),
	users: many(users)
}));

export const permissionsRelations = relations(permissions, ({ many }) => ({
	roles: many(rolePermissions)
}));

export const rolePermissionsRelations = relations(rolePermissions, ({ one }) => ({
	role: one(roles, { fields: [rolePermissions.roleId], references: [roles.id] }),
	permission: one(permissions, {
		fields: [rolePermissions.permissionKey],
		references: [permissions.key]
	})
}));

export const usersRelations = relations(users, ({ one }) => ({
	role: one(roles, { fields: [users.roleId], references: [roles.id] })
}));
