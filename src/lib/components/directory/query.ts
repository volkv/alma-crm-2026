import { resolve } from '$app/paths';
import type { Pathname, ResolvedPathname } from '$app/types';

/**
 * Адреса списков справочника.
 *
 * `DataTable` владеет своими параметрами (страница, размер, сортировка, поиск)
 * и собирает их сам; здесь — параметры, которые заводит страница: фильтры и
 * служебный `done`. Правило то же, что у таблицы: состояние живёт в адресе,
 * значит его сборка — одно место на всех, а не строка, склеенная в компоненте.
 */
function href(url: URL, params: URLSearchParams): ResolvedPathname {
	const query = params.toString();
	// `url.pathname` — путь этого же приложения; `resolve` лишь добавит базовый путь.
	const path = url.pathname as Pathname;

	// `resolve()` разбирает аргумент по ветвям объединения `Pathname`, и начиная
	// примерно с двадцати пяти маршрутов TypeScript перестаёт сопоставлять
	// объединение целиком хоть с одной ветвью. Путь здесь уже собран и
	// параметров в нём нет — `resolve()` только добавит базовый путь, — поэтому
	// он подаётся как одна ветвь объединения.
	return query ? resolve(`${path}?${query}` as `/?${string}`) : resolve(path as Pathname & '/');
}

/**
 * Тот же список с другим значением фильтра. Пустое значение снимает фильтр, а
 * номер страницы сбрасывается: третьей страницы у нового набора строк может и
 * не быть.
 */
export function filterHref(url: URL, param: string, value: string): ResolvedPathname {
	const params = new URLSearchParams(url.searchParams);

	if (value === '') {
		params.delete(param);
	} else {
		params.set(param, value);
	}

	params.delete('page');

	return href(url, params);
}

/** Тот же адрес без указанного параметра. */
export function withoutParam(url: URL, param: string): ResolvedPathname {
	const params = new URLSearchParams(url.searchParams);
	params.delete(param);

	return href(url, params);
}

/**
 * Тот же список без отбора: перечисленные фильтры страницы сняты вместе с
 * поиском и номером страницы `DataTable` (`q`, `page`) — как список
 * отсортирован и каким размером показан, остаётся. Пустое состояние по
 * фильтру предлагает снять его одним нажатием, а не собирать чистую ссылку
 * руками (тот же приём, что у списка взаимодействий —
 * `w/[workspace]/interactions/filters.ts`, `clearedFiltersHref`).
 */
export function clearedFiltersHref(url: URL, params: readonly string[]): ResolvedPathname {
	const next = new URLSearchParams(url.searchParams);

	for (const name of [...params, 'q', 'page']) {
		next.delete(name);
	}

	return href(url, next);
}
