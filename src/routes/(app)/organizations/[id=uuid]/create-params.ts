import { resolve } from '$app/paths';
import type { ResolvedPathname } from '$app/types';
import { CREATE_PARAM } from '$lib/components/create-dialog/open-param';

/**
 * На карточке организации два окна создания — контакта и площадки, поэтому
 * `?create` здесь несёт значение: какое из них открыть при загрузке.
 */
export const CREATE_AFFILIATION = 'affiliation';
export const CREATE_SITE = 'site';

/** Человек, приходящий в окно контакта уже выбранным: `&person=<id>`. */
export const PERSON_PARAM = 'person';

/** Какое окно просит открыть адрес; `null` — никакое. */
export function requestedCreate(url: URL): typeof CREATE_AFFILIATION | typeof CREATE_SITE | null {
	const value = url.searchParams.get(CREATE_PARAM);

	if (value === CREATE_AFFILIATION || value === CREATE_SITE) {
		return value;
	}

	return null;
}

/**
 * Карточка организации с открытым окном контакта, в котором человек уже
 * выбран. Путь собран `resolve`; добавлена только строка запроса, а её типа в
 * `ResolvedPathname` нет (тот же приём — `home/links.ts`).
 */
export function affiliationCreateHref(organizationId: string, personId: string): ResolvedPathname {
	const path = resolve('/(app)/organizations/[id=uuid]', { id: organizationId });

	return `${path}?${CREATE_PARAM}=${CREATE_AFFILIATION}&${PERSON_PARAM}=${encodeURIComponent(personId)}` as ResolvedPathname;
}
