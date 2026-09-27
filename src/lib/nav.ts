import type { LucideIcon } from '$lib/icon';
import BarChart3Icon from '@lucide/svelte/icons/bar-chart-3';
import BellIcon from '@lucide/svelte/icons/bell';
import BookOpenIcon from '@lucide/svelte/icons/book-open';
import BuildingIcon from '@lucide/svelte/icons/building';
import CompassIcon from '@lucide/svelte/icons/compass';
import DatabaseIcon from '@lucide/svelte/icons/database';
import FileTextIcon from '@lucide/svelte/icons/file-text';
import GraduationCapIcon from '@lucide/svelte/icons/graduation-cap';
import HandshakeIcon from '@lucide/svelte/icons/handshake';
import KeyRoundIcon from '@lucide/svelte/icons/key-round';
import LandmarkIcon from '@lucide/svelte/icons/landmark';
import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
import LayoutGridIcon from '@lucide/svelte/icons/layout-grid';
import NetworkIcon from '@lucide/svelte/icons/network';
import PackageIcon from '@lucide/svelte/icons/package';
import PlugZapIcon from '@lucide/svelte/icons/plug-zap';
import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
import UserCogIcon from '@lucide/svelte/icons/user-cog';
import UsersIcon from '@lucide/svelte/icons/users';
import WalletIcon from '@lucide/svelte/icons/wallet';
import WebhookIcon from '@lucide/svelte/icons/webhook';
import WorkflowIcon from '@lucide/svelte/icons/workflow';
import type { PermissionKey } from '$lib/server/rbac/permissions';

/**
 * A heading of the sidebar. A heading is not a link: it only says what kind of
 * thing the sections under it are, so the eye lands on the daily work first,
 * and the catalogues and the machinery stay out of its way.
 *
 * Заголовок едет вместе с секцией, а не лежит отдельным списком: секции
 * пространств приходят из базы, и отдельный список заголовков пришлось бы
 * собирать вторым проходом и держать с ними в согласии.
 */
export type NavGroup = {
	id: string;
	label: string;
};

/** Постоянные заголовки: они есть на любой установке и в любом составе прав. */
const MAIN: NavGroup = { id: 'main', label: 'Главное' };
const DIRECTORY: NavGroup = { id: 'directory', label: 'Справочники' };
const SETTINGS: NavGroup = { id: 'settings', label: 'Настройки' };
const OTHER: NavGroup = { id: 'other', label: 'Остальное' };

/**
 * Пространство в том объёме, в каком его знает панель: заголовок секции и
 * ключ, которым она отличается от соседней.
 */
export type NavWorkspace = {
	key: string;
	name: string;
	/**
	 * Процесс назначен. Пространство без процесса секцию всё равно получает:
	 * скрывать его — значит прятать то, что человек только что создал, и
	 * оставлять его гадать, завелось ли. Что внутри пусто, объясняет доска.
	 */
	hasWorkflow: boolean;
};

export type NavSection = {
	/** Route the section points at; also the prefix that marks it as active. */
	href: string;
	label: string;
	icon: LucideIcon;
	/** The heading the section is listed under, with its own label. */
	group: NavGroup;
	/**
	 * The permission the section is hidden without. `null` means every signed-in
	 * user sees it: «Настройки» has no permission of its own, and which pages it
	 * offers inside is decided by the section itself.
	 */
	permission: PermissionKey | null;
};

/**
 * Разделы, которые есть всегда и не принадлежат ни одному направлению: сводка,
 * общие справочники, настройки и хроника. Порядок списка — это порядок меню:
 * заголовок встаёт там, где встретилась первая его секция.
 */
