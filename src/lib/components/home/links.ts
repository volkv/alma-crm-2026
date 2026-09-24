import { resolve } from '$app/paths';
import type { ResolvedPathname } from '$app/types';
import type { InteractionStatus, StageCategory } from '$lib/contracts/interactions';

/**
 * Ссылки со сводки в список взаимодействий.
 *
 * Плитка сводки — это вопрос, а список под фильтром — ответ на него, поэтому
 * число на главной обязано вести ровно в тот набор, из которого посчитано.
 * Имена параметров те же, что читает список (`interactions/filters.ts`): адрес
 * — это контракт между двумя страницами, и придумывать для него второй словарь
 * нельзя.
 */
export type InteractionsFilter = {
	status?: InteractionStatus;
	stageCategory?: StageCategory;
	overdue?: boolean;
	mine?: boolean;
};

const LIST_PATH = resolve('/interactions');

export function interactionsHref(filter: InteractionsFilter): ResolvedPathname {
	const params = new URLSearchParams();

	if (filter.status !== undefined) {
		params.set('status', filter.status);
	}

	if (filter.stageCategory !== undefined) {
		params.set('stage', filter.stageCategory);
	}

	if (filter.overdue === true) {
		params.set('overdue', 'true');
	}

	if (filter.mine === true) {
		params.set('mine', 'true');
	}

	const query = params.toString();

	// Путь известен и постоянен, `resolve` позвали с литералом выше; меняется
	// только строка запроса, а её типа в `ResolvedPathname` нет.
	return (query === '' ? LIST_PATH : `${LIST_PATH}?${query}`) as ResolvedPathname;
}

/** Карточка взаимодействия: из любой строки сводки открывается она же. */
export function interactionHref(id: string): ResolvedPathname {
	return resolve('/(app)/interactions/[id=uuid]', { id });
}

/** Карточка организации: к ней ведёт строка о лицензии. */
export function organizationHref(id: string): ResolvedPathname {
	return resolve('/(app)/organizations/[id=uuid]', { id });
}
