/**
 * Из реестра экранов — два тура.
 *
 * **Полный тур** ведёт по системе целиком в порядке работы, а не в порядке
 * меню: сначала то, с чего начинают день, потом то, чем этот день занят, и
 * только в конце настройки. Порядок задан на роль руками — меню перечисляет
 * разделы, а тур обязан объяснять последовательность.
 *
 * **Тур экрана** — то же самое про один экран: вступление и его элементы. Он
 * открывается с любой страницы значком «?», и приветствия у него нет: человек
 * уже пришёл за конкретным ответом.
 *
 * Обе функции возвращают плоский список остановок. Карточка тура ничего не
 * считает сама: она показывает остановку, ведёт по счётчику и переходит на
 * экран, которому остановка принадлежит.
 *
 * Файл обычный, без рун и без импортов сборки: его читают и компоненты, и
 * модульные проверки.
 */
import {
	INTRO_TARGET,
	screenById,
	screenHelpHref,
	screenHref,
	type TourQuery,
	type TourSamples,
	type TourScreen
} from './screens';

/** Чем остановка является: от этого зависит вид карточки и её кнопки. */
export type TourStopKind = 'welcome' | 'shell' | 'intro' | 'step' | 'finish';

export type TourStopScreen = {
	id: string;
	title: string;
	/** Куда вести, если человек стоит не здесь. */
	href: string;
	/** Место остановки внутри экрана и сколько их всего: «Отчёты · шаг 2 из 3». */
	position: number;
	total: number;
};

export type TourStop = {
	/** Ключ остановки; он же отличает её от соседних для прокрутки и фокуса. */
	id: string;
	kind: TourStopKind;
	/** Экран остановки; у приветствия, шагов оболочки и финала его нет. */
	screen: TourStopScreen | null;
	title: string;
	body: string;
	/** Метка элемента, вокруг которого встаёт рамка; `null` — карточка по центру. */
	target: string | null;
	/** Что сказать, когда элемента на экране нет. */
	hint: string | null;
	/** Ссылка под текстом: статья справки в конце тура экрана, справка в финале. */
	link: { href: string; label: string } | null;
	/** Карта экранов тура списком; есть только у приветствия. */
	map: readonly string[] | null;
	/** Параметры адреса, которые шаг выставляет сам (`TourStep.query`); `null` — адрес безразличен. */
	query: TourQuery | null;
};

/** Шаг по элементу оболочки: он есть на каждой странице и экрана не имеет. */
type ShellStep = {
	id: string;
	title: string;
	body: string;
	target: string;
	hint?: string;
};

/**
 * Оболочка: то, что окружает любой экран. Полный тур начинается с неё, потому
 * что дальше он будет ею пользоваться — переходить по разделам и открывать
 * подсказки значком «?».
 */
export const SHELL_STEPS: readonly ShellStep[] = [
	{
		id: 'nav',
		title: 'Разделы слева',
		body: 'Разделы собраны в группы: «Главное» — сводка, отчёты и документы; ниже — секция каждого пространства с его взаимодействиями и страницами подключённых модулей; «Справочники» — общий каталог; «Настройки» — правила, пользователи, пространства, процессы, интеграции и обмен; «Остальное» — журнал, тур и справка. Меню перечисляет то, что открыто лично вам: раздела, на который у вашей роли нет права, в нём нет вовсе. Заголовок группы сворачивает её, кнопка рядом со знаком системы — всё меню до значков, а пункт «Тур по системе» в любой момент зовёт этот обход заново.',
		target: 'nav',
		hint: 'На телефоне разделы открывает кнопка «Разделы» справа в нижней панели.'
	},
	{
		id: 'search',
		title: 'Поиск по системе',
		body: 'Кнопка «Поиск» первой строкой меню и сочетание Ctrl + K открывают одно и то же окно. Оно работает с любого экрана, находит дела, организации, людей, договоры и страницы системы и заменяет дорогу «меню, раздел, фильтр, строка».',
		target: 'search'
	},
	{
		id: 'inbox',
		title: 'Колокольчик',
		body: 'Здесь то, что касается лично вас: где вас упомянули через «@» в комментарии и какие новые дела с сайта вам назначены. Число — непрочитанные; строка ведёт в карточку, упоминание — прямо к комментарию.',
		target: 'inbox'
	},
	{
		id: 'screen-tour',
		title: 'Тур по этому экрану',
		body: 'Значок компаса есть на каждой странице с подсказками и проводит по ней одной: вступление и главные элементы, без переходов. Пока тур экрана не пройден, от значка расходятся волны; пройдёте его до конца или закроете — волны гаснут. Этот обход — те же туры экранов подряд: экран, пройденный здесь, звать к себе больше не будет.',
		target: 'screen-tour'
	},
	{
		id: 'help-menu',
		title: 'Подсказки всегда здесь',
		body: 'Значок «?» открывает тур по экрану, этот обход целиком и статью справки об экране, а ещё все руководства и быстрый поиск. Он стоит в шапке каждой страницы — искать подсказки не нужно.',
		target: 'help-menu'
	},
	{
		id: 'theme',
		title: 'Тема',
		body: 'Светлая, тёмная или как в системе: нажатие переключает по кругу, а значок показывает выбранное. Выбор принадлежит устройству, поэтому он в шапке, а не в настройках.',
		target: 'theme-toggle'
	},
	{
		id: 'account',
		title: 'Учётная запись',
		body: 'Карточка в подвале меню: кто вошёл и с какой ролью; в ней же «Профиль» и «Выйти». Имя, почта и роль приходят из каталога учётных записей при каждом входе.',
		target: 'user-menu'
	}
];

