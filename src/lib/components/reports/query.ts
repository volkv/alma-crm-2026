import { resolve } from '$app/paths';
import type { ResolvedPathname } from '$app/types';
import {
	REPORT_PARAMS,
	type ReportFormat,
	type ReportMode,
	type ReportPdfLayout,
	type ReportParam
} from '$lib/contracts/reports';

/**
 * Адрес отчёта. Экран — это ссылка, а выгрузка — та же ссылка с другим
 * расширением, поэтому имена параметров знает один модуль, и читают его обе
 * стороны: загрузчик страницы разбирает адрес, панель фильтров его собирает.
 *
 * Значение по умолчанию из адреса убирается: два способа получить один и тот же
 * отчёт обязаны дать одну и ту же ссылку, иначе пересланная коллеге ссылка
 * отличается от своей же, набранной заново.
 *
 * Отчёт живёт внутри пространства (`/w/<ключ>/reports`), и все ссылки экрана —
 * от текущего пространства: ключ берётся из пути открытого адреса, а не из
 * параметра. Перейти отсюда в отчёт соседнего пространства нельзя — это другой
 * процесс и другой отчёт, в него ведёт меню.
 */

/** Изменение фильтра: значение, список значений или «убрать параметр». */
export type ReportChanges = Partial<Record<ReportParam, string | readonly string[] | null>>;

/** Ключ пространства в пути отчёта; всё до него — базовый путь приложения. */
const WORKSPACE_IN_PATH = /\/w\/([^/]+)\/reports(?:\/|$)/;

/**
 * Пространство открытого отчёта — из пути. Адрес без него означал бы, что
 * ссылку собирают не на экране отчёта, а молча выбранное соседнее пространство
 * показало бы чужую работу под своим заголовком, поэтому здесь — отказ.
 */
function workspaceOf(url: URL): string {
	const match = WORKSPACE_IN_PATH.exec(url.pathname);

	if (match === null) {
		throw new Error(`Адрес не принадлежит отчёту пространства: ${url.pathname}`);
	}

	return decodeURIComponent(match[1]);
}

/** Адрес отчёта текущего пространства. */
function reportsPath(url: URL): ResolvedPathname {
	return resolve('/(app)/w/[workspace]/reports', { workspace: workspaceOf(url) });
}

function applyChanges(url: URL, changes: ReportChanges): URLSearchParams {
	const params = new URLSearchParams(url.searchParams);

	for (const [param, value] of Object.entries(changes)) {
		if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
			params.delete(param);
		} else if (Array.isArray(value)) {
			// Многозначные параметры пишутся через запятую: так ссылка читается
			// глазами и не растёт повторами одного имени.
			params.set(param, value.join(','));
		} else {
			params.set(param, String(value));
		}
	}

	// Страница таблицы сбрасывается при любой смене выборки: после сужения
	// набора человек иначе оказывается на пустой странице.
	params.delete('page');

	return params;
}

export function reportHref(url: URL, changes: ReportChanges): ResolvedPathname {
	const query = applyChanges(url, changes).toString();
	const path = reportsPath(url);

	return (query ? `${path}?${query}` : path) as ResolvedPathname;
}

/** Текущие значения многозначного параметра. */
export function selectedValues(url: URL, param: ReportParam): string[] {
	return url.searchParams
		.getAll(param)
		.flatMap((value) => value.split(','))
		.map((value) => value.trim())
		.filter((value) => value !== '');
}

/** Ссылка с добавленным или снятым значением многозначного фильтра. */
export function toggledHref(url: URL, param: ReportParam, value: string): ResolvedPathname {
	const current = selectedValues(url, param);
	const next = current.includes(value)
		? current.filter((item) => item !== value)
		: [...current, value];

	return reportHref(url, { [param]: next } as ReportChanges);
}

/** Ссылка на тот же отчёт в другом режиме. */
export function modeHref(url: URL, mode: ReportMode): ResolvedPathname {
	return reportHref(url, { mode });
}

/** Режим и период отчёта — то, без чего его числа не читаются. */
export type ReportPeriod = { mode: ReportMode; from: string; to: string };

/**
 * Переход от столбца диаграммы к списку взаимодействий, которые за ним стоят.
 *
 * Список — это таблица того же отчёта под диаграммой: только она считает стадию
 * на дату среза так же, как воронка, и только на ней число строк совпадает с
 * числом на столбце. Общий список `/interactions` показывает **текущую** стадию
 * и ни периода, ни режима не знает — переход туда молча показал бы другой набор.
 *
 * Переход добавляет к выборке ключ стадии и **не снимает** остальные фильтры:
 * вуз, направление, программа, продукт, ответственный и состояние остаются в
 * адресе, потому что столбец нарисован под ними же. Пространство стоит в пути и
 * не меняется. Режим и период выписываются явно: ссылку отправляют коллеге, а
 * «сегодня» у него наступит завтра.
 */
