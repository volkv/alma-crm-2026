/**
 * Выгрузка отчёта в JSON — тот самый «результирующий json-файл».
 *
 * Это не второе описание данных, а сериализация того же объекта: имена полей
 * повторяют контракт обмена, у каждой строки есть устойчивый идентификатор
 * взаимодействия и абсолютная ссылка на карточку. Кодировка — строго UTF-8 без
 * метки порядка байтов: метка нужна текстовому CSV, а этот отчёт CSV не
 * производит.
 *
 * Сверх ячеек строка несёт ключи связи — документы и учебные группы. Путь «от
 * числа к подтверждению» в интерфейсе доходит до карточки и дальше идёт глазами;
 * читающему файл глаз не полагается, и без этих ключей проверить число из файла
 * нечем.
 */
import type { ReportCell, ReportView } from '$lib/contracts/reports';

/** Значение ячейки в JSON: то, что можно сравнить и сложить, без обёрток. */
type JsonValue = string | number | readonly string[] | null;

function toJsonValue(cell: ReportCell): JsonValue {
	switch (cell.kind) {
		case 'text':
		case 'date':
		case 'datetime':
		case 'link':
			return cell.value;
		case 'number':
			return cell.value;
		case 'list':
			return cell.values;
	}
}

export function reportJson(view: ReportView): Buffer {
	const keys = view.meta.columns.map((column) => column.key);

	const payload = {
		schemaVersion: view.meta.schemaVersion,
		reportId: view.meta.reportId,
		generatedAt: view.meta.generatedAt,
		asOf: view.meta.asOf,
		mode: view.meta.mode,
		workspace: view.meta.workspace,
		period: view.meta.period,
		filters: view.meta.filters,
		scope: view.meta.scope,
		semantics: view.meta.semantics,
		columns: view.meta.columns,
		totals: view.totals,
		charts: view.charts,
		rows: view.rows.map((row) => ({
			rowKey: row.rowKey,
			interactionId: row.interactionId,
			stageEntryId: row.stageEntryId,
			url: row.cells.find((cell) => cell.kind === 'link')?.url ?? null,
			values: Object.fromEntries(
				row.cells.map((cell, position) => [keys[position], toJsonValue(cell)])
			),
			// Ключи связи, а не содержимое: по ним читающий найдёт файл в
			// хранилище и результат в системе обучения, а персональных данных в
			// них нет — ни названия документа, ни того, кто его загрузил.
			documents: row.documents,
			learningGroups: row.learningGroups
		}))
	};

	return Buffer.from(JSON.stringify(payload, null, '\t'), 'utf8');
}
