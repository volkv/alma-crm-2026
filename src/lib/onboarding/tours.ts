/**
 * Из реестра экранов и меню — два вида подсказок.
 *
 * **Знакомство** — обход системы на первом входе: оболочка, а затем разделы
 * по одному. Каждый раздел показывается пунктом меню и открытой страницей, но
 * не объясняется: знакомство отвечает на вопрос «что здесь вообще есть», а не
 * «как этим пользоваться». Собирается оно из меню, которое видит человек,
 * поэтому раздела, закрытого правами, в нём нет, а пространства называются
 * так, как их назвал заказчик.
 *
 * **Тур экрана** — вступление и элементы одной страницы. Его запускает компас
 * в шапке, и подробности каждого раздела живут там, а не в знакомстве:
 * длинный обход «всё обо всём» никто не дочитывал.
 *
 * Обе функции возвращают плоский список остановок. Карточка тура ничего не
 * считает сама: она показывает остановку, ведёт по счётчику и открывает
 * страницу, которой остановка принадлежит.
 *
 * Файл обычный, без рун и без импортов сборки: его читают и компоненты, и
 * модульные проверки.
 */
import { INTRO_TARGET, screenHelpHref, type TourQuery, type TourScreen } from './screens';

/**
 * Чем остановка является: от этого зависит вид карточки и её кнопки.
 * `section` — раздел в знакомстве: пункт меню и открытая страница.
 */
export type TourStopKind = 'welcome' | 'shell' | 'section' | 'intro' | 'step' | 'finish';

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
	/**
	 * Страница остановки. У шага тура экрана — экран реестра, у раздела
	 * знакомства — его страница; у приветствия, шагов оболочки и финала её нет.
	 */
	screen: TourStopScreen | null;
	title: string;
	body: string;
	/**
	 * Что обвести рамкой; `null` — карточка по центру. Обычно метка `data-tour`,
	 * у знакомства ещё пункт меню (`navLinkTarget`) и секции пространств
	 * (`NAV_WORKSPACES_TARGET`).
	 */
	target: string | null;
	/** Что сказать, когда элемента на экране нет. */
	hint: string | null;
	/** Ссылка под текстом: статья справки в конце тура экрана, справка в финале. */
	link: { href: string; label: string } | null;
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
 * Оболочка: то, что окружает любой экран. Знакомство начинается с неё, потому
 * что дальше оно будет ею пользоваться — переходить по разделам меню, — а
 * человек потом будет звать подсказки компасом и значком «?».
 */
