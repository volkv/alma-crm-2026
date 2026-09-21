import type { LucideIcon } from '@lucide/svelte';
import BarChart3Icon from '@lucide/svelte/icons/bar-chart-3';
import BellIcon from '@lucide/svelte/icons/bell';
import BookOpenIcon from '@lucide/svelte/icons/book-open';
import BuildingIcon from '@lucide/svelte/icons/building';
import CircleUserIcon from '@lucide/svelte/icons/circle-user';
import CompassIcon from '@lucide/svelte/icons/compass';
import DatabaseIcon from '@lucide/svelte/icons/database';
import FileTextIcon from '@lucide/svelte/icons/file-text';
import GraduationCapIcon from '@lucide/svelte/icons/graduation-cap';
import HandshakeIcon from '@lucide/svelte/icons/handshake';
import KeyRoundIcon from '@lucide/svelte/icons/key-round';
import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
import PackageIcon from '@lucide/svelte/icons/package';
import PlugZapIcon from '@lucide/svelte/icons/plug-zap';
import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
import UserCogIcon from '@lucide/svelte/icons/user-cog';
import UsersIcon from '@lucide/svelte/icons/users';
import WebhookIcon from '@lucide/svelte/icons/webhook';
import WorkflowIcon from '@lucide/svelte/icons/workflow';
import type { PermissionKey } from '$lib/server/rbac/permissions';

/**
 * The groups the sidebar is split into, in the order they are shown. A heading
 * is not a link: it only says what kind of thing the sections under it are, so
 * the eye lands on the daily work first, and the catalogues and the machinery
 * stay out of its way.
 */
export const navGroups = [
	{ id: 'main', label: 'Главная' },
	{ id: 'directory', label: 'Справочники' },
	{ id: 'settings', label: 'Настройки' },
	{ id: 'other', label: 'Остальное' }
] as const;

export type NavGroupId = (typeof navGroups)[number]['id'];

export type NavSection = {
	/** Route the section points at; also the prefix that marks it as active. */
	href: string;
	label: string;
	icon: LucideIcon;
	/** The heading the section is listed under. */
	group: NavGroupId;
	/**
	 * The permission the section is hidden without. `null` means every signed-in
	 * user sees it: «Настройки» has no permission of its own, and which pages it
	 * offers inside is decided by the section itself.
	 */
	permission: PermissionKey | null;
};

/**
 * The main navigation, in the order the sidebar shows it: sorted by group in
 * the order of `navGroups`, and inside a group by hand. This is the single list
 * every navigation component reads, so a new section is added once.
 */
