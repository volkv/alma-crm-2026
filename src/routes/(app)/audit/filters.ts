/**
 * Фильтр журнала живёт в строке запроса.
 *
 * Выборка из журнала — это ссылка: её кладут в задачу, отправляют коллеге и
 * открывают той же выгрузкой. Поэтому имена параметров знает один модуль, и
 * пользуются им обе стороны: загрузчик страницы и выгрузка читают фильтр
 * отсюда, а панель фильтров отсюда же собирает следующий адрес.
 */
import { error } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import type { Pathname, ResolvedPathname } from '$app/types';
import { auditFilterSchema, type AuditExportFormat, type AuditFilter } from '$lib/contracts/audit';

export type AuditFilterParam =
	'from' | 'to' | 'type' | 'outcome' | 'source' | 'actor' | 'subjectType' | 'subject';

/**
 * Признак того, что выгрузку не отдали: его ставит перенаправление из
 * `/audit/export`, а страница по нему рисует объяснение. Это не фильтр, и в
 * следующей ссылке ему делать нечего — любая правка списка его убирает.
 */
export const AUDIT_DENIED_PARAM = 'denied';

/** Все параметры фильтра; порядок — тот же, в каком они стоят в панели. */
export const AUDIT_FILTER_PARAMS: readonly AuditFilterParam[] = [
	'from',
	'to',
	'type',
	'outcome',
	'source',
	'actor',
	'subjectType',
	'subject'
];

/**
 * Оператор работает по Москве, и границы периода задаются календарными днями:
 * «с 1 по 3 сентября» — это с полуночи первого по конец третьего, а не сутки,
 * отсчитанные от часового пояса машины. Смещение у Москвы постоянное, поэтому
 * день начинается и кончается в заранее известный момент (см. `$lib/format`).
 */
const MOSCOW_OFFSET = '+03:00';

function dayStart(value: string | null): string | null {
	return value === null || value === '' ? null : `${value}T00:00:00${MOSCOW_OFFSET}`;
}

function dayEnd(value: string | null): string | null {
	return value === null || value === '' ? null : `${value}T23:59:59.999${MOSCOW_OFFSET}`;
}

/**
 * Фильтр из адреса страницы.
 *
 * Непонятный параметр не отбрасывается молча: человек видит его в адресе и
 * будет уверен, что выборка сужена, — поэтому вместо тихой подмены значением по
 * умолчанию запрос отвечает 400 и называет, что именно не разобрано.
 */
export function readAuditFilter(url: URL): AuditFilter {
	const parsed = auditFilterSchema.safeParse({
		from: dayStart(url.searchParams.get('from')),
		to: dayEnd(url.searchParams.get('to')),
		eventType: url.searchParams.getAll('type'),
		outcome: url.searchParams.getAll('outcome'),
		source: url.searchParams.getAll('source'),
		actorUserId: url.searchParams.get('actor'),
		subjectType: url.searchParams.get('subjectType'),
		subjectId: url.searchParams.get('subject'),
		q: url.searchParams.get('q')
	});

	if (!parsed.success) {
		error(
			400,
			`Фильтр журнала не разобран: ${parsed.error.issues.map((i) => i.message).join('; ')}`
		);
	}

	return parsed.data;
}

/** Стоит ли на списке хоть один фильтр — от этого зависит кнопка «Сбросить». */
export function hasAuditFilter(url: URL): boolean {
	return (
		AUDIT_FILTER_PARAMS.some((name) => url.searchParams.has(name)) || url.searchParams.has('q')
	);
}

type AuditFilterChanges = Partial<Record<AuditFilterParam, string | string[] | null>>;

/**
 * Адрес той же страницы с изменённым фильтром. `null` и пустая строка убирают
 * параметр: адрес без параметра и есть «без фильтра», двух способов сказать одно
 * и то же в ссылке быть не должно.
 */
export function auditHref(url: URL, changes: AuditFilterChanges): ResolvedPathname {
	const params = new URLSearchParams(url.searchParams);

	for (const [name, value] of Object.entries(changes)) {
		if (value === undefined) {
			continue;
		}

		params.delete(name);

		if (Array.isArray(value)) {
			for (const item of value) {
				params.append(name, item);
			}
		} else if (value !== null && value !== '') {
			params.set(name, value);
		}
	}

	// Под новым условием третьей страницы может не быть вовсе, поэтому смена
	// фильтра всегда возвращает к первой.
	params.delete('page');
	params.delete(AUDIT_DENIED_PARAM);

	return withQuery(url.pathname as Pathname, params);
}

/** Адрес страницы без единого фильтра; размер страницы и сортировка остаются. */
export function clearedAuditHref(url: URL): ResolvedPathname {
	const params = new URLSearchParams(url.searchParams);

	for (const name of [...AUDIT_FILTER_PARAMS, 'q', 'page', AUDIT_DENIED_PARAM]) {
		params.delete(name);
	}

	return withQuery(url.pathname as Pathname, params);
}

/** Выгрузка идёт под тем же фильтром, что и список, но без разбивки на страницы. */
export function exportHref(url: URL, format: AuditExportFormat): ResolvedPathname {
	const params = new URLSearchParams();

	for (const name of AUDIT_FILTER_PARAMS) {
		for (const value of url.searchParams.getAll(name)) {
			params.append(name, value);
		}
	}

	const search = url.searchParams.get('q');
	if (search !== null && search !== '') {
		params.set('q', search);
	}

	params.set('format', format);

	return withQuery('/audit/export', params);
}

function withQuery(path: Pathname, params: URLSearchParams): ResolvedPathname {
	const query = params.toString();

	// `resolve()` разбирает аргумент по ветвям объединения `Pathname`, и начиная
	// примерно с двадцати пяти маршрутов TypeScript перестаёт сопоставлять
	// объединение целиком хоть с одной ветвью. Путь здесь уже собран и параметров
	// в нём нет — `resolve()` только добавит базовый путь, — поэтому он подаётся
	// как одна ветвь объединения (тот же приём, что в `data-table/query.ts`).
	return query === ''
		? resolve(path as Pathname & '/')
		: resolve(`${path}?${query}` as `/?${string}`);
}
