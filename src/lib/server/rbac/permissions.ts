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
	'responsibles.manage': 'Назначение и смена ответственных за вузы',
	'people.read': 'Просмотр людей и их ролей в организациях',
	'people.write': 'Создание и изменение людей и их ролей',
	'people.read_pii': 'Просмотр контактов людей без маскирования',
	'people.manage_consents': 'Учёт согласий на обработку персональных данных и сроков хранения',
	'people.anonymize': 'Обезличивание персональных данных по истечении срока хранения',
	'directions.read': 'Просмотр ИТ-направлений',
	'directions.write': 'Создание и изменение ИТ-направлений',
	'programs.read': 'Просмотр образовательных программ',
	'programs.write': 'Создание и изменение образовательных программ',
	'products.read': 'Просмотр продуктов',
	'products.write': 'Создание и изменение продуктов',
	'interactions.read': 'Просмотр взаимодействий',
	'interactions.write': 'Создание и изменение взаимодействий',
	'interactions.reassign': 'Смена владельца взаимодействия',
	'stages.transition': 'Перевод взаимодействия по стадиям',
	'stages.confirm': 'Подтверждение стадии результатом или файлом',
	'stages.configure': 'Настройка маршрутов и стадий',
	'documents.read': 'Просмотр и скачивание документов',
	'documents.write': 'Загрузка документов и отметки по ним',
	'documents.generate': 'Генерация документов по шаблонам',
	'stats.read': 'Просмотр данных об обучении и показателей',
	'stats.import': 'Загрузка, проверка и подтверждение данных об обучении',
	'audit.read': 'Просмотр журнала действий',
	'audit.export': 'Выгрузка журнала действий',
	'settings.write': 'Изменение настроек приложения',
	'users.manage': 'Управление пользователями и ролями',
	'api_keys.manage': 'Управление ключами доступа к API',
	'integrations.manage': 'Настройка вебхуков и интеграций с внешними системами',
	'integrations.manage_endpoints': 'Внешние адреса и секреты подключений',
	'exchange.intake': 'Приём заявки с сайта',
	'exchange.results': 'Приём результата учебной группы',
	'exchange.send': 'Отправка учебной группы в систему обучения'
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
 * Порядок ролей — от старшей к младшей: им же отсортированы кнопки входа на
 * стенде и список ролей в настройках.
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
		id: 'lead',
		name: 'Руководитель',
		description: 'Ведёт свою область, назначает ответственных и видит работу подчинённых',
		permissions: allExcept(
			'people.anonymize',
			'stages.configure',
			'settings.write',
			'users.manage',
			'api_keys.manage',
			'integrations.manage',
			'integrations.manage_endpoints',
			'exchange.intake',
			'exchange.results'
		)
	},
	{
		id: 'manager',
		name: 'Менеджер',
		description: 'Ведёт справочники, взаимодействия и документы',
		permissions: allExcept(
			'directions.write',
			'responsibles.manage',
			'interactions.reassign',
			'stages.configure',
			'audit.read',
			'audit.export',
			'settings.write',
			'users.manage',
			'api_keys.manage',
			'integrations.manage',
			'integrations.manage_endpoints',
			'exchange.intake',
			'exchange.results'
		)
	},
	{
		id: 'viewer',
		name: 'Наблюдатель',
		description: 'Только просмотр, без контактов людей',
		permissions: PERMISSION_KEYS.filter((key) => key.endsWith('.read') && key !== 'audit.read')
	},
	{
		/**
		 * Машинный субъект: от его имени работают ключи обмена CMS и LMS.
		 *
		 * Роль **невходящая** — учётная запись с ней не проходит вход ни при
		 * каких утверждениях токена. Привязать ключ обмена к сотруднику значило
		 * бы отдать чужой системе его права и его область, а живого владельца у
		 * ключа нет вовсе.
		 *
		 * Набор прав закрытый и перечислен целиком: подтвердить стадию и двигать
		 * взаимодействие — разные полномочия, и внешняя система имеет только
		 * первое.
		 */
		id: 'service',
		name: 'Внешняя система',
		description: 'Ключи обмена с CMS и системой обучения; входить в систему не может',
		permissions: ['exchange.intake', 'exchange.results', 'stages.confirm']
	}
];