export const navSections: readonly NavSection[] = [
	// «Главная» — то, с чем менеджер работает каждый день.
	{
		// Сводка отвечает на вопрос «с чего начать день», и возвращаются к ней
		// чаще, чем к любому разделу: без пункта в меню дорога назад была только
		// кнопкой браузера. Префикс `/` совпадает лишь с самим корнем — раздел
		// ниже по адресу подсветится своим пунктом, а не этим.
		href: '/',
		label: 'Сводка',
		icon: LayoutDashboardIcon,
		group: 'main',
		permission: null
	},
	{
		href: '/interactions',
		label: 'Взаимодействия',
		icon: HandshakeIcon,
		group: 'main',
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
		group: 'main',
		permission: 'interactions.read'
	},
	{
		// Документы — договоры и акты по шаблону — рождаются из взаимодействий и
		// правятся вместе с ними: это ежедневная работа, а не каталог, в который
		// заглядывают раз в месяц.
		href: '/documents',
		label: 'Документы',
		icon: FileTextIcon,
		group: 'main',
		permission: 'documents.read'
	},

	// «Справочники» — общий каталог оператора: кто, чему и по каким программам.
	{
		href: '/organizations',
		label: 'Организации',
		icon: BuildingIcon,
		group: 'directory',
		permission: 'organizations.read'
	},
	{
		href: '/people',
		label: 'Контакты',
		icon: UsersIcon,
		group: 'directory',
		permission: 'people.read'
	},
	{
		href: '/programs',
		label: 'Программы',
		icon: GraduationCapIcon,
		group: 'directory',
		permission: 'programs.read'
	},
	{
		href: '/products',
		label: 'Продукты',
		icon: PackageIcon,
		group: 'directory',
		permission: 'products.read'
	},
	{
		// Направления стоят в ряду справочников, рядом с программами и продуктами:
		// это тот же общий каталог оператора. Право у пункта — на чтение:
		// направления видят все, правит их руководитель.
		href: '/directions',
		label: 'Направления',
		icon: CompassIcon,
		group: 'directory',
		permission: 'directions.read'
	},
	{
		// Данные об обучении приходят таблицей и живут рядом со справочниками,
		// которые они пополняют: это загруженные сведения, а не рабочий поток.
		href: '/data',
		label: 'Данные об обучении',
		icon: DatabaseIcon,
		group: 'directory',
		permission: 'stats.read'
	},

	// «Настройки» — правила, по которым система работает. Каждый подраздел стоит
	// в меню сам: раньше все шесть прятались за одним пунктом и полосой вкладок
	// внутри него, и дорога к процессу или ключам была вдвое длиннее, чем к
	// любому другому экрану. Право у пункта — то же, которым открывается сам
	// подраздел (`src/routes/(app)/settings/sections.ts`).
	{
		// «Общие» — первым: это правила, которыми живёт вся система, а профиль и
		// пользователи — про отдельные учётные записи.
		href: '/settings/general',
		label: 'Общие',
		icon: SlidersHorizontalIcon,
		group: 'settings',
		permission: 'settings.write'
	},
	{
		href: '/settings/profile',
		label: 'Профиль',
		icon: CircleUserIcon,
		group: 'settings',
		permission: null
	},
	{
		href: '/settings/users',
		label: 'Пользователи',
		icon: UserCogIcon,
		group: 'settings',
		permission: 'users.manage'
	},
	{
		href: '/settings/api-keys',
		label: 'Ключи доступа',
		icon: KeyRoundIcon,
		group: 'settings',
		permission: 'api_keys.manage'
	},
	{
		href: '/settings/process',
		label: 'Процесс',
		icon: WorkflowIcon,
		group: 'settings',
		permission: 'stages.configure'
	},
	{
		href: '/settings/integrations',
		label: 'Интеграции',
		icon: WebhookIcon,
		group: 'settings',
		permission: 'integrations.manage'
	},
	{
		// Журнал доставок напоминаний. Право у него своё, а не `audit.read`:
		// эскалация приходит руководителю, и вопрос «почему мне не пришло» —
		// его, а не службы безопасности (`docs/access-matrix.md`, раздел 3).
		href: '/notifications',
		label: 'Уведомления',
		icon: BellIcon,
		group: 'settings',
		permission: 'notifications.read'
	},
	{
		// Журнал обмена — техническая хроника, и право у неё то же, что у
		// настройки обмена: кто ведёт обмен, тот и разбирает его отказы
		// (`docs/access-matrix.md`, раздел 4).
		href: '/exchange',
		label: 'Внешние системы',
		icon: PlugZapIcon,
		group: 'settings',
		permission: 'integrations.manage'
	},

	// «Остальное» — то, что не работа и не правила: хроника действий и книга о
	// системе. Ходят сюда по поводу, а не по плану.
	{
		href: '/audit',
		label: 'Журнал',
		icon: ScrollTextIcon,
		group: 'other',
		permission: 'audit.read'
	},
	{
		// Справка объясняет продукт целиком, поэтому права у неё своего нет: что
		// показать внутри, решает сам раздел.
		href: '/help',
		label: 'Справка',
		icon: BookOpenIcon,
		group: 'other',
		permission: null
	}
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

/** A heading of the sidebar together with the sections shown under it. */
export type NavGroup<TSection> = {
	id: NavGroupId;
	label: string;
	sections: TSection[];
};

/**
 * The sections arranged under their headings, in the order of `navGroups`. A
 * group none of the given sections belongs to is left out: a heading over
 * nothing would only announce that something is hidden from this account.
 */
export function groupedSections<TSection extends { group: NavGroupId }>(
	sections: readonly TSection[]
): NavGroup<TSection>[] {
	return navGroups.flatMap((group) => {
		const own = sections.filter((section) => section.group === group.id);

		return own.length === 0 ? [] : [{ id: group.id, label: group.label, sections: own }];
	});
}
