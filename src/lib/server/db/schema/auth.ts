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
	check,
	index,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	type AnyPgColumn
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
		/**
		 * Руководитель сотрудника. На этой иерархии держатся сразу две вещи:
		 * область доступа руководителя (его подчинённые и их вузы) и адрес
		 * эскалации зависшего взаимодействия. Считать их по-разному значило бы
		 * завести в системе две иерархии, которые однажды разойдутся.
		 */
		managerUserId: uuid().references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
		/**
		 * Идентификатор субъекта во внешнем каталоге пользователей (`sub` токена).
		 * Пуст, пока запись ни разу не входила через него: связывание идёт при
		 * первом входе по подтверждённой почте.
		 */
		externalSubject: text(),
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
		uniqueIndex('users_email_lower_key').on(sql`lower(${table.email})`),
		// Один субъект внешнего каталога — одна учётная запись. Частичная, потому
		// что записей без внешнего субъекта в базе сколько угодно.
		uniqueIndex('users_external_subject_key')
			.on(table.externalSubject)
			.where(sql`${table.externalSubject} is not null`),
		index('users_manager_idx').on(table.managerUserId),
		// Сам себе руководитель — цикл длиной один: замыкание подчинённых на нём
		// не кончается, а эскалация уходит тому, кто её и поднял.
		check('users_manager_not_self', sql`${table.managerUserId} <> ${table.id}`)
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

export const usersRelations = relations(users, ({ one, many }) => ({
	role: one(roles, { fields: [users.roleId], references: [roles.id] }),
	manager: one(users, {
		fields: [users.managerUserId],
		references: [users.id],
		relationName: 'user_manager'
	}),
	reports: many(users, { relationName: 'user_manager' })
}));
