/**
 * Главное меню против прав.
 *
 * Раздел, на который у человека нет права, отвечает 403 — показывать на него
 * ссылку значит обещать то, чего учётная запись не может. Проверяется именно
 * фильтр: он один на боковую панель и на выдвижную навигацию телефона.
 */
import { describe, expect, it } from 'vitest';
import { navSections, visibleSections } from '$lib/nav';
import { DEFAULT_ROLES, PERMISSIONS } from '$lib/server/rbac/permissions';

/** Права роли из каталога — те же, что сидируются в базу. */
function permissionsOf(roleId: string): ReadonlySet<string> {
	const role = DEFAULT_ROLES.find((candidate) => candidate.id === roleId);

	if (role === undefined) {
		throw new Error(`Роль «${roleId}» не заведена в каталоге`);
	}

	return new Set<string>(role.permissions);
}

function labels(permissions: ReadonlySet<string>): string[] {
	return visibleSections(navSections, permissions).map((section) => section.label);
}

describe('разделы меню', () => {
	it('называют право из каталога или не требуют никакого', () => {
		for (const section of navSections) {
			if (section.permission !== null) {
				expect(PERMISSIONS).toHaveProperty(section.permission);
			}
		}
	});

	it('открыты администратору целиком', () => {
		expect(labels(permissionsOf('admin'))).toEqual(navSections.map((section) => section.label));
	});

	it('прячут журнал от роли без права на него', () => {
		const menu = labels(permissionsOf('manager'));

		expect(menu).not.toContain('Журнал');
		expect(menu).toContain('Взаимодействия');
	});

	it('оставляют «Настройки» даже без единого права: свой профиль есть у каждого', () => {
		expect(labels(new Set())).toEqual(['Настройки']);
	});

	it('оставляют наблюдателю всё, кроме журнала, и в том же порядке', () => {
		expect(labels(permissionsOf('viewer'))).toEqual([
			'Взаимодействия',
			'Организации',
			'Контакты',
			'Программы',
			'Продукты',
			'Данные',
			'Документы',
			'Настройки'
		]);
	});
});
