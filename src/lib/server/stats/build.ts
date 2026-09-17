/**
 * Сборка строк снимка из таблицы файла и сопоставления колонок.
 *
 * Функция чистая: таблица, сопоставление и справочник на входе, строки с
 * претензиями на выходе. Поэтому одно и то же правило разбора проверяется
 * модульным тестом и работает в импорте — второго места, где «почти так же»
 * разбирается число или дата, в продукте нет.
 *
 * Строка с претензией остаётся в снимке, но в показатели не попадает: потерять
 * данные молча нельзя, а сложить непонятое — тем более.
 */
import {
	STAT_MEASURE_FIELDS,
	STAT_REQUIRED_FIELDS,
	STAT_FIELD_LABELS,
	type StatField,
	type StatMapping,
	type StatMeasureField,
	type StatRowIssue
} from '$lib/contracts/stats';
import { pluralize } from '$lib/format';
import {
	lookupOrganization,
	lookupProgram,
	lookupSite,
	type DirectoryIndex,
	type Resolution
} from './lookup';
import { describeRowOrigin, parseCalendarDate, parseCount, type StatTable } from './parse';

/** Строка снимка до записи в базу. */
export type StatRowDraft = {
	rowNo: number;
	organizationId: string | null;
	siteId: string | null;
	programId: string | null;
	periodStart: string;
	periodEnd: string;
	applications: number | null;
	enrolled: number | null;
	parallelStreams: number | null;
	completed: number | null;
	coveragePlan: number | null;
	coverageFact: number | null;
	raw: Record<string, string>;
	issues: StatRowIssue[];
	isValid: boolean;
};

export type BuildRowsInput = {
	table: StatTable;
	mapping: StatMapping;
	index: DirectoryIndex;
	/** Период снимка: он же период строки, если в файле своего периода нет. */
	period: { start: string; end: string };
};

/** Поля, которые обязаны быть сопоставлены; без них строку не к чему отнести. */
export function missingRequiredFields(mapping: StatMapping): StatField[] {
	const assigned = new Set(Object.values(mapping));

	return STAT_REQUIRED_FIELDS.filter((field) => !assigned.has(field));
}

/** Колонка, сопоставленная полю, или `null`. */
function columnOf(mapping: StatMapping, field: StatField): string | null {
	return Object.entries(mapping).find(([, mapped]) => mapped === field)?.[0] ?? null;
}

function valueOf(
	raw: Record<string, string>,
	mapping: StatMapping,
	field: StatField
): string | null {
	const column = columnOf(mapping, field);

	return column === null ? null : (raw[column] ?? '');
}

/** Записывает претензию поиска, если она есть, и отдаёт найденный идентификатор. */
function applyResolution(
	issues: StatRowIssue[],
	field: StatField,
	resolution: Resolution
): string | null {
	if (resolution.message !== null) {
		issues.push({ field, message: resolution.message });
	}

	return resolution.id;
}

function readPeriodBound(
	issues: StatRowIssue[],
	raw: Record<string, string>,
	mapping: StatMapping,
	field: 'periodStart' | 'periodEnd',
	fallback: string
): string {
	const value = valueOf(raw, mapping, field);

	if (value === null) {
		return fallback;
	}

	const parsed = parseCalendarDate(value);

	if (parsed === 'invalid') {
		issues.push({
			field,
			message: `${STAT_FIELD_LABELS[field]}: «${value}» не похоже на дату (ждём 2026-09-01 или 01.09.2026)`
		});

		return fallback;
	}

	return parsed ?? fallback;
}

function readMeasure(
	issues: StatRowIssue[],
	raw: Record<string, string>,
	mapping: StatMapping,
	field: StatMeasureField
): number | null {
	const value = valueOf(raw, mapping, field);

	if (value === null) {
		return null;
	}

	const parsed = parseCount(value);

	if (parsed === 'invalid') {
		issues.push({
			field,
			message: `${STAT_FIELD_LABELS[field]}: «${value}» не похоже на целое число`
		});

		return null;
	}

	if (parsed !== null && parsed < 0) {
		issues.push({
			field,
			message: `${STAT_FIELD_LABELS[field]}: отрицательное значение ${parsed}`
		});

		return null;
	}

	return parsed;
}

