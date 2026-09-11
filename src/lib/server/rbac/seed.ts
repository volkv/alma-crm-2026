/**
 * Заливка каталога прав и ролей по умолчанию в базу.
 *
 * Операция идемпотентна: её можно выполнять на каждом развёртывании. Набор
 * прав роли приводится к тому, что записано в коде, — иначе отозванное в коде
 * право осталось бы выданным в базе.
 */
import { eq, notInArray, sql } from 'drizzle-orm';
import { permissions, rolePermissions, roles } from '../db/schema';
import type { Tx } from '../db/transaction';
import { invalidateRoleCache } from './index';
import { DEFAULT_ROLES, PERMISSIONS, PERMISSION_KEYS } from './permissions';

export async function seedRolesAndPermissions(tx: Tx): Promise<void> {
	await tx
		.insert(permissions)
		.values(PERMISSION_KEYS.map((key) => ({ key, description: PERMISSIONS[key] })))
		.onConflictDoUpdate({
			target: permissions.key,
			set: { description: sql`excluded.description` }
		});

	await tx.delete(permissions).where(notInArray(permissions.key, PERMISSION_KEYS));

	for (const role of DEFAULT_ROLES) {
		await tx
			.insert(roles)
			.values({ id: role.id, name: role.name, description: role.description, isSystem: true })
			.onConflictDoUpdate({
				target: roles.id,
				set: { name: sql`excluded.name`, description: sql`excluded.description`, isSystem: true }
			});

		await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, role.id));

		await tx
			.insert(rolePermissions)
			.values(role.permissions.map((key) => ({ roleId: role.id, permissionKey: key })));
	}

	await tx.delete(roles).where(
		notInArray(
			roles.id,
			DEFAULT_ROLES.map((role) => role.id)
		)
	);

	invalidateRoleCache();
}

/** Права роли из кода — то же, что окажется в базе после `seedRolesAndPermissions`. */
export function defaultRolePermissions(roleId: string): ReadonlySet<string> {
	const role = DEFAULT_ROLES.find((candidate) => candidate.id === roleId);
	if (role === undefined) {
		throw new Error(`Роль «${roleId}» не описана в каталоге ролей`);
	}

	return new Set(role.permissions);
}
