/**
 * Четыре писателя одного отчёта.
 *
 * Все получают на вход готовый объект `ReportView` и ни один не ходит в базу.
 * Это и есть инвариант И5: число строк таблицы и число строк в каждом из
 * четырёх файлов совпадают, потому что строка в них одна и та же.
 */
import {
	REPORT_EXPORT_LIMITS,
	REPORT_FORMAT_MIME,
	type ReportFormat,
	type ReportView
} from '$lib/contracts/reports';
import { formatIsoDay } from '$lib/format';
import { ValidationError } from '../../errors';
import { writeXls, writeXlsx } from '../../spreadsheet/write';
import { renderPdf } from '../gotenberg';
import { reportFileName } from './filename';
import { reportFooterHtml, reportHtml } from './html';
import { reportJson } from './json';
import { reportSheets } from './sheets';

export type ReportFile = {
	fileName: string;
	contentType: string;
	body: Buffer;
};

/**
 * Потолок объёма. Выше него выгрузка не режется молча: файл, в котором строк
 * меньше, чем на экране, выглядит как правда и врёт.
 */
function assertWithinLimit(view: ReportView, format: ReportFormat): void {
	const limit = REPORT_EXPORT_LIMITS[format];

	if (view.rows.length > limit) {
		throw new ValidationError(`Выгрузка ${format.toUpperCase()} этого объёма не собирается`, [
			`В отчёте ${view.rows.length} строк, в файл этого формата помещается ${limit}`,
			'Сузьте период или добавьте фильтр'
		]);
	}
}

export async function renderReport(
	view: ReportView,
	format: ReportFormat,
	day: string = formatIsoDay()
): Promise<ReportFile> {
	assertWithinLimit(view, format);

	const file = {
		fileName: reportFileName(view, format, day),
		contentType: REPORT_FORMAT_MIME[format]
	};

	switch (format) {
		case 'xlsx':
			return { ...file, body: writeXlsx(reportSheets(view)) };
		case 'xls':
			return { ...file, body: writeXls(reportSheets(view)) };
		case 'json':
			return { ...file, body: reportJson(view) };
		case 'pdf':
			return { ...file, body: await renderPdf(reportHtml(view), reportFooterHtml()) };
	}
}

export { reportFileName, isReportFormat } from './filename';
export { reportHtml, reportFooterHtml } from './html';
export { reportJson } from './json';
export { reportSheets } from './sheets';
