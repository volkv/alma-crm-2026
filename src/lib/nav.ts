import type { LucideIcon } from '@lucide/svelte';
import BuildingIcon from '@lucide/svelte/icons/building';
import DatabaseIcon from '@lucide/svelte/icons/database';
import FileTextIcon from '@lucide/svelte/icons/file-text';
import GraduationCapIcon from '@lucide/svelte/icons/graduation-cap';
import HandshakeIcon from '@lucide/svelte/icons/handshake';
import PackageIcon from '@lucide/svelte/icons/package';
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
		href: '/interactions',
		label: 'Взаимодействия',
		icon: HandshakeIcon,
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
	{ href: '/data', label: 'Данные', icon: DatabaseIcon, permission: 'stats.read' },
	{ href: '/documents', label: 'Документы', icon: FileTextIcon, permission: 'documents.read' },
	{ href: '/audit', label: 'Журнал', icon: ScrollTextIcon, permission: 'audit.read' },
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