const STATIC_SECTIONS: readonly NavSection[] = [
	// «Главная» — то, с чем менеджер работает каждый день.
	{
		// Сводка отвечает на вопрос «с чего начать день», и возвращаются к ней
		// чаще, чем к любому разделу: без пункта в меню дорога назад была только
		// кнопкой браузера. Префикс `/` совпадает лишь с самим корнем — раздел
		// ниже по адресу подсветится своим пунктом, а не этим.
		href: '/',
		label: 'Сводка',
		icon: LayoutDashboardIcon,
		group: MAIN,
		permission: null
	},
	{
		// Документы — договоры и акты по шаблону — рождаются из взаимодействий и
		// правятся вместе с ними: это ежедневная работа, а не каталог, в который
		// заглядывают раз в месяц.
		href: '/documents',
		label: 'Документы',
		icon: FileTextIcon,
		group: MAIN,
		permission: 'documents.read'
	},

	// «Справочники» — общий каталог оператора: кто, чему и по каким программам.
	{
		href: '/organizations',
		label: 'Организации',
		icon: BuildingIcon,
		group: DIRECTORY,
		permission: 'organizations.read'
	},
	{
		href: '/people',
		label: 'Контакты',
		icon: UsersIcon,
		group: DIRECTORY,
		permission: 'people.read'
	},
	{
		href: '/programs',
		label: 'Программы',
		icon: GraduationCapIcon,
		group: DIRECTORY,
		permission: 'programs.read'
	},
	{
		href: '/products',
		label: 'Продукты',
		icon: PackageIcon,
		group: DIRECTORY,
		permission: 'products.read'
	},
	{
		// Направления стоят в ряду справочников, рядом с программами и продуктами:
		// это тот же общий каталог оператора. Право у пункта — на чтение:
		// направления видят все, правит их руководитель.
		href: '/directions',
		label: 'Направления',
		icon: CompassIcon,
		group: DIRECTORY,
		permission: 'directions.read'
	},
	{
		// Данные об обучении приходят таблицей и живут рядом со справочниками,
		// которые они пополняют: это загруженные сведения, а не рабочий поток.
		href: '/data',
		label: 'Данные об обучении',
		icon: DatabaseIcon,
		group: DIRECTORY,
		permission: 'stats.read'
	},

	// «Настройки» — правила, по которым система работает. Каждый подраздел стоит
	// в меню сам: раньше все шесть прятались за одним пунктом и полосой вкладок
	// внутри него, и дорога к процессу или ключам была вдвое длиннее, чем к
	// любому другому экрану. Право у пункта — то же, которым открывается сам
	// подраздел (`src/routes/(app)/settings/sections.ts`).
	//
	// Порядок — от того, что заводят и правят чаще, к тому, что настраивают
	// однажды: общие правила, люди, направления и их процессы, а ключи, обмен и
	// журналы доставки — следом. «Профиля» в этом ряду нет: учётная запись
	// человека — не правило системы, и открывается она из карточки в подвале
	// меню, где написано, кто вошёл.
	{
		// «Общие» — первым: это правила, которыми живёт вся система, а
		// пользователи — про отдельные учётные записи.
		href: '/settings/general',
		label: 'Общие',
		icon: SlidersHorizontalIcon,
		group: SETTINGS,
		permission: 'settings.write'
	},
	{
		href: '/settings/users',
		label: 'Пользователи',
		icon: UserCogIcon,
		group: SETTINGS,
		permission: 'users.manage'
	},
	{
		// Право то же, что у «Пользователей»: страница о том же предмете, только
		// матрица вместо списка сотрудников, и заводить под неё отдельное право
		// незачем.
		href: '/settings/roles',
		label: 'Роли и права',
		icon: ShieldCheckIcon,
		group: SETTINGS,
		permission: 'users.manage'
	},
	{
		// Пространства стоят перед процессом: сначала заводят направление, потом
		// описывают, как в нём работают. Тот же порядок и в таблице подразделов.
		href: '/settings/workspaces',
		label: 'Пространства',
		icon: LayoutGridIcon,
		group: SETTINGS,
		permission: 'stages.configure'
	},
	{
		href: '/settings/workflows',
		label: 'Процессы',
		icon: WorkflowIcon,
		group: SETTINGS,
		permission: 'stages.configure'
	},
	{
		href: '/settings/api-keys',
		label: 'Ключи доступа',
		icon: KeyRoundIcon,
		group: SETTINGS,
		permission: 'api_keys.manage'
	},
	{
		href: '/settings/integrations',
		label: 'Интеграции',
		icon: WebhookIcon,
		group: SETTINGS,
		permission: 'integrations.manage'
	},
	{
		// Журнал доставок напоминаний. Право у него своё, а не `audit.read`:
		// эскалация приходит руководителю, и вопрос «почему мне не пришло» —
		// его, а не службы безопасности (`docs/access-matrix.md`, раздел 3).
		href: '/notifications',
		label: 'Уведомления',
		icon: BellIcon,
		group: SETTINGS,
		permission: 'notifications.read'
	},
	{
		// Журнал обмена — техническая хроника, и право у неё то же, что у
		// настройки обмена: кто ведёт обмен, тот и разбирает его отказы
		// (`docs/access-matrix.md`, раздел 4).
		href: '/exchange',
		label: 'Внешние системы',
		icon: PlugZapIcon,
		group: SETTINGS,
		permission: 'integrations.manage'
	},
	{
		// Самодиагностика связей: право то же, что у интеграций, — адреса CMS и
		// системы обучения на ней те же, что в настройках обмена.
		href: '/settings/health',
		label: 'Статус системы',
		icon: NetworkIcon,
		group: SETTINGS,
		permission: 'integrations.manage'
	},

	// «Остальное» — то, что не работа и не правила: хроника действий и книга о
	// системе. Ходят сюда по поводу, а не по плану.
	{
		href: '/audit',
		label: 'Журнал',
		icon: ScrollTextIcon,
		group: OTHER,
		permission: 'audit.read'
	},
	{
		// Справка объясняет продукт целиком, поэтому права у неё своего нет: что
		// показать внутри, решает сам раздел.
		href: '/help',
		label: 'Справка',
		icon: BookOpenIcon,
		group: OTHER,
		permission: null
	}
];

