/**
 * Пользователи, роли и права.
 *
 * Права — плоский список кодов; роль раздаёт набор кодов; пользователь имеет
 * ровно одну роль. Ни пароля, ни второго фактора здесь нет и быть не может:
 * тем, чем человек доказывает, что он это он, ведает внешний каталог учётных
 * записей, а у нас от него остаётся только `external_subject` (`docs/auth.md`).
 */
import { relations } from 'drizzle-orm';
import {
	boolean,
	check,
	index,
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
		isActive: boolean().notNull().default(true),
		/**
		 * Учётная запись публичной демонстрации: граница демо-стенда. Пока
		 * `DEMO_MODE` включён, такую запись нельзя выключить, а открытая ею сессия
		 * не получает прав из `DEMO_DENIED_PERMISSIONS` (см. `$lib/server/rbac`).
		 * При выключенном режиме столбец ни на что не влияет: это обычная учётная
		 * запись.
		 */
		isDemo: boolean().notNull().default(false),
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
