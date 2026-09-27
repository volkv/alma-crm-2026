import { resolve } from '$app/paths';
import type { ResolvedPathname } from '$app/types';
import type {
	InteractionListState,
	InteractionStatus,
	StageCategory
} from '$lib/contracts/interactions';
import type { MyDayInteractionKind } from '$lib/contracts/my-day';

/**
 * Ссылки со сводки в список взаимодействий.
 *
 * Плитка сводки — это вопрос, а список под фильтром — ответ на него, поэтому
 * число на главной обязано вести ровно в тот набор, из которого посчитано.
 * Имена параметров те же, что читает список (`interactions/filters.ts`): адрес
 * — это контракт между двумя страницами, и придумывать для него второй словарь
 * нельзя.
 *
 * Список живёт в пространстве, а сводка считает по всем пространствам сразу.
 * Поэтому ссылка — всегда в конкретное пространство, а число плитки, если
 * работа есть в нескольких, раскладывается по ним (`WorkspaceCount`): сумма
 * частей равна плитке, и каждая часть — ровно столько строк, сколько в списке
 * по её ссылке. Прежний адрес `/interactions` уводил в одно пространство и
 * показывал там часть числа.
 */
export type InteractionsFilter = {
	status: InteractionStatus;
	stageCategory?: StageCategory;
	overdue?: boolean;
	/** Состояние портфеля: пауза, помехи, тишина. */
	state?: InteractionListState;
	/** Раздел «Моего дня». */
	day?: MyDayInteractionKind;
	/** Закрыты за последние N дней. */
	closedWithin?: number;
	/** Ответственный: «мои» — это отбор по себе, как аватаркой над списком. */
	owner?: string;
};

/** Часть числа плитки, приходящаяся на одно пространство, и ссылка на неё. */
export type WorkspaceCount = {
	key: string;
	name: string;
	count: number;
	href: ResolvedPathname;
};

/**
 * Список пространства под фильтром плитки. Всегда таблицей: на доске нет
 * фильтров стадии, состояния, раздела «Моего дня» и окна закрытия, завершённых
 * она не показывает, а в колонке видна не каждая запись — число на плитке обязано совпасть со строками, а их считает таблица.
 */
export function interactionsHref(
	workspaceKey: string,
	filter: InteractionsFilter
): ResolvedPathname {
	const params = new URLSearchParams();

	params.set('status', filter.status);

	if (filter.stageCategory !== undefined) {
		params.set('stage', filter.stageCategory);
	}

	if (filter.overdue === true) {
		params.set('overdue', 'true');
	}

	if (filter.state !== undefined) {
		params.set('state', filter.state);
	}

	if (filter.day !== undefined) {
		params.set('day', filter.day);
	}

	if (filter.closedWithin !== undefined) {
		params.set('closed', String(filter.closedWithin));
	}

	if (filter.owner !== undefined) {
		params.set('owner', filter.owner);
	}

	params.set('view', 'table');

	const path = resolve('/(app)/w/[workspace]/interactions', { workspace: workspaceKey });

	// Меняется только строка запроса, а её типа в `ResolvedPathname` нет.
	return `${path}?${params.toString()}` as ResolvedPathname;
}

/**
 * Куда ведёт плитка целиком: в список, если вся работа в одном пространстве.
 * Если в нескольких — `null`: одной ссылкой такой набор не открыть, и плитка
 * показывает части по пространствам.
 */
export function singleHref(parts: readonly WorkspaceCount[]): ResolvedPathname | null {
	return parts.length === 1 ? parts[0].href : null;
}

/** Карточка взаимодействия: из любой строки сводки открывается она же. */
export function interactionHref(id: string): ResolvedPathname {
	return resolve('/(app)/interactions/[id=uuid]', { id });
}

/** Карточка организации: к ней ведёт строка о лицензии. */
export function organizationHref(id: string): ResolvedPathname {
	return resolve('/(app)/organizations/[id=uuid]', { id });
}