const WELCOME = {
	title: 'Альма CRM: система контроля взаимодействия с вузами',
	body: 'Работа с учебными заведениями идёт по управляемому процессу: у каждого дела есть стадия, срок и след в истории, а дело без ответственного сразу видно на «Сводке». Тур пройдёт по экранам вашей роли и покажет, что на них главное.'
} as const;

const FINISH = {
	title: 'Готово',
	body: 'Подсказки по любому экрану всегда под значком «?» в шапке — там же и этот тур целиком. Полные руководства лежат в разделе «Справка».'
} as const;

/**
 * Порядок обхода на роль: не порядок меню, а порядок работы — сначала то, с
 * чего начинают день, потом сама работа, в конце настройки и справка. Роли, которой
 * здесь нет, полный тур не показывается.
 */
export const ROLE_TOURS: Readonly<Record<string, readonly string[]>> = {
	manager: [
		'home',
		'interactions',
		'interaction',
		'documents',
		'organizations',
		'organization',
		'people',
		'programs',
		'products',
		'directions',
		'data',
		'reports',
		'help',
		'settings-profile'
	],
	lead: [
		'home',
		'interactions',
		'interaction',
		'reports',
		'organizations',
		'organization',
		'people',
		'programs',
		'products',
		'directions',
		'data',
		'documents',
		'notifications',
		'audit',
		'help',
		'settings-profile'
	],
	admin: [
		'home',
		'interactions',
		'interaction',
		'reports',
		'organizations',
		'organization',
		'people',
		'programs',
		'products',
		'directions',
		'data',
		'documents',
		'settings-general',
		'settings-users',
		'settings-roles',
		'settings-workspaces',
		'settings-process',
		'settings-api-keys',
		'settings-integrations',
		'notifications',
		'exchange',
		'settings-health',
		'audit',
		'help',
		'settings-profile'
	]
};

/** Заведён ли этой роли полный тур. Роли без порядка обхода его не показывают. */
export function hasRoleTour(roleId: string): boolean {
	return (ROLE_TOURS[roleId] ?? []).length > 0;
}

function allowed(permission: string | undefined, permissions: ReadonlySet<string>): boolean {
	return permission === undefined || permissions.has(permission);
}

/**
 * Экраны тура этой роли: её порядок минус то, чего ей не покажут, — закрытое
 * правами и записи, образца которых не нашлось.
 */
function tourScreensFor(
	roleId: string,
	permissions: ReadonlySet<string>,
	samples: TourSamples | null
): { screen: TourScreen; href: string }[] {
	const order = ROLE_TOURS[roleId] ?? [];
	const result: { screen: TourScreen; href: string }[] = [];

	for (const id of order) {
		const screen = screenById(id);

		if (screen === null) {
			// Экран, которого нет в реестре, — опечатка в порядке роли. Модульная
			// проверка ловит её раньше, здесь остаётся просто не сломать тур.
			continue;
		}

		if (!allowed(screen.permission, permissions)) {
			continue;
		}

		const href = screenHref(screen, samples);

		if (href === null) {
			continue;
		}

		result.push({ screen, href });
	}

	return result;
}

