/**
 * Права каталога (`$lib/server/rbac/permissions`), разложенные по разделам с
 * человеческими названиями — для страницы «Роли и права». Подпись самого права
 * уже есть в коде (`PERMISSIONS[key]`); здесь заводится только группировка,
 * которой в продукте раньше не было.
 *
 * Порядок и границы разделов повторяют `docs/access-matrix.md` (раздел 3):
 * эксперт, сверяющий страницу с документом, находит те же названия.
 *
 * Полноту держит `tests/unit/settings/roles.test.ts`: право, заведённое в
 * каталоге и забытое здесь, роняет проверку, а не остаётся молча без строки в
 * таблице.
 */
import { PERMISSION_KEYS, type PermissionKey } from '$lib/server/rbac/permissions';

export type PermissionGroup = {
	/** Ключ раздела: только для `each`-блока и тестов, на экране не показан. */
	key: string;
	label: string;
	permissions: readonly PermissionKey[];
};

export const PERMISSION_GROUPS: readonly PermissionGroup[] = [
	{
		key: 'organizations',
		label: 'Вузы, площадки и договоры',
		permissions: [
			'organizations.read',
			'organizations.write',
			'responsibles.manage',
			'directory.import'
		]
	},
	{
		key: 'catalog',
		label: 'Каталоги: направления, продукты, программы',
		permissions: [
			'directions.read',
			'directions.write',
			'programs.read',
			'programs.write',
			'products.read',
			'products.write'
		]
	},
	{
		key: 'interactions',
		label: 'Взаимодействия',
		permissions: [
			'interactions.read',
			'interactions.write',
			'interactions.reassign',
			'stages.transition',
			'stages.confirm'
		]
	},
	{
		key: 'documents',
		label: 'Документы и файлы',
		permissions: ['documents.read', 'documents.write', 'documents.generate']
	},
	{
		key: 'people',
		label: 'Люди и персональные данные',
		permissions: [
			'people.read',
			'people.write',
			'people.read_pii',
			'people.manage_consents',
			'people.anonymize'
		]
	},
	{
		key: 'process',
		label: 'Процесс',
		permissions: ['stages.configure']
	},
	{
		key: 'stats',
		label: 'Данные об обучении и дашборд',
		permissions: ['stats.read', 'stats.import']
	},
	{
		key: 'integrations',
		label: 'Интеграции и обмен',
		permissions: [
			'integrations.manage',
			'integrations.manage_endpoints',
			'exchange.intake',
			'exchange.results',
			'exchange.send'
		]
	},
	{
		key: 'admin',
		label: 'Журнал, настройки, пользователи, ключи',
		permissions: ['audit.read', 'audit.export', 'settings.write', 'users.manage', 'api_keys.manage']
	},
	{
		key: 'notifications',
		label: 'Уведомления',
		permissions: ['notifications.read', 'notifications.manage']
	}
];

/** Все права, названные хотя бы одной группой — без раздела и без повторов. */
export function groupedPermissionKeys(): readonly PermissionKey[] {
	return PERMISSION_GROUPS.flatMap((group) => group.permissions);
}

/** Право каталога, для которого не нашлось раздела. Пусто, когда группировка полна. */
export function ungroupedPermissionKeys(): readonly PermissionKey[] {
	const grouped = new Set(groupedPermissionKeys());

	return PERMISSION_KEYS.filter((key) => !grouped.has(key));
}
