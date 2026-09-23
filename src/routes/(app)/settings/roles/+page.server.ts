import { error } from '@sveltejs/kit';
import { actorFromEvent } from '$lib/server/actor';
import { can, loadRolePermissions } from '$lib/server/rbac';
import { DEFAULT_ROLES, PERMISSIONS } from '$lib/server/rbac/permissions';
import { PERMISSION_GROUPS } from './permission-groups';
import type { PageServerLoad } from './$types';

/**
 * «Роли и права»: только чтение. Показывает эксперту жюри и любому
 * администратору, кто что может, — без чтения кода.
 *
 * Матрица не хардкод: набор прав каждой роли читается из `role_permissions`
 * тем же `loadRolePermissions`, которым `can()` проверяет доступ на каждом
 * запросе, — страница обязана показывать то, что действует, а не то, что
 * когда-то задумывалось. Каталог ролей (порядок, имя, описание) при этом берут
 * из кода (`DEFAULT_ROLES`): это те же четыре роли, которыми сидируется база,
 * и их состав не меняется без релиза.
 *
 * Право экрана — то же, что у раздела «Пользователи» (`users.manage`): страница
 * говорит о том же предмете, что и список сотрудников, и отдельного права под
 * неё заводить незачем.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	if (!can(ctx, 'users.manage')) {
		error(403, 'Раздел доступен только с правом «Управление пользователями и ролями»');
	}

	const roles = await Promise.all(
		DEFAULT_ROLES.map(async (role) => ({
			id: role.id,
			name: role.name,
			description: role.description,
			isService: role.id === 'service',
			permissions: [...(await loadRolePermissions(role.id))]
		}))
	);

	const groups = PERMISSION_GROUPS.map((group) => ({
		key: group.key,
		label: group.label,
		permissions: group.permissions.map((key) => ({ key, label: PERMISSIONS[key] }))
	}));

	return { roles, groups };
};