export function stageDrilldownHref(
	url: URL,
	period: ReportPeriod,
	stageKey: string
): ResolvedPathname {
	return reportHref(url, { ...period, stage: stageKey });
}

/**
 * Переход от столбца динамики: период сужается до интервала столбца, режим и
 * все фильтры остаются. Стадии у столбца нет — он про время, а не про место.
 */
export function movementDrilldownHref(
	url: URL,
	mode: ReportMode,
	bucket: { from: string; to: string }
): ResolvedPathname {
	return reportHref(url, { mode, from: bucket.from, to: bucket.to });
}

/** Ссылка с пустым фильтром: остаются только режим и период. */
export function clearedHref(url: URL): ResolvedPathname {
	const changes: ReportChanges = {};

	for (const param of REPORT_PARAMS) {
		if (param !== 'mode' && param !== 'from' && param !== 'to' && param !== 'cols') {
			changes[param] = null;
		}
	}

	return reportHref(url, changes);
}

/**
 * Ссылка на другую страницу таблицы. Единственное место, где `page` в адресе
 * сохраняется: все остальные ссылки его убирают, потому что меняют выборку.
 */
export function pageHref(url: URL, number: number): ResolvedPathname {
	const params = new URLSearchParams(url.searchParams);

	if (number <= 1) {
		params.delete('page');
	} else {
		params.set('page', String(number));
	}

	const query = params.toString();
	const path = reportsPath(url);

	return (query ? `${path}?${query}` : path) as ResolvedPathname;
}

/**
 * Ссылка на выгрузку. В неё уходят только фильтры отчёта: страница таблицы и
 * прочее состояние экрана к содержимому файла отношения не имеют. У PDF в
 * ссылке стоит и вид — сводка или полный отчёт. Пространство — то же, что у
 * экрана: выгрузка лежит под его адресом.
 */
export function exportHref(
	url: URL,
	format: ReportFormat,
	pdfLayout: ReportPdfLayout = 'summary'
): ResolvedPathname {
	const params = new URLSearchParams();

	for (const param of REPORT_PARAMS) {
		const value = url.searchParams.get(param);

		if (value !== null && value !== '') {
			params.set(param, value);
		}
	}

	params.set('format', format);

	if (format === 'pdf') {
		params.set('pdf', pdfLayout);
	}

	const path = resolve('/(app)/w/[workspace]/reports/export', { workspace: workspaceOf(url) });

	return `${path}?${params.toString()}` as ResolvedPathname;
}

/**
 * Ссылка «те же взаимодействия в списке».
 *
 * Список взаимодействий понимает не все фильтры отчёта: у него есть состояние,
 * смысловая группа стадии, просрочка и «мои» — и ни вуза, ни направления, ни
 * продукта. Поэтому переносится то, что список действительно умеет, а о
 * несовпадении экран говорит словами рядом со ссылкой: молча суженный или
 * расширенный список хуже, чем честно неполный.
 *
 * Пространство переносится адресом: у списка оно стоит в пути, как и у отчёта,
 * и ссылка ведёт в список того же пространства.
 */
export function interactionsHref(url: URL): ResolvedPathname {
	const params = new URLSearchParams();
	const states = selectedValues(url, 'state');

	if (states.length === 1) {
		params.set('status', states[0]);
	}

	if (url.searchParams.get('overdue') === 'true') {
		params.set('overdue', 'true');
	}

	// Список — таблица: доска показывает не все записи колонки и не показывает
	// завершённых, а ссылку открывают, чтобы сверить набор со строками отчёта.
	params.set('view', 'table');

	const query = params.toString();
	const path = resolve('/(app)/w/[workspace]/interactions', { workspace: workspaceOf(url) });

	return (query ? `${path}?${query}` : path) as ResolvedPathname;
}

/** Какие фильтры отчёта список взаимодействий не понимает. */
export function unsupportedListFilters(url: URL): string[] {
	const dropped: string[] = [];
	const named: [ReportParam, string][] = [
		['org', 'вуз'],
		['dir', 'направление'],
		['prog', 'программа'],
		['prod', 'продукт'],
		['owner', 'ответственный'],
		['assignee', 'ответственный за вуз'],
		['stage', 'стадия'],
		['transfer', 'статус передачи'],
		['party', 'тип контрагента'],
		['paused', 'на паузе']
	];

	for (const [param, label] of named) {
		if (selectedValues(url, param).length > 0) {
			dropped.push(label);
		}
	}

	if (selectedValues(url, 'state').length > 1) {
		dropped.push('несколько состояний сразу');
	}

	return dropped;
}
