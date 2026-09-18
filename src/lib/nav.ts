import type { LucideIcon } from '@lucide/svelte';
import BarChart3Icon from '@lucide/svelte/icons/bar-chart-3';
import BellIcon from '@lucide/svelte/icons/bell';
import BookOpenIcon from '@lucide/svelte/icons/book-open';
import BuildingIcon from '@lucide/svelte/icons/building';
import CompassIcon from '@lucide/svelte/icons/compass';
import DatabaseIcon from '@lucide/svelte/icons/database';
import FileTextIcon from '@lucide/svelte/icons/file-text';
import GraduationCapIcon from '@lucide/svelte/icons/graduation-cap';
import HandshakeIcon from '@lucide/svelte/icons/handshake';
import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
import PackageIcon from '@lucide/svelte/icons/package';
import PlugZapIcon from '@lucide/svelte/icons/plug-zap';
import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
import SettingsIcon from '@lucide/svelte/icons/settings';
import UsersIcon from '@lucide/svelte/icons/users';
import type { PermissionKey } from '$lib/server/rbac/permissions';

export type NavSection = {
	/** Route the section points at; also the prefix that marks it as active. */
	href: string;
	label: string;
	icon: LucideIcon;
	/**
	 * The permission the section is hidden without. `null` means every signed-in
	 * user sees it: «Настройки» has no permission of its own, and which pages it
	 * offers inside is decided by the section itself.
	 */
	permission: PermissionKey | null;
};

/**
 * The main navigation, in the order the sidebar shows it. This is the single
 * list every navigation component reads, so a new section is added once.
 */
export const navSections: readonly NavSection[] = [
	{
		// Сводка отвечает на вопрос «с чего начать день», и возвращаются к ней
		// чаще, чем к любому разделу: без пункта в меню дорога назад была только
		// кнопкой браузера. Префикс `/` совпадает лишь с самим корнем — раздел
		// ниже по адресу подсветится своим пунктом, а не этим.
		href: '/',
		label: 'Сводка',
		icon: LayoutDashboardIcon,
		permission: null
	},
	{
		href: '/interactions',
		label: 'Взаимодействия',
		icon: HandshakeIcon,
		permission: 'interactions.read'
	},
	{
		// Отчёт показывает ровно то, что человек и так видит в списке
		// взаимодействий, поэтому право у него то же: право, расходящееся с
		// `interactions.read`, однажды показало бы в отчёте лишнее или спрятало
		// своё (`docs/access-matrix.md`, раздел 3).
		href: '/reports',
		label: 'Отчёты',
		icon: BarChart3Icon,
		permission: 'interactions.read'
	},
	{
		href: '/organizations',
		label: 'Организации',
		icon: BuildingIcon,
		permission: 'organizations.read'
	},
	{ href: '/people', label: 'Контакты', icon: UsersIcon, permission: 'people.read' },
	{ href: '/programs', label: 'Программы', icon: GraduationCapIcon, permission: 'programs.read' },
	{ href: '/products', label: 'Продукты', icon: PackageIcon, permission: 'products.read' },
	{
		// Направления стоят в ряду справочников, рядом с программами и продуктами:
		// это тот же общий каталог оператора. Право у пункта — на чтение:
		// направления видят все, правит их руководитель.
		href: '/directions',
		label: 'Направления',
		icon: CompassIcon,
		permission: 'directions.read'
	},
	{ href: '/data', label: 'Данные об обучении', icon: DatabaseIcon, permission: 'stats.read' },
	{ href: '/documents', label: 'Документы', icon: FileTextIcon, permission: 'documents.read' },
	{ href: '/audit', label: 'Журнал', icon: ScrollTextIcon, permission: 'audit.read' },
	{
		// Журнал доставок напоминаний. Право у него своё, а не `audit.read`:
		// эскалация приходит руководителю, и вопрос «почему мне не пришло» —
		// его, а не службы безопасности (`docs/access-matrix.md`, раздел 3).
		href: '/notifications',
		label: 'Уведомления',
		icon: BellIcon,
		permission: 'notifications.read'
	},
	{
		// Журнал обмена — техническая хроника, и право у неё то же, что у
		// настройки обмена: кто ведёт обмен, тот и разбирает его отказы
		// (`docs/access-matrix.md`, раздел 4).
		href: '/exchange',
		label: 'Внешние системы',
		icon: PlugZapIcon,
		permission: 'integrations.manage'
	},
	{
		// Справка объясняет продукт целиком, поэтому права у неё своего нет: то же
		// правило, что у «Настроек», — что показать внутри, решает сам раздел.
		href: '/help',
		label: 'Справка',
		icon: BookOpenIcon,
		permission: null
	},
	{ href: '/settings', label: 'Настройки', icon: SettingsIcon, permission: null }
];

/**
 * The sections these permissions open. A section the user has no right to is
 * not shown at all: a link that answers 403 is not navigation, and the sidebar
 * is the one place where the shape of the product is stated — it must not
 * promise more than the account can do.
 *
 * Hiding is not protection: the loader of every section checks the same
 * permission again, because the address can be typed by hand.
 */
export function visibleSections<TSection extends { permission: PermissionKey | null }>(
	sections: readonly TSection[],
	permissions: ReadonlySet<string>
): TSection[] {
	return sections.filter(
		(section) => section.permission === null || permissions.has(section.permission)
	);
}
