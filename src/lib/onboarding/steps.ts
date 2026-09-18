/**
 * Подсказки первого входа: что система показывает человеку, который открыл её
 * впервые.
 *
 * Шаги разные у разных ролей, потому что разная и работа: менеджер ведёт свои
 * взаимодействия, руководитель смотрит портфель и раздаёт работу, администратор
 * настраивает процесс и обмен. Общего тура «обо всём сразу» здесь нет намеренно:
 * он рассказывал бы каждому про экраны, которых тот не увидит.
 *
 * Файл обычный, без рун и без импортов сборки: его читают и компонент тура, и
 * модульные проверки. Право у шага — то же, что у экрана, на который он ведёт:
 * шаг, ведущий в закрытый правами раздел, обещал бы работу, которой у этой
 * учётной записи нет.
 */
import type { PermissionKey } from '$lib/server/rbac/permissions';

export type OnboardingStep = {
	/** Идентификатор шага: он же ключ в проверках. */
	id: string;
	title: string;
	body: string;
	/** Значение `data-tour` элемента, вокруг которого встаёт рамка. */
	target: string;
	/** Экран, на котором этот элемент живёт: туда ведёт ссылка шага. */
	route: { href: string; label: string };
	/**
	 * Что сказать, когда человек уже на нужном экране, а элемента на нём нет:
	 * запись надо сначала открыть, список пуст. Без этого шаг выглядел бы
	 * поломкой.
	 */
	hint?: string;
	/** Право, без которого шаг не показывается. */
	permission?: PermissionKey;
};

const MANAGER_STEPS: readonly OnboardingStep[] = [
	{
		id: 'home',
		title: 'Сводка: что требует действия',
		body: 'Список собирает ваши взаимодействия: сначала просроченные, потом с помехами, потом с близким сроком. С него начинают рабочий день.',
		target: 'home-needs-action',
		route: { href: '/', label: 'Сводка' }
	},
	{
		id: 'card',
		title: 'Карточка отвечает на четыре вопроса',
		body: 'Что происходит, что мешает, кто должен действовать и что можно сделать сейчас. Ответы считает сервер, карточка их показывает.',
		target: 'interaction-summary',
		route: { href: '/interactions', label: 'Взаимодействия' },
		hint: 'Откройте любое взаимодействие из списка — блок стоит наверху карточки.',
		permission: 'interactions.read'
	},
	{
		id: 'transition',
		title: 'Переход стадии',
		body: 'Кнопка перехода открывает окно, где пишут комментарий и прикладывают файл. Недоступный переход остаётся на экране с причиной отказа, а не пропадает.',
		target: 'interaction-actions',
		route: { href: '/interactions', label: 'Взаимодействия' },
		hint: 'Откройте любое взаимодействие из списка — блок «Что могу сейчас» стоит справа.',
		permission: 'interactions.read'
	},
	{
		id: 'help',
		title: 'Справка и поиск',
		body: 'Руководства лежат в разделе «Справка». Поиск по системе открывается кнопкой в верхней панели или сочетанием Ctrl + K.',
		target: 'help-sections',
		route: { href: '/help', label: 'Справка' }
	}
];

const LEAD_STEPS: readonly OnboardingStep[] = [
	{
		id: 'portfolio',
		title: 'Портфель и задержки',
		body: 'Полоса показывает, где стоят активные взаимодействия области доступа, а список под ней — что просрочено и чего ждут от вуза.',
		target: 'home-portfolio',
		route: { href: '/', label: 'Сводка' }
	},
	{
		id: 'reports',
		title: 'Отчёт: от числа к подтверждению',
		body: 'Числа отчёта — ссылки: из числа открывается список, из списка — карточка, из карточки — документ. Выгрузка повторяет то же, что на экране.',
		target: 'reports-totals',
		route: { href: '/reports', label: 'Отчёты' },
		permission: 'interactions.read'
	},
	{
		id: 'reassign',
		title: 'Переназначение ответственного',
		body: 'Отметьте строки в списке — над таблицей появится «Назначить ответственного». Смена попадёт в историю каждой записи.',
		target: 'interactions-list',
		route: { href: '/interactions', label: 'Взаимодействия' },
		hint: 'Под текущий отбор не попало ни одной записи — снимите фильтры, чтобы увидеть список.',
		permission: 'interactions.reassign'
	},
	{
		id: 'notifications',
		title: 'Уведомления',
		body: 'Когда взаимодействие стоит на стадии дольше порога, напоминание уходит руководителю ответственного. Здесь видно, кому ушло, каким каналом и дошло ли.',
		target: 'notifications-log',
		route: { href: '/notifications', label: 'Уведомления' },
		permission: 'notifications.read'
	}
];

const ADMIN_STEPS: readonly OnboardingStep[] = [
	{
		id: 'process',
		title: 'Процесс описан данными',
		body: 'Стадии, нормативы и переходы правятся черновиком: сначала предпросмотр с числом затронутых записей, потом применение ко всем незавершённым взаимодействиям группы.',
		target: 'process-groups',
		route: { href: '/settings/process', label: 'Процесс' },
		permission: 'stages.configure'
	},
	{
		id: 'exchange',
		title: 'Внешние системы и журнал обмена',
		body: 'Заявки с сайта и учебные группы ходят по контракту обмена. В журнале видно, что пришло, что ушло, чем ответили и что можно повторить.',
		target: 'exchange-journal',
		route: { href: '/exchange', label: 'Внешние системы' },
		permission: 'integrations.manage'
	},
	{
		id: 'directory',
		title: 'Справочники и импорт',
		body: 'Организации, площадки и контакты ведутся в справочнике. Кнопка «Импорт каталога» заводит их файлом: разбор, предпросмотр, применение.',
		target: 'directory-import',
		route: { href: '/organizations', label: 'Организации' },
		permission: 'directory.import'
	},
	{
		id: 'help',
		title: 'Справка',
		body: 'Руководство администратора описывает процесс, доступ, интеграции, журнал и обслуживание стенда.',
		target: 'help-sections',
		route: { href: '/help', label: 'Справка' }
	}
];

/** Подсказки по ролям. Роли, которой здесь нет, тур не показывается. */
export const ONBOARDING_TOURS: Readonly<Record<string, readonly OnboardingStep[]>> = {
	manager: MANAGER_STEPS,
	lead: LEAD_STEPS,
	admin: ADMIN_STEPS
};

/**
 * Шаги, которые увидит эта учётная запись: тур её роли минус шаги, ведущие
 * туда, куда ей нельзя. Так демонстрационная сессия администратора не получает
 * подсказок о разделах, закрытых границей стенда.
 */
export function tourFor(roleId: string, permissions: ReadonlySet<string>): OnboardingStep[] {
	const steps = ONBOARDING_TOURS[roleId] ?? [];

	return steps.filter((step) => step.permission === undefined || permissions.has(step.permission));
}

/**
 * Стоит ли человек на том экране, которому принадлежит шаг. Раздел владеет
 * своим адресом и всем, что под ним: карточка взаимодействия — это тот же
 * экран, что и список, только с открытой записью.
 */
export function isStepScreen(step: OnboardingStep, pathname: string): boolean {
	return pathname === step.route.href || pathname.startsWith(`${step.route.href}/`);
}
