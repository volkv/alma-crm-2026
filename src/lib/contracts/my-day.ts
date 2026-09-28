/**
 * «Мой день»: что требует внимания сотрудника сегодня — на главной и в
 * утренней сводке.
 *
 * Экран и письмо показывают один и тот же список, поэтому словарь разделов,
 * подсказки к действию и строка-пояснение живут здесь, а не в компоненте и не
 * в тексте письма: два пересказа одного правила однажды разойдутся, и письмо
 * позовёт к тому, чего на главной нет.
 */

/**
 * Разделы в том порядке, в каком их читают: дело без ответственного некому
 * вести — его раздают первым, просрочку уже не вернуть, срок «сегодня» ещё
 * можно успеть, помеха сама не рассосётся, а новая заявка ждёт первого шага. Взаимодействие попадает в один раздел — первый подходящий:
 * одна и та же запись тремя строками превращает список дел в отчёт.
 */
export const MY_DAY_KINDS = [
	'unassigned',
	'overdue',
	'due_soon',
	'blocker',
	'stuck',
	'waiting',
	'application',
	'license'
] as const;

export type MyDayKind = (typeof MY_DAY_KINDS)[number];

/**
 * Разделы о делах — у них есть список с тем же набором (`day` в адресе
 * списка). Лицензия — строка об организации, а не о деле, и её в списке дел
 * нет.
 */
export const MY_DAY_INTERACTION_KINDS = [
	'unassigned',
	'overdue',
	'due_soon',
	'blocker',
	'stuck',
	'waiting',
	'application'
] as const satisfies readonly MyDayKind[];

export type MyDayInteractionKind = (typeof MY_DAY_INTERACTION_KINDS)[number];

export function isMyDayInteractionKind(kind: MyDayKind): kind is MyDayInteractionKind {
	return (MY_DAY_INTERACTION_KINDS as readonly MyDayKind[]).includes(kind);
}

export const MY_DAY_SECTIONS: Record<MyDayKind, { title: string; action: string }> = {
	unassigned: {
		title: 'Без ответственного',
		action: 'Назначьте ответственного на карточке дела'
	},
	overdue: {
		title: 'Просрочены стадии',
		action: 'Переведите на следующую стадию или поставьте паузу с причиной'
	},
	due_soon: {
		title: 'Срок стадии сегодня или завтра',
		action: 'Проверьте, что готово к переходу'
	},
	blocker: {
		title: 'Стоят помехи',
		action: 'Снимите помеху или поднимите её руководителю'
	},
	stuck: {
		title: 'Зависли на стадии',
		action: 'Сдвиньте стадию или запишите, что мешает'
	},
	waiting: {
		title: 'Ждём сторону дольше порога',
		action: 'Напомните стороне о себе или снимите паузу'
	},
	application: {
		title: 'Новые заявки с сайта за сутки',
		action: 'Разберите заявку и назначьте следующий шаг'
	},
	license: {
		title: 'Лицензии в окне продления',
		action: 'Запустите продление на карточке организации'
	}
};

/** Строка «Моего дня». */
export type MyDayItem = {
	kind: MyDayKind;
	/** Куда ведёт строка: карточка взаимодействия или организации (лицензия). */
	target: { type: 'interaction' | 'organization'; id: string };
	/** Название взаимодействия; у лицензии — продукт и договор. */
	title: string;
	/** Основная сторона или организация договора. */
	organizationName: string | null;
	/**
	 * Сторона — физическое лицо. Тогда её название — это ФИО, и заявка с сайта
	 * несёт его и в названии взаимодействия: в письмо не уходит ни то, ни другое.
	 */
	isPersonal: boolean;
	/** Что со строкой: стадия и срок словами, без свободного текста сотрудников. */
	detail: string;
	/**
	 * Помеха или кого ждём — текст, который написал сотрудник. Только для
	 * экрана: в нём бывают имена, и наружу, в письмо, он не уходит.
	 */
	note: string | null;
};

export type MyDaySection = {
	kind: MyDayKind;
	/** Первые строки раздела: это список на утро, а не отчёт. */
	items: MyDayItem[];
	/** Сколько строк в разделе всего. */
	total: number;
};

/**
 * Чья это работа: `own` — свои взаимодействия и вузы, `team` — вместе с
 * подчинёнными, `all` — вся система (полная область доступа).
 */
export type MyDayBasis = 'own' | 'team' | 'all';

export type MyDay = {
	generatedAt: Date;
	basis: MyDayBasis;
	/** Только непустые разделы, в порядке {@link MY_DAY_KINDS}. */
	sections: MyDaySection[];
};

/** Сколько строк раздела показывают экран и письмо. */
export const MY_DAY_SECTION_LIMIT = 5;

/**
 * Чья работа в списке — словами, без обещания лишнего. В область менеджера
 * входят не только дела, которые ведёт он сам, но и дела коллег по вузам, за
 * которые он отвечает (`interactionScopeFilter`); подпись «ваши» при чужом
 * деле в списке была бы неправдой. Только свои — кнопка «Мои взаимодействия».
 */
export const MY_DAY_BASIS_LABELS: Record<MyDayBasis, string> = {
	own: 'Дела, которые ведёте вы, и дела коллег по вузам, за которые вы отвечаете',
	team: 'Ваши дела, дела подчинённых и дела коллег по вашим вузам',
	all: 'Вся система: у вас полная область доступа'
};

/**
 * Как письмо называет взаимодействие с физическим лицом: его название и
 * название стороны — это ФИО, а письмо уходит в чужой почтовый ящик.
 */
export const PERSONAL_INTERACTION_TITLE = 'Взаимодействие с физическим лицом';

/** Название строки для письма: у физического лица — без ФИО. */
export function myDayLetterTitle(item: MyDayItem): string {
	if (!item.isPersonal) {
		// Название взаимодействия берётся в кавычки; у лицензии они уже стоят
		// вокруг продукта.
		const title = item.target.type === 'interaction' ? `«${item.title}»` : item.title;

		return item.organizationName === null ? title : `${title} (${item.organizationName})`;
	}

	return item.target.type === 'organization'
		? `Лицензия физического лица: ${item.title}`
		: PERSONAL_INTERACTION_TITLE;
}
