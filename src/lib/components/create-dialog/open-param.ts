/**
 * Параметр адреса, который открывает окно создания сразу после загрузки
 * страницы: `?create`. Так на окно ведут ссылки с других экранов (карточка
 * организации → новое взаимодействие с ней, быстрые действия поиска), где
 * самого окна нет.
 */
export const CREATE_PARAM = 'create';

/** Ссылка на экран с открытым окном создания; `extra` — подстановки в форму. */
export function createHref(path: string, extra: Record<string, string> = {}): string {
	const params = new URLSearchParams(extra);
	const query = params.toString();

	return query === '' ? `${path}?${CREATE_PARAM}` : `${path}?${CREATE_PARAM}&${query}`;
}

/** Просит ли адрес открыть окно создания. */
export function wantsCreate(url: URL): boolean {
	return url.searchParams.has(CREATE_PARAM);
}
