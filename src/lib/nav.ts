import type { LucideIcon } from '@lucide/svelte';
import BuildingIcon from '@lucide/svelte/icons/building';
import FileTextIcon from '@lucide/svelte/icons/file-text';
import GraduationCapIcon from '@lucide/svelte/icons/graduation-cap';
import HandshakeIcon from '@lucide/svelte/icons/handshake';
import PackageIcon from '@lucide/svelte/icons/package';
import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
import SettingsIcon from '@lucide/svelte/icons/settings';
import UsersIcon from '@lucide/svelte/icons/users';

export type NavSection = {
	/** Route the section points at; also the prefix that marks it as active. */
	href: string;
	label: string;
	icon: LucideIcon;
};

/**
 * The main navigation, in the order the sidebar shows it. This is the single
 * list every navigation component reads, so a new section is added once.
 */
export const navSections: readonly NavSection[] = [
	{ href: '/interactions', label: 'Взаимодействия', icon: HandshakeIcon },
	{ href: '/organizations', label: 'Организации', icon: BuildingIcon },
	{ href: '/people', label: 'Контакты', icon: UsersIcon },
	{ href: '/programs', label: 'Программы', icon: GraduationCapIcon },
	{ href: '/products', label: 'Продукты', icon: PackageIcon },
	{ href: '/documents', label: 'Документы', icon: FileTextIcon },
	{ href: '/audit', label: 'Журнал', icon: ScrollTextIcon },
	{ href: '/settings', label: 'Настройки', icon: SettingsIcon }
];
