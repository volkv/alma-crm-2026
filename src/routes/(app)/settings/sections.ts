/**
 * Разделы настроек и право, которое их открывает.
 *
 * Список один на меню и на проверку доступа: раздел, которого человек не видит
 * в меню, обязан отвечать отказом и по прямой ссылке. Разойтись этим двум
 * ответам нельзя — поэтому они читают одну таблицу.
 */
import type { PermissionKey } from '$lib/server/rbac/permissions';

export type SettingsHref =
	| '/settings/profile'
	| '/settings/users'
	| '/settings/api-keys'
	| '/settings/general'
	| '/settings/routes'
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
		href: '/settings/profile',
		label: 'Профиль',
		description: 'Пароль и сессии учётной записи, под которой вы вошли',
		permission: null
	},
	{
		href: '/settings/users',
		label: 'Пользователи',
		description: 'Кто работает в системе и с какой ролью',
		permission: 'users.manage'
	},
	{
		href: '/settings/api-keys',
		label: 'Ключи доступа',
		description: 'Ключи, которыми внешние системы обращаются к API',
		permission: 'api_keys.manage'
	},
	{
		href: '/settings/general',
		label: 'Общие настройки',
		description: 'Страница входа, сроки сессий, политики пароля и блокировки',
		permission: 'settings.write'
	},
	{
		href: '/settings/routes',
		label: 'Маршруты стадий',
		description: 'Версии процесса: стадии, переходы и маршрут по умолчанию',
		permission: 'stages.configure'
	},
	{
		href: '/settings/integrations',
		label: 'Интеграции',
		description: 'Вебхуки, обмен с системой обучения и приём заявок с сайта',
		permission: 'integrations.manage'
	}
];

/** Раздел по его адресу. Нужен обеим сторонам: и меню, и заголовку страницы. */
export function settingsSection(href: string): SettingsSection | undefined {
	return SETTINGS_SECTIONS.find((section) => section.href === href);
}