export const SHELL_STEPS: readonly ShellStep[] = [
	{
		id: 'nav',
		title: 'Разделы слева',
		body: 'Разделы собраны в группы: «Главное» — сводка, отчёты и документы; ниже — секция каждого пространства; «Справочники» — общий каталог; «Настройки» — пользователи, пространства, процессы, интеграции и обмен; «Остальное» — журнал, знакомство и справка. Меню перечисляет то, что открыто лично вам: раздела, на который у вашей роли нет права, в нём нет вовсе. Заголовок группы сворачивает её, кнопка рядом со знаком системы — всё меню до значков.',
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
		body: 'Знакомство только покажет разделы, а подробности каждой страницы — под значком компаса. Он есть на каждой странице с подсказками и проводит по ней одной: вступление и главные элементы. Пока тур экрана не пройден, от значка расходятся волны; пройдёте его до конца или закроете — волны гаснут.',
		target: 'screen-tour'
	},
	{
		id: 'help-menu',
		title: 'Подсказки всегда здесь',
		body: 'Значок «?» открывает тур по экрану, это знакомство заново и статью справки об экране, а ещё все руководства и быстрый поиск. Он стоит в шапке каждой страницы — искать подсказки не нужно.',
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

/** Цель рамки — все секции пространств в меню разом. */
export const NAV_WORKSPACES_TARGET = 'nav-workspaces';

const NAV_LINK_PREFIX = 'nav-link:';

/** Цель рамки — пункт меню с этим адресом. */
export function navLinkTarget(href: string): string {
	return `${NAV_LINK_PREFIX}${href}`;
}

/** Адрес пункта меню, если цель — пункт меню; `null` — обычная метка. */
export function navLinkHref(target: string): string | null {
	return target.startsWith(NAV_LINK_PREFIX) ? target.slice(NAV_LINK_PREFIX.length) : null;
}

/** Пункт меню, каким его видит знакомство: адрес, подпись и группа. */
export type GuideLink = {
	href: string;
	label: string;
	group: { id: string; label: string };
};

/** Группа меню секции пространства: `workspace:<ключ>` (`$lib/nav`). */
const WORKSPACE_GROUP = 'workspace:';

/**
 * Что делают в посевных пространствах. Ключи — те же, что у значков меню
 * (`$lib/nav`, `workspaceIcon`); пространство, которое заведёт заказчик,
 * называется своим именем без пояснения.
 */
const WORKSPACE_PURPOSE: Readonly<Record<string, string>> = {
	b2b: 'процесс работы с вузом — полный цикл от поиска контактных лиц до контроля исполнения обязательств',
	b2c: 'процесс коммерческого обучения компаний и физических лиц — заявка, предложение, договор и оплата, обучение и документ об обучении'
};

/** Раздел знакомства: какой пункт меню показать и что о нём сказать одной-двумя фразами. */
type GuideSection = {
	id: string;
	title: string;
	body: string;
	/** Пункт меню, по которому узнают раздел и чью страницу открывают. */
	pick: (links: readonly GuideLink[]) => GuideLink | undefined;
};

const byHref =
	(href: string) =>
	(links: readonly GuideLink[]): GuideLink | undefined =>
		links.find((link) => link.href === href);

/** Первый пункт секции пространства — «Взаимодействия» первого направления. */
function firstWorkspaceLink(links: readonly GuideLink[]): GuideLink | undefined {
	return links.find(
		(link) => link.group.id.startsWith(WORKSPACE_GROUP) && link.href.endsWith('/interactions')
	);
}

/**
 * Разделы знакомства по порядку: сначала пространства и их процессы — то, ради
 * чего система, — потом каталог, отчёты и документы, в конце люди, обмен и
 * данные. Раздел, которого в меню этого человека нет, пропускается.
 */
const GUIDE_SECTIONS: readonly GuideSection[] = [
	{
		id: 'settings-workspaces',
		title: 'Пространства настраивают здесь',
		body: 'У каждого пространства своя страница: какой процесс в нём действует, какие модули подключены — договоры, оплата, обучение, встречи — и кто из сотрудников в нём работает.',
		pick: byHref('/settings/workspaces')
	},
	{
		id: 'settings-workflows',
		title: 'Процессы',
		body: 'Процесс описан данными, а не кодом: стадии с нормативом в днях, переходы, чек-листы и документы, которыми стадия закрывается. Правят его черновиком: изменения видны заранее и применяются ко всем делам разом.',
		pick: byHref('/settings/workflows')
	},
	{
		id: 'interactions',
		title: 'Взаимодействия — основная работа',
		body: 'Здесь и идёт работа по процессу: каждое дело с вузом стоит на своей стадии, доска показывает, где скопилась работа, а карточка дела ведёт его от стадии к стадии. Как устроены доска и карточка, расскажет компас на этой странице.',
		pick: firstWorkspaceLink
	},
	{
		id: 'home',
		title: 'Сводка — с чего начинают день',
		body: 'Первый экран после входа: просрочки, сроки на сегодня и завтра, помехи, дела без ответственного и новые заявки с сайта — всё, что требует внимания, с кнопкой прямо в дело.',
		pick: byHref('/')
	},
	{
		id: 'organizations',
		title: 'Организации',
		body: 'Общий справочник контрагентов: вузы и колледжи, компании-заказчики, вендоры, операторы и все прочие организации. Новую находят в ЕГРЮЛ по ИНН или названию, реквизиты подставляются сами.',
		pick: byHref('/organizations')
	},
	{
		id: 'people',
		title: 'Контакты',
		body: 'Люди и их роли в организациях — от ректора и декана до координатора и контакта вендора. У каждого контакта записано основание обработки персональных данных и срок их хранения.',
		pick: byHref('/people')
	},
	{
		id: 'programs',
		title: 'Программы',
		body: 'Образовательные программы, по которым идёт работа с вузами: уровень, версии и материалы, которые уходят вузу письмом из карточки дела.',
		pick: byHref('/programs')
	},
	{
		id: 'products',
		title: 'Продукты',
		body: 'Программное обеспечение и сервисы, которые передаются вузу по договору, вместе с контактами вендора.',
		pick: byHref('/products')
	},
	{
		id: 'directions',
		title: 'Направления',
		body: 'Разрезы работы: к направлению относятся программы и продукты, по нему отбирают дела и строят отчёты.',
		pick: byHref('/directions')
	},
	{
		id: 'reports',
		title: 'Отчёты',
		body: 'Срез и движение по делам: воронка по стадиям, сроки, итоги за период. Каждое число можно раскрыть до списка дел, а отчёт — выгрузить в XLSX, XLS, JSON или PDF.',
		pick: byHref('/reports')
	},
	{
		id: 'documents',
		title: 'Документы',
		body: 'Все файлы всех дел в одном месте: договоры, акты, протоколы, сертификаты — с редакциями и отметками «Подписан», «Утверждён».',
		pick: byHref('/documents')
	},
	{
		id: 'users',
		title: 'Пользователи',
		body: 'Кто работает в системе и кому подчиняется: руководитель видит дела своих сотрудников. Учётные записи приходят из каталога при первом входе, здесь их включают и выключают.',
		pick: byHref('/settings/users')
	},
	{
		id: 'roles',
		title: 'Роли и права',
		body: 'Что может каждая роль — матрица прав по разделам и действиям. Роль назначается в каталоге учётных записей, система берёт её при входе.',
		pick: byHref('/settings/roles')
	},
	{
		id: 'integrations',
		title: 'Интеграции',
		body: 'Подключение сайта (CMS), системы обучения (LMS), вебхуков и справочных сервисов: плитка на каждую систему со статусом, адреса и ключи — в окне по «Изменить».',
		pick: byHref('/settings/integrations')
	},
	{
		id: 'exchange',
		title: 'Внешние системы',
		body: 'Журнал двустороннего обмена: заявки с сайта, статусы обратно на сайт, потоки и итоги обучения из LMS. Неудачную передачу видно сразу, и её можно повторить.',
		pick: byHref('/exchange')
	},
	{
		id: 'audit',
		title: 'Журнал действий',
		body: 'Кто, что и когда сделал в системе — входы, переходы стадий, правки, выгрузки. Персональных данных журнал не хранит.',
		pick: byHref('/audit')
	},
	{
		id: 'data',
		title: 'Данные об обучении',
		body: 'Снимки данных об обучении — из файлов и из результатов групп системы обучения: показатели по программам и вузам, рейтинг и дашборд.',
		pick: byHref('/data')
	}
];

const GUIDE_WELCOME = {
	title: 'Знакомство с Альма CRM',
	body: 'Альма CRM ведёт работу с учебными заведениями по управляемому процессу: у каждого дела есть стадия, срок, ответственный и след в истории. Знакомство покажет, как устроен экран, и пройдёт по разделам системы — где что лежит. Подробности каждой страницы расскажет её собственный тур.'
} as const;

const GUIDE_FINISH = {
	title: 'Знакомство закончено',
	body: 'Теперь вы знаете, где что лежит. Подробности любой страницы — под значком компаса в шапке: он зовёт волнами, пока тур страницы не пройден. Знакомство можно повторить из меню «?», а полные руководства лежат в «Справке».'
} as const;

/** Обычная остановка знакомства без страницы: карточка ничего не открывает. */
function plainStop(
	id: string,
	kind: TourStopKind,
	title: string,
	body: string,
	target: string | null
): TourStop {
	return { id, kind, screen: null, title, body, target, hint: null, link: null, query: null };
}

/** Остановка «пространства»: обе секции меню разом и что в них за процессы. */
function workspacesStop(links: readonly GuideLink[]): TourStop | null {
	const workspaces = [
		...new Map(
			links
				.filter((link) => link.group.id.startsWith(WORKSPACE_GROUP))
				.map((link) => [link.group.id, link.group] as const)
		).values()
	];

	if (workspaces.length === 0) {
		return null;
	}

	const described = workspaces.map((group) => {
		const purpose = WORKSPACE_PURPOSE[group.id.slice(WORKSPACE_GROUP.length)];

		return purpose === undefined ? `«${group.label}»` : `«${group.label}» — ${purpose}`;
	});
	const count =
		workspaces.length === 1
			? 'Сейчас оно одно'
			: `Сейчас их ${workspaces.length}, и это ${workspaces.length === 2 ? 'два процесса' : 'разные процессы'}, которые ведёт система`;

	return {
		...plainStop(
			'guide:workspaces',
			'section',
			'Пространства — направления работы',
			`Пространство — это направление со своим процессом, своими делами, модулями и сотрудниками; в меню у каждого своя секция. ${count}: ${described.join('; ')}.`,
			NAV_WORKSPACES_TARGET
		),
		hint: 'На телефоне секции пространств — в меню «Разделы» в нижней панели.'
	};
}

/**
 * Знакомство для этого меню: приветствие, оболочка, пространства, разделы,
 * финал. Пустой список — показывать нечего: в меню нет ни одного раздела
 * знакомства.
 */
export function guideFor(links: readonly GuideLink[]): TourStop[] {
	const workspaces = workspacesStop(links);
	const sections = GUIDE_SECTIONS.flatMap((section): TourStop[] => {
		const link = section.pick(links);

		if (link === undefined) {
			return [];
		}

		// Заголовок из меню, а не из текста: «Взаимодействия» первого
		// пространства называются его именем — так, как их видно слева.
		const title =
			section.id === 'interactions' ? `${section.title} · ${link.group.label}` : section.title;

		return [
			{
				id: `guide:${section.id}`,
				kind: 'section',
				screen: {
					id: `guide:${section.id}`,
					title: link.label,
					href: link.href,
					position: 1,
					total: 1
				},
				title,
				body: section.body,
				target: navLinkTarget(link.href),
				hint: 'На телефоне этот пункт — в меню «Разделы» в нижней панели.',
				link: null,
				query: null
			}
		];
	});

	if (workspaces === null && sections.length === 0) {
		return [];
	}

	return [
		plainStop('guide:welcome', 'welcome', GUIDE_WELCOME.title, GUIDE_WELCOME.body, null),
		...SHELL_STEPS.map((step) => ({
			...plainStop(`shell:${step.id}`, 'shell', step.title, step.body, step.target),
			hint: step.hint ?? null
		})),
		...(workspaces === null ? [] : [workspaces]),
		...sections,
		{
			...plainStop('guide:finish', 'finish', GUIDE_FINISH.title, GUIDE_FINISH.body, null),
			link: { href: '/help', label: 'Открыть справку' }
		}
	];
}

function allowed(permission: string | undefined, permissions: ReadonlySet<string>): boolean {
	return permission === undefined || permissions.has(permission);
}

/**
 * Тур одного экрана: вступление и его элементы, доступные этой роли, в конце —
 * ссылка на статью справки. Адрес экрана берётся у страницы, на которой
 * человек стоит: у карточки он с идентификатором открытой записи.
 */
export function screenTourFor(
	screen: TourScreen,
	permissions: ReadonlySet<string>,
	href: string
): TourStop[] {
	const steps = screen.steps.filter((step) => allowed(step.permission, permissions));
	const total = steps.length + 1;
	const helpHref = screenHelpHref(screen);
	const link =
		helpHref !== null && screen.help !== undefined
			? { href: helpHref, label: `Подробнее: ${screen.help.title}` }
			: null;

	return [
		{
			id: `${screen.id}:intro`,
			kind: 'intro',
			screen: { id: screen.id, title: screen.title, href, position: 1, total },
			title: screen.intro.title,
			body: screen.intro.body,
			target: INTRO_TARGET,
			hint: null,
			link: steps.length === 0 ? link : null,
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
			query: step.query ?? null
		}))
	];
}

/**
 * Сколько обход займёт времени. Оценка грубая и названа оценкой: карточку
 * читают секунд пятнадцать, а обещать точную минуту всё равно нельзя —
 * человек останавливается там, где ему интересно.
 */
export function tourMinutes(stops: number): number {
	return Math.max(1, Math.round((stops * 15) / 60));
}