/** Ключ, по которому строка считается дублем другой строки того же файла. */
function duplicateKey(row: StatRowDraft): string | null {
	if (row.organizationId === null || row.programId === null) {
		return null;
	}

	return [row.organizationId, row.programId, row.periodStart, row.periodEnd].join(' ');
}

/**
 * Дубли внутри файла. Две строки про один и тот же вуз, программу и период —
 * это не «сложить их вместе»: в выгрузке так выглядит либо повтор, либо
 * потерянный признак, по которому они различались. Складывать наугад нельзя,
 * поэтому обе строки получают претензию и в показатели не идут.
 */
function markDuplicates(rows: StatRowDraft[]): void {
	const byKey = new Map<string, StatRowDraft[]>();

	for (const row of rows) {
		const key = duplicateKey(row);

		if (key === null) {
			continue;
		}

		byKey.set(key, [...(byKey.get(key) ?? []), row]);
	}

	for (const group of byKey.values()) {
		if (group.length < 2) {
			continue;
		}

		for (const row of group) {
			const others = group.filter((other) => other !== row).map((other) => other.rowNo);

			row.issues.push({
				field: null,
				message: `Дубль: та же организация, программа и период, что в строке ${others.join(', ')}`
			});
			row.isValid = false;
		}
	}
}

export function buildRows(input: BuildRowsInput): StatRowDraft[] {
	const { table, mapping, index, period } = input;

	const rows = table.rows.map((row, position) => {
		const issues: StatRowIssue[] = [];
		const raw: Record<string, string> = {};

		table.headers.forEach((header, column) => {
			raw[header] = row.cells[column] ?? '';
		});

		// Лишние ячейки — это сдвиг колонок, а не мусор в конце строки: без
		// претензии числа поедут не в те поля, и заметить это будет нечем.
		// Место в файле названо прямо: по номеру строки снимка его не найти —
		// пустые строки и шапка в него не считаются.
		const extra = row.cells.slice(table.headers.length).filter((cell) => cell !== '');

		if (extra.length > 0) {
			issues.push({
				field: null,
				message: `${describeRowOrigin(table.file, row.origin)} файла: ${pluralize(extra.length, ['значение', 'значения', 'значений'])} сверх колонок шапки — проверьте разделители`
			});
		}

		const organizationValue = valueOf(raw, mapping, 'organization');
		const organizationId = applyResolution(
			issues,
			'organization',
			organizationValue === null || organizationValue.trim() === ''
				? { id: null, message: 'Организация: значение не заполнено' }
				: lookupOrganization(index, organizationValue)
		);

		const programValue = valueOf(raw, mapping, 'program');
		const programId = applyResolution(
			issues,
			'program',
			programValue === null || programValue.trim() === ''
				? { id: null, message: 'Программа: значение не заполнено' }
				: lookupProgram(index, programValue)
		);

		const siteValue = valueOf(raw, mapping, 'site');
		const siteId =
			siteValue === null || siteValue.trim() === ''
				? null
				: applyResolution(issues, 'site', lookupSite(index, organizationId, siteValue));

		const rowStart = readPeriodBound(issues, raw, mapping, 'periodStart', period.start);
		const rowEnd = readPeriodBound(issues, raw, mapping, 'periodEnd', period.end);
		const ordered = rowEnd >= rowStart;

		if (!ordered) {
			issues.push({ field: 'periodEnd', message: 'Конец периода строки раньше его начала' });
		}

		// Перевёрнутый период не записывается как есть: такой строки база не
		// примет (CHECK), а вместе с ней не записался бы и весь снимок — включая
		// саму претензию, ради которой строку и сохраняют.
		const periodStart = ordered ? rowStart : period.start;
		const periodEnd = ordered ? rowEnd : period.end;

		const measures = Object.fromEntries(
			STAT_MEASURE_FIELDS.map((field) => [field, readMeasure(issues, raw, mapping, field)])
		) as Record<StatMeasureField, number | null>;

		return {
			rowNo: position + 1,
			organizationId,
			siteId,
			programId,
			periodStart,
			periodEnd,
			...measures,
			raw,
			issues,
			isValid: issues.length === 0 && organizationId !== null && programId !== null
		} satisfies StatRowDraft;
	});

	markDuplicates(rows);

	return rows;
}