/** Остановки одного экрана: вступление и его шаги, доступные этой роли. */
function screenStops(
	screen: TourScreen,
	href: string,
	permissions: ReadonlySet<string>,
	helpLinkOnLast: boolean
): TourStop[] {
	const steps = screen.steps.filter((step) => allowed(step.permission, permissions));
	const total = steps.length + 1;
	const helpHref = screenHelpHref(screen);
	const link =
		helpLinkOnLast && helpHref !== null && screen.help !== undefined
			? { href: helpHref, label: `Подробнее: ${screen.help.title}` }
			: null;

	const stops: TourStop[] = [
		{
			id: `${screen.id}:intro`,
			kind: 'intro',
			screen: { id: screen.id, title: screen.title, href, position: 1, total },
			title: screen.intro.title,
			body: screen.intro.body,
			target: INTRO_TARGET,
			hint: null,
			link: steps.length === 0 ? link : null,
			map: null,
			query: null
		},
		...steps.map((step, index) => ({
			id: `${screen.id}:${step.id}`,
			kind: 'step' as const,
			screen: { id: screen.id, title: screen.title, href, position: index + 2, total },
			title: step.title,
			body: step.body,
			target: step.target,
			hint: step.hint ?? null,
			link: index === steps.length - 1 ? link : null,
			map: null,
			query: step.query ?? null
		}))
	];

	return stops;
}

/**
 * Полный тур роли: приветствие, оболочка, экраны по порядку работы, финал.
 *
 * Пустой список означает, что показывать нечего: у роли нет порядка обхода или
 * все его экраны ей закрыты. Тур на одну карточку «добро пожаловать» и «готово»
 * не открывается — он ничего бы не рассказал.
 */
export function fullTourFor(
	roleId: string,
	permissions: ReadonlySet<string>,
	samples: TourSamples | null
): TourStop[] {
	const screens = tourScreensFor(roleId, permissions, samples);

	if (screens.length === 0) {
		return [];
	}

	return [
		{
			id: 'welcome',
			kind: 'welcome',
			screen: null,
			title: WELCOME.title,
			body: WELCOME.body,
			target: null,
			hint: null,
			link: null,
			map: screens.map((entry) => entry.screen.title),
			query: null
		},
		...SHELL_STEPS.map((step) => ({
			id: `shell:${step.id}`,
			kind: 'shell' as const,
			screen: null,
			title: step.title,
			body: step.body,
			target: step.target,
			hint: step.hint ?? null,
			link: null,
			map: null,
			query: null
		})),
		...screens.flatMap((entry) => screenStops(entry.screen, entry.href, permissions, false)),
		{
			id: 'finish',
			kind: 'finish',
			screen: null,
			title: FINISH.title,
			body: FINISH.body,
			target: null,
			hint: null,
			link: { href: '/help', label: 'Открыть справку' },
			map: null,
			query: null
		}
	];
}

/**
 * Тур одного экрана: вступление и его элементы, в конце — ссылка на статью
 * справки. Адрес экрана берётся у страницы, на которой человек стоит: у
 * карточки он с идентификатором открытой записи, и образец ей не нужен.
 */
export function screenTourFor(
	screen: TourScreen,
	permissions: ReadonlySet<string>,
	href: string
): TourStop[] {
	return screenStops(screen, href, permissions, true);
}

/** Оглавление полного тура: экран и номер его вступления в списке остановок. */
export type TourChapter = { screenId: string; title: string; index: number };

export function tourChapters(stops: readonly TourStop[]): TourChapter[] {
	return stops.flatMap((stop, index) =>
		stop.kind === 'intro' && stop.screen !== null
			? [{ screenId: stop.screen.id, title: stop.screen.title, index }]
			: []
	);
}

/**
 * Сколько тур займёт времени. Оценка грубая и названа оценкой: карточку читают
 * секунд пятнадцать, а обещать точную минуту тур всё равно не может — человек
 * останавливается там, где ему интересно.
 */
export function tourMinutes(stops: number): number {
	return Math.max(1, Math.round((stops * 15) / 60));
}
