/**
 * Статьи справки, на которые ссылаются экраны реестра. Заголовок лежит копией и
 * сверяется проверкой с самой статьёй: импорт `$lib/help/index` в шапку утащил
 * бы весь корпус руководств в браузер.
 */
export const HELP_START = { section: 'user', page: 'start', title: 'Вход и первый экран' } as const;
export const HELP_INTERACTIONS = {
	section: 'user',
	page: 'interactions',
	title: 'Список и доска взаимодействий'
} as const;
export const HELP_INTERACTION = {
	section: 'user',
	page: 'interaction',
	title: 'Карточка взаимодействия'
} as const;
export const HELP_DOCUMENTS = { section: 'user', page: 'documents', title: 'Документы' } as const;
export const HELP_DIRECTORY = {
	section: 'user',
	page: 'directory',
	title: 'Организации, контакты и ответственные'
} as const;
export const HELP_CATALOG_IMPORT = {
	section: 'user',
	page: 'catalog-import',
	title: 'Импорт каталога'
} as const;
export const HELP_PROGRAMS = {
	section: 'user',
	page: 'programs',
	title: 'Программы, продукты и направления'
} as const;
export const HELP_REPORTS = { section: 'user', page: 'reports', title: 'Отчёты' } as const;
export const HELP_DATA = { section: 'user', page: 'data', title: 'Данные об обучении' } as const;
export const HELP_AUTOMATION = {
	section: 'user',
	page: 'automation',
	title: 'Карта автоматизации'
} as const;
export const HELP_PROCESS = { section: 'admin', page: 'process', title: 'Процесс' } as const;
export const HELP_USERS = {
	section: 'admin',
	page: 'users',
	title: 'Пользователи и роли'
} as const;
export const HELP_ROLES = {
	section: 'admin',
	page: 'roles',
	title: 'Роли и права'
} as const;
export const HELP_ACCESS = {
	section: 'admin',
	page: 'access',
	title: 'Права и граница демонстрации'
} as const;
export const HELP_INTEGRATIONS = {
	section: 'admin',
	page: 'integrations',
	title: 'Интеграции'
} as const;
export const HELP_EXCHANGE = {
	section: 'admin',
	page: 'exchange',
	title: 'Обмен с внешними системами'
} as const;
export const HELP_AUDIT = { section: 'admin', page: 'audit', title: 'Журнал действий' } as const;
export const HELP_SETTINGS = {
	section: 'admin',
	page: 'settings',
	title: 'Настройки и сброс демо-данных'
} as const;
export const HELP_NOTIFICATIONS = {
	section: 'admin',
	page: 'notifications',
	title: 'Уведомления'
} as const;
