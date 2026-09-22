/**
 * Фильтры отчёта словами.
 *
 * Лист «Фильтры» и шапка PDF обязаны отвечать на вопрос «что это за числа» без
 * доступа к системе: файл живёт дальше сам по себе, и идентификатор записи в
 * нём не значит ничего. Поэтому каждый выбранный фильтр разворачивается в
 * названия — одним запросом на справочник и только когда фильтр задан.
 */
import { inArray } from 'drizzle-orm';
import {
	REPORT_MODE_LABELS,
	REPORT_PARTY_LABELS,
	REPORT_STATE_LABELS,
	type ReportFilterView,
	type ReportQuery
} from '$lib/contracts/reports';
import { formatDate } from '$lib/format';
import { getDb } from '../db';
import { directions, organizations, products, programs, users, workspaces } from '../db/schema';

async function namesByIds(
	ids: readonly string[],
	load: (ids: string[]) => Promise<{ id: string; name: string }[]>
): Promise<string[]> {
	if (ids.length === 0) {
		return [];
	}

	const rows = await load([...ids]);
	const byId = new Map(rows.map((row) => [row.id, row.name]));

	// Идентификатор, которому не нашлось записи, печатается как есть: он стоит в
	// адресе и влияет на выборку, и молча пропасть из описания не должен.
	return ids.map((id) => byId.get(id) ?? id);
}

/**
 * Описание фильтров. Стадии называются по ключу через переданную функцию:
 * актуальное название стадии знает только индекс процесса, а он собирается
 * вместе с отчётом.
 */
export async function describeFilters(
	query: ReportQuery,
	stageName: (key: string) => string
): Promise<ReportFilterView[]> {
	const db = getDb();

	const [
		organizationNames,
		directionNames,
		programNames,
		productNames,
		ownerNames,
		assigneeNames,
		workspaceNames
	] = await Promise.all([
		namesByIds(query.org, (ids) =>
			db
				.select({ id: organizations.id, name: organizations.shortName })
				.from(organizations)
				.where(inArray(organizations.id, ids))
		),
		namesByIds(query.dir, (ids) =>
			db
				.select({ id: directions.id, name: directions.name })
				.from(directions)
				.where(inArray(directions.id, ids))
		),
		namesByIds(query.prog, (ids) =>
			db
				.select({ id: programs.id, name: programs.name })
				.from(programs)
				.where(inArray(programs.id, ids))
		),
		namesByIds(query.prod, (ids) =>
			db
				.select({ id: products.id, name: products.name })
				.from(products)
				.where(inArray(products.id, ids))
		),
		namesByIds(query.owner, (ids) =>
			db.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, ids))
		),
		namesByIds(query.assignee, (ids) =>
			db.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, ids))
		),
		query.workspace.length === 0
			? Promise.resolve([])
			: db
					.select({ key: workspaces.key, name: workspaces.name })
					.from(workspaces)
					.where(inArray(workspaces.key, [...query.workspace]))
					.then((rows) => rows.map((row) => row.name))
	]);

	const filters: ReportFilterView[] = [
		{ label: 'Режим', value: REPORT_MODE_LABELS[query.mode] },
		{ label: 'Период', value: `${formatDate(query.from)} — ${formatDate(query.to)}` }
	];

	const add = (label: string, values: readonly string[]): void => {
		if (values.length > 0) {
			filters.push({ label, value: values.join(', ') });
		}
	};

	add('Вуз или контрагент', organizationNames);
	add(
		'Тип контрагента',
		query.party.map((kind) => REPORT_PARTY_LABELS[kind])
	);
	add('Пространство', workspaceNames);
	add('Направление', directionNames);
	add('Программа', programNames);
	add('Продукт', productNames);
	add('Ответственный', ownerNames);
	add('Ответственный за вуз', assigneeNames);
	add('Стадия', query.stage.map(stageName));
	add(
		'Состояние',
		query.state.map((state) => REPORT_STATE_LABELS[state])
	);
	add('Статус передачи', query.transfer);

	if (query.overdue) {
		filters.push({ label: 'Только просроченные', value: 'на момент среза' });
	}

	if (query.paused) {
		filters.push({ label: 'Только на паузе', value: 'на момент среза' });
	}

	return filters;
}
