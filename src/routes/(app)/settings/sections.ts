/**
 * Подразделы настроек и право, которое их открывает.
 *
 * Список один на заголовок раздела и на проверку доступа: подраздел, которого
 * человек не видит, обязан отвечать отказом и по прямой ссылке. Разойтись этим
 * двум ответам нельзя — поэтому они читают одну таблицу.
 *
 * Те же подразделы стоят пунктами главного меню (`$lib/nav`) со своими
 * значками, и права там обязаны совпадать с правами отсюда — за этим следит
 * `tests/unit/nav.test.ts`.
 */
import type { PermissionKey } from '$lib/server/rbac/permissions';

export type SettingsHref =
	| '/settings/profile'
	| '/settings/users'
	| '/settings/api-keys'
	| '/settings/general'
	| '/settings/workspaces'
	| '/settings/workflows'
	| '/settings/integrations';

export type SettingsSection = {
	href: SettingsHref;
	label: string;
	description: string;
	/** `null` — раздел про самого вошедшего, отдельного права на него нет. */
	permission: PermissionKey | null;
};

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
	{
		href: '/settings/general',
		label: 'Общие',
		description: 'Страница входа и сроки жизни сессий',
		permission: 'settings.write'
	},
	{
		href: '/settings/profile',
		label: 'Профиль',
		description: 'Учётная запись, под которой вы вошли, и её сессии',
		permission: null
	},
	{
		href: '/settings/users',
		label: 'Пользователи',
		description: 'Кто работает в системе, с какой ролью и кому подчиняется',
		permission: 'users.manage'
	},
	{
		href: '/settings/api-keys',
		label: 'Ключи доступа',
		description: 'Ключи, которыми внешние системы обращаются к API',
		permission: 'api_keys.manage'
	},
	{
		href: '/settings/workspaces',
		label: 'Пространства',
		description: 'Направления работы, их порядок в меню и назначенный каждому процесс',
		permission: 'stages.configure'
	},
	{
		href: '/settings/workflows',
		label: 'Процессы',
		description: 'Описания работы: стадии, переходы и черновик изменений',
		permission: 'stages.configure'
	},
	{
		href: '/settings/integrations',
		label: 'Интеграции',
		description: 'Вебхуки, обмен с системой обучения и приём заявок с сайта',
		permission: 'integrations.manage'
	}
];