/**
 * Значок пункта «Взаимодействия» по ключу пространства. Подпись у пункта
 * везде одна и та же — направление называет заголовок секции, — а рядом со
 * значком одинаковые строки в двух соседних секциях меню было не отличить на
 * глаз, не читая текст. `b2b` и `b2c` — ключи посевных направлений
 * (`$lib/server/stages/definitions.ts`, `B2B_WORKSPACE_KEY`/`B2C_WORKSPACE_KEY`,
 * сюда не импортируются: модуль общий с клиентом, серверный — нет); третье
 * направление получает прежний общий значок, пока не заведут своего.
 */
function workspaceIcon(key: string): LucideIcon {
	switch (key) {
		case 'b2b':
			return LandmarkIcon;
		case 'b2c':
			return WalletIcon;
		default:
			return HandshakeIcon;
	}
}

/**
 * Пункты секции пространства: одна секция на направление, пункты — то, что в
 * нём делают. Сюда же встанут пункты модулей пространства: секция — список, а
 * не единственная ссылка.
 *
 * Заголовок — имя пространства, а не слово «Пространство»: человек ходит в
 * «Работу с ВУЗ», а не в «пространство номер один».
 *
 * Отчёты — внутри пространства, а не в «Главном»: у направлений разные
 * процессы, свои стадии и метрики, и сквозного отчёта, складывающего их числа,
 * нет. Право у отчёта то же, что у списка: он показывает ровно то, что человек и
 * так видит в списке взаимодействий, и право, расходящееся с
 * `interactions.read`, однажды показало бы в отчёте лишнее или спрятало своё
 * (`docs/access-matrix.md`, раздел 3).
 */
function workspaceSections(workspace: NavWorkspace): NavSection[] {
	const group: NavGroup = { id: `workspace:${workspace.key}`, label: workspace.name };

	return [
		{
			href: `/w/${workspace.key}/interactions`,
			label: 'Взаимодействия',
			icon: workspaceIcon(workspace.key),
			group,
			permission: 'interactions.read'
		},
		{
			href: `/w/${workspace.key}/reports`,
			label: 'Отчёты',
			icon: BarChart3Icon,
			group,
			permission: 'interactions.read'
		}
	];
}

/**
 * Меню целиком: постоянные разделы и по секции на пространство.
 *
 * Пространства приходят из базы и встают между «Главным» и «Справочниками» —
 * сразу за тем, с чего начинают день, и до общего каталога: направление это
 * ежедневная работа, а справочник — то, куда заглядывают по поводу.
 *
 * Функция, а не готовый список: пространства заводит заказчик, и их состав
 * известен только во время запроса.
 */
export function navSections(workspaces: readonly NavWorkspace[]): NavSection[] {
	const main = STATIC_SECTIONS.filter((section) => section.group === MAIN);
	const rest = STATIC_SECTIONS.filter((section) => section.group !== MAIN);

	return [...main, ...workspaces.flatMap(workspaceSections), ...rest];
}

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
export type NavGroupWithSections<TSection> = NavGroup & {
	sections: TSection[];
};

/**
 * The sections arranged under their headings, in the order they are given: a
 * heading appears where its first section does. A heading over nothing does not
 * appear at all — it would only announce that something is hidden from this
 * account.
 */
export function groupedSections<TSection extends { group: NavGroup }>(
	sections: readonly TSection[]
): NavGroupWithSections<TSection>[] {
	const groups: NavGroupWithSections<TSection>[] = [];
	const byId = new Map<string, NavGroupWithSections<TSection>>();

	for (const section of sections) {
		let group = byId.get(section.group.id);

		if (group === undefined) {
			group = { id: section.group.id, label: section.group.label, sections: [] };
			byId.set(group.id, group);
			groups.push(group);
		}

		group.sections.push(section);
	}

	return groups;
}
