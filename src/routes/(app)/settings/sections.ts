/**
 * Подразделы настроек и право, которое их открывает.
 *
 * Список один на заголовок раздела и на проверку доступа: подраздел, которого
 * человек не видит, обязан отвечать отказом и по прямой ссылке. Разойтись этим
 * двум ответам нельзя — поэтому они читают одну таблицу.
 *
 * Те же подразделы стоят пунктами главного меню (`$lib/nav`) со своими
 * значками, в том же порядке и с теми же правами — за этим следит
 * `tests/unit/nav.test.ts`. Исключение одно и названо здесь же: «Профиль»
 * (`personal: true`) в меню разделов не стоит, потому что это не правило
 * системы, а учётная запись вошедшего, — к ней ходят из карточки в подвале
 * меню, где написано, кто вошёл.
 */
import type { PermissionKey } from '$lib/server/rbac/permissions';

export type SettingsHref =
	| '/settings/profile'
	| '/settings/users'
	| '/settings/roles'
	| '/settings/api-keys'
	| '/settings/general'
	| '/settings/workspaces'
	| '/settings/workflows'
	| '/settings/integrations'
	| '/settings/diagnostics';

export type SettingsSection = {
	href: SettingsHref;
	label: string;
	description: string;
	/** `null` — раздел про самого вошедшего, отдельного права на него нет. */
	permission: PermissionKey | null;
	/**
	 * Подраздел про самого вошедшего, а не про устройство системы: в главное
	 * меню он не попадает и открывается из карточки учётной записи. В таблице
	 * он всё равно нужен — из неё оболочка настроек берёт название и подпись
	 * для заголовка страницы.
	 */
	personal?: true;
};

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
	{
		href: '/settings/general',
		label: 'Общие',
		description: 'Страница входа и сроки жизни сессий',
		permission: 'settings.write'
	},
	{
		href: '/settings/users',
		label: 'Пользователи',
		description: 'Кто работает в системе, с какой ролью и кому подчиняется',
		permission: 'users.manage'
	},
	{
		href: '/settings/roles',
		label: 'Роли и права',
		description: 'Что может каждая роль: матрица прав только для чтения',
		permission: 'users.manage'
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
		href: '/settings/api-keys',
		label: 'Ключи доступа',
		description: 'Ключи, которыми внешние системы обращаются к API',
		permission: 'api_keys.manage'
	},
	{
		href: '/settings/integrations',
		label: 'Интеграции',
		description: 'Вебхуки, обмен с системой обучения и приём заявок с сайта',
		permission: 'integrations.manage'
	},
	{
		href: '/settings/diagnostics',
		label: 'Связи и зависимости',
		description: 'С чем система соединяется, зачем и отвечает ли оно сейчас',
		permission: 'integrations.manage'
	},
	{
		// Последним и вне ряда: в меню разделов его нет, и порядок здесь нужен
		// только заголовку страницы.
		href: '/settings/profile',
		label: 'Профиль',
		description: 'Учётная запись, под которой вы вошли, и её сессии',
		permission: null,
		personal: true
	}
];
