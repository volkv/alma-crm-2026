/**
 * Разбор адреса отчёта.
 *
 * Фильтры живут в адресной строке и являются единственным источником для
 * таблицы, диаграмм и всех четырёх выгрузок: экран — это ссылка, а выгрузка —
 * та же ссылка с другим расширением. Значит, разбирать её обязан один модуль, и
 * страница с эндпоинтом выгрузки зовут именно его.
 */
import {
	REPORT_PARAMS,
	periodIssues,
	quarterStart,
	reportQuerySchema,
	type ReportQuery
} from '$lib/contracts/reports';
import { formatIsoDay, pluralize } from '$lib/format';
import type { ActorContext } from '../actor';
import { ValidationError } from '../errors';

/**
 * Запрос отчёта из адреса. Период по умолчанию — от начала текущего квартала до
 * сегодня: это тот вопрос, который задают чаще всего, и открытый без параметров
 * раздел обязан показывать числа, а не пустую форму.
 *
 * Непонятное значение многозначного фильтра отбрасывается — человек правил
 * ссылку руками, и показывать ему отказ вместо отчёта незачем. А вот
 * испорченная дата периода отбрасыванию не подлежит: молча подставленный вместо
 * неё квартал означал бы отчёт не за тот период, о чём читающий не узнает.
 * Недоступное пространство — тоже не отбрасывается, а отвечает «не найдено»
 * при сборке (`readReportStageIndex`): без него выборка стала бы шире вопроса.
 */
export function readReportQuery(url: URL, today: string = formatIsoDay()): ReportQuery {
	const raw: Record<string, string[] | string> = {};

	for (const param of REPORT_PARAMS) {
		const values = url.searchParams.getAll(param);

		if (values.length > 0) {
			raw[param] = values;
		}
	}

	const parsed = reportQuerySchema.safeParse({
		...raw,
		mode: url.searchParams.get('mode') ?? undefined,
		from: url.searchParams.get('from') ?? quarterStart(today),
		to: url.searchParams.get('to') ?? today,
		overdue: url.searchParams.get('overdue') ?? undefined,
		paused: url.searchParams.get('paused') ?? undefined
	});

	if (!parsed.success) {
		throw new ValidationError(
			'Отчёт по такому адресу не собрать',
			parsed.error.issues.map((issue) => issue.message)
		);
	}

	const issues = periodIssues(parsed.data);

	if (issues.length > 0) {
		throw new ValidationError('Отчёт по такому адресу не собрать', issues);
	}

	return parsed.data;
}

/**
 * Адрес общего отчёта (или его выгрузки) с охватом одного пространства — для
 * прежних адресов `/w/<ключ>/reports`. Строка запроса переезжает целиком, а
 * пространство из пути заменяет собой любые `workspace` в ней: вопрос ссылки —
 * это пространство из её пути.
 */
export function scopedReportAddress(path: string, url: URL, workspaceKey: string): string {
	const params = new URLSearchParams(url.searchParams);

	params.delete('workspace');
	params.append('workspace', workspaceKey);

	return `${path}?${params.toString()}`;
}

/**
 * Область доступа словами — для шапки выгрузки. Числа отчёта зависят от того,
 * кто его собрал, и файл обязан об этом говорить: иначе две выгрузки с разными
 * числами выглядят как ошибка системы.
 *
 * Область — это множество людей, а не организаций (`docs/access-matrix.md`,
 * раздел 1), поэтому и описывается она людьми и пространствами: список вузов,
 * посчитанный на момент сборки, к завтрашнему дню был бы уже другим.
 */
export function describeScope(ctx: ActorContext): string {
	if (ctx.scope.kind === 'all') {
		return 'все взаимодействия';
	}

	const people = ctx.scope.userIds.size;
	const places = ctx.scope.workspaceIds.size;

	return people === 0 || places === 0
		? 'ничего: область доступа пуста'
		: `вузы и взаимодействия ${pluralize(people, ['сотрудника', 'сотрудников', 'сотрудников'])} в ${pluralize(places, ['пространстве', 'пространствах', 'пространствах'])}`;
}
