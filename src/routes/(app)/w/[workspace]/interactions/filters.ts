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
};

const STATUS_VALUES = new Set(['active', 'completed', 'cancelled']);
const CATEGORY_VALUES = new Set<string>(STAGE_CATEGORIES);

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
		mine: url.searchParams.get('mine') === 'true'
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

	apply('status', next.status);
	apply('stage', next.stageCategory);
	apply('overdue', next.overdue ? 'true' : null);
	apply('mine', next.mine ? 'true' : null);
	params.delete('page');

	const query = params.toString();
	const path = listPath(workspace);

	// Путь известен: это всегда список взаимодействий этого пространства.
	// `resolve` зовётся с литералом, а не с `url.pathname`, потому что на
	// объединении всех адресов приложения перегрузка `resolve` уже не выводится.
	return (query ? `${path}?${query}` : path) as ResolvedPathname;
}

/**
 * Тот же список без единого условия отбора: фильтры, поиск и номер страницы
 * сняты, а как список показан и как отсортирован — оставлено. Пустое состояние
 * советует снять отбор, и снимать его должно нажатие, а не сборка адреса
 * руками.
 */
export function clearedFiltersHref(url: URL, workspace: string): ResolvedPathname {
	const params = new URLSearchParams(url.searchParams);

	for (const name of ['status', 'stage', 'overdue', 'mine', 'q', 'page']) {
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
