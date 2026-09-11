/**
 * Каталог прав и роли по умолчанию.
 *
 * Право — это одно действие, а не раздел интерфейса: так одно и то же правило
 * работает и для страницы, и для эндпоинта API, и для экспорта. Список здесь —
 * единственный источник истины: из него сидируются таблицы `permissions` и
 * `role_permissions`, им же типизируется `can()`.
 */

export const PERMISSIONS = {
	'organizations.read': 'Просмотр организаций и площадок',
	'organizations.write': 'Создание и изменение организаций и площадок',
	'people.read': 'Просмотр людей и их ролей в организациях',
	'people.write': 'Создание и изменение людей и их ролей',
	'people.read_pii': 'Просмотр контактов людей без маскирования',
	'programs.read': 'Просмотр образовательных программ',
	'programs.write': 'Создание и изменение образовательных программ',
	'products.read': 'Просмотр продуктов',
	'products.write': 'Создание и изменение продуктов',
	'interactions.read': 'Просмотр взаимодействий',
	'interactions.write': 'Создание и изменение взаимодействий',
	'stages.transition': 'Перевод взаимодействия по стадиям',
	'stages.configure': 'Настройка маршрутов и стадий',
	'documents.read': 'Просмотр и скачивание документов',
	'documents.write': 'Загрузка документов и отметки по ним',
	'documents.generate': 'Генерация документов по шаблонам',
	'audit.read': 'Просмотр журнала действий',
	'audit.export': 'Выгрузка журнала действий',
	'settings.write': 'Изменение настроек приложения',
	'users.manage': 'Управление пользователями и ролями',
	'api_keys.manage': 'Управление ключами доступа к API'
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

export type RoleDefinition = {
	id: string;
	name: string;
	description: string;
	permissions: readonly PermissionKey[];
};

/** Все права, кроме перечисленных. */
function allExcept(...excluded: PermissionKey[]): PermissionKey[] {
	const drop = new Set<PermissionKey>(excluded);
	return PERMISSION_KEYS.filter((key) => !drop.has(key));
}

/**
 * Роли, с которыми система приезжает к заказчику. Их сидируют миграции данных
 * и тесты; интерфейс управления ролями работает поверх этого же набора.
 *
 * `viewer` не получает `audit.read`: журнал — инструмент администратора, а не
 * часть картины процесса. Иначе роль «только смотреть» знала бы о системе
 * больше, чем роль, которая в ней работает.
 */
export const DEFAULT_ROLES: readonly RoleDefinition[] = [
	{
		id: 'admin',
		name: 'Администратор',
		description: 'Полный доступ, включая настройки, пользователей и журнал',
		permissions: PERMISSION_KEYS
	},
	{
		id: 'manager',
		name: 'Менеджер',
		description: 'Ведёт справочники, взаимодействия и документы',
		permissions: allExcept(
			'stages.configure',
			'audit.read',
			'audit.export',
			'settings.write',
			'users.manage',
			'api_keys.manage'
		)
	},
	{
		id: 'viewer',
		name: 'Наблюдатель',
		description: 'Только просмотр, без контактов людей',
		permissions: PERMISSION_KEYS.filter((key) => key.endsWith('.read') && key !== 'audit.read')
	}
];
