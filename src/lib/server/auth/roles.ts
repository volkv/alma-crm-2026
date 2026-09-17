/**
 * Роли realm → роли системы.
 *
 * Таблица одна и закрытая: набор ролей сужается вместе с кодом, а не вместе с
 * содержимым каталога. Незнакомая роль realm игнорируется — так же, как
 * `loadRolePermissions` игнорирует право, которого больше нет в каталоге прав.
 *
 * Правила и обоснование — `docs/access-matrix.md`, раздел 6.
 */

/** Отображение имён realm на идентификаторы наших ролей. */
const REALM_ROLE_MAP: Readonly<Record<string, string>> = {
	'crm-admin': 'admin',
	'crm-lead': 'lead',
	'crm-user': 'manager'
};

/**
 * Старшинство: при нескольких ролях берётся старшая. Realm может законно выдать
 * и `crm-lead`, и `crm-user` — руководителю, который ведёт свои вузы сам, — и
 * отказ в такой ситуации выглядел бы как поломка каталога.
 */
const ROLE_SENIORITY: readonly string[] = ['admin', 'lead', 'manager'];

/**
 * Роль системы по ролям realm, или `null`, если ни одной известной среди них
 * нет. `null` — это отказ во входе: пользователь без роли нам не сотрудник, и
 * локальная запись под него не заводится.
 */
export function mapRealmRoles(realmRoles: readonly string[]): string | null {
	const granted = new Set<string>();

	for (const realmRole of realmRoles) {
		const mapped = REALM_ROLE_MAP[realmRole];

		if (mapped !== undefined) {
			granted.add(mapped);
		}
	}

	return ROLE_SENIORITY.find((role) => granted.has(role)) ?? null;
}
