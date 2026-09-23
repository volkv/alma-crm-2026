import { resolve } from '$app/paths';
import type { ResolvedPathname } from '$app/types';
import {
	STAGE_CATEGORIES,
	type InteractionStatus,
	type StageCategory
} from '$lib/contracts/interactions';

/**
 * Фильтры списка взаимодействий живут в адресной строке рядом с состоянием
 * таблицы: список — это ссылка, и отобранный набор должен переживать «назад»,
 * закладку и пересылку коллеге. Разбирает и собирает их этот модуль, а читают
 * обе стороны — загрузка страницы и сама страница.
 *
 * Пространства среди фильтров нет: оно задано адресом. Выбирать больше нечего,
 * и второго способа сказать «чей процесс показать» в разделе не осталось.
 */

export type InteractionFilters = {
	status: InteractionStatus | null;
	stageCategory: StageCategory | null;
	overdue: boolean;
	/** Только те, где ответственный — текущий пользователь. */
	mine: boolean;
	/** Вуз — основная сторона взаимодействия. */
	org: string[];
	/** Направление — объединение направлений продуктов и программ, как в отчёте. */
	dir: string[];
	prog: string[];
	prod: string[];
};

const STATUS_VALUES = new Set(['active', 'completed', 'cancelled']);
const CATEGORY_VALUES = new Set<string>(STAGE_CATEGORIES);

/** Многозначный параметр списка: имена и смысл значений — как у отчёта (`org`, `dir`, `prog`, `prod`). */
export const LIST_ATTRIBUTE_PARAMS = ['org', 'dir', 'prog', 'prod'] as const;
export type ListAttributeParam = (typeof LIST_ATTRIBUTE_PARAMS)[number];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Значения многозначного параметра из адреса: через запятую и через повтор —
 * одно и то же, как у отчёта (`components/reports/query.ts`). Непонятное
 * значение (не идентификатор) отбрасывается молча — это не ошибка запроса, а
 * просто не фильтр: правят ссылку руками не реже, чем ссылку на отчёт.
 */
function readIds(url: URL, param: ListAttributeParam): string[] {
	return url.searchParams
		.getAll(param)
		.flatMap((value) => value.split(','))
		.map((value) => value.trim())
		.filter((value) => UUID_PATTERN.test(value));
}

export function readFilters(url: URL): InteractionFilters {
	const status = url.searchParams.get('status');
	const stageCategory = url.searchParams.get('stage');

	return {
		status: status !== null && STATUS_VALUES.has(status) ? (status as InteractionStatus) : null,
		stageCategory:
			stageCategory !== null && CATEGORY_VALUES.has(stageCategory)
				? (stageCategory as StageCategory)
				: null,
		overdue: url.searchParams.get('overdue') === 'true',
		mine: url.searchParams.get('mine') === 'true',
		org: readIds(url, 'org'),
		dir: readIds(url, 'dir'),
		prog: readIds(url, 'prog'),
		prod: readIds(url, 'prod')
	};
}

/** Список взаимодействий пространства: адрес, от которого считается остальное. */
export function listPath(workspace: string): ResolvedPathname {
	return resolve('/(app)/w/[workspace]/interactions', { workspace });
}

/**
 * Ссылка на тот же список с изменённым фильтром. Значение по умолчанию из
 * адреса убирается, чтобы два способа получить один и тот же набор давали одну
 * и ту же ссылку; состояние таблицы (страница, сортировка, поиск) сохраняется,
 * но страница сбрасывается на первую — иначе после сужения набора человек
 * оказывается на пустой странице.
 */
export function filtersHref(
	url: URL,
	workspace: string,
	changes: Partial<InteractionFilters>
): ResolvedPathname {
	const next = { ...readFilters(url), ...changes };
	const params = new URLSearchParams(url.searchParams);

	const apply = (key: string, value: string | null) => {
		if (value === null) {
			params.delete(key);
		} else {
			params.set(key, value);
		}
	};

	const applyIds = (key: ListAttributeParam, values: readonly string[]) => {
		apply(key, values.length === 0 ? null : values.join(','));
	};

	apply('status', next.status);
	apply('stage', next.stageCategory);
	apply('overdue', next.overdue ? 'true' : null);
	apply('mine', next.mine ? 'true' : null);
	applyIds('org', next.org);
	applyIds('dir', next.dir);
	applyIds('prog', next.prog);
	applyIds('prod', next.prod);
	params.delete('page');

	const query = params.toString();
	const path = listPath(workspace);

	// Путь известен: это всегда список взаимодействий этого пространства.
	// `resolve` зовётся с литералом, а не с `url.pathname`, потому что на
	// объединении всех адресов приложения перегрузка `resolve` уже не выводится.
	return (query ? `${path}?${query}` : path) as ResolvedPathname;
}

/**
 * Ссылка с добавленным или снятым значением многозначного фильтра: вуз,
 * направление, программа, продукт. Пункты дропдауна выбирают обычно несколько
 * подряд, и полная замена набора на каждый клик читалась бы как чужое
 * поведение по сравнению с одиночными фильтрами выше.
 */
export function toggledFilterHref(
	url: URL,
	workspace: string,
	param: ListAttributeParam,
	value: string
): ResolvedPathname {
	const current = readFilters(url)[param];
	const next = current.includes(value)
		? current.filter((item) => item !== value)
		: [...current, value];

	return filtersHref(url, workspace, { [param]: next } as Partial<InteractionFilters>);
}

/**
 * Тот же список без единого условия отбора: фильтры, поиск и номер страницы
 * сняты, а как список показан и как отсортирован — оставлено. Пустое состояние
 * советует снять отбор, и снимать его должно нажатие, а не сборка адреса
 * руками.
 */
export function clearedFiltersHref(url: URL, workspace: string): ResolvedPathname {
	const params = new URLSearchParams(url.searchParams);

	for (const name of [
		'status',
		'stage',
		'overdue',
		'mine',
		'q',
		'page',
		...LIST_ATTRIBUTE_PARAMS
	]) {
		params.delete(name);
	}

	const query = params.toString();
	const path = listPath(workspace);

	return (query ? `${path}?${query}` : path) as ResolvedPathname;
}

/** Подписи смысловых групп стадий — те же, что в карточке и в ленте. */
export const STAGE_CATEGORY_LABELS: Record<StageCategory, string> = {
	contact: 'Контакты',
	documents: 'Документы',
	delivery: 'Передача',
	implementation: 'Внедрение',
	training: 'Обучение',
	teaching: 'Занятия',
	update: 'Актуализация',
	control: 'Контроль'
};

export const INTERACTION_STATUS_LABELS: Record<InteractionStatus, string> = {
	active: 'В работе',
	completed: 'Завершено',
	cancelled: 'Отменено'
};
