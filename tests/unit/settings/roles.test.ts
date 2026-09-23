/**
 * Группировка прав страницы «Роли и права» против каталога прав.
 *
 * Группировка своя (`../../../src/routes/(app)/settings/roles/permission-groups`)
 * и не выводится типом из каталога (`$lib/server/rbac/permissions`): право,
 * заведённое в коде и забытое здесь, не сломает сборку — оно просто пропадёт из
 * таблицы молча. Эта проверка ловит именно такой пропуск, а не опечатку в
 * названии раздела.
 */
import { describe, expect, it } from 'vitest';
import { PERMISSION_KEYS } from '$lib/server/rbac/permissions';
import {
	groupedPermissionKeys,
	PERMISSION_GROUPS,
	ungroupedPermissionKeys
} from '../../../src/routes/(app)/settings/roles/permission-groups';

describe('группы прав страницы «Роли и права»', () => {
	it('называют раздел для каждого права из каталога и не выдумывают лишних', () => {
		expect(ungroupedPermissionKeys()).toEqual([]);
		expect([...groupedPermissionKeys()].sort()).toEqual([...PERMISSION_KEYS].sort());
	});

	it('не называют одно право дважды', () => {
		const grouped = groupedPermissionKeys();

		expect(new Set(grouped).size).toBe(grouped.length);
	});

	it('не оставляют раздел пустым', () => {
		for (const group of PERMISSION_GROUPS) {
			expect(group.permissions.length, group.key).toBeGreaterThan(0);
		}
	});

	it('не повторяют ключ раздела', () => {
		const keys = PERMISSION_GROUPS.map((group) => group.key);

		expect(new Set(keys).size).toBe(keys.length);
	});
});
