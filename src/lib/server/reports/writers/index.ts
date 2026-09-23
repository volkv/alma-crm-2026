/**
 * Четыре писателя одного отчёта.
 *
 * Все получают на вход готовый объект `ReportView` и ни один не ходит в базу.
 * Это и есть инвариант И5: число строк таблицы и число строк в каждом из файлов
 * совпадают, потому что строка в них одна и та же. Исключение одно и объявлено:
 * сводка PDF, в которой таблицы ровно столько, сколько она обещает показать
 * пометкой «первые N из M». Полный PDF печатает всю выборку.
 */
import {
	REPORT_FORMAT_MIME,
	type ReportFormat,
	type ReportPdfLayout,
	type ReportView
} from '$lib/contracts/reports';
import { formatIsoDay } from '$lib/format';
import { writeXls, writeXlsx } from '../../spreadsheet/write';
import { reportFileName } from './filename';
import { reportJson } from './json';
import { reportPdf } from './pdf';
import { reportSheets } from './sheets';

export type ReportFile = {
	fileName: string;
	contentType: string;
	body: Buffer;
};

export type RenderOptions = {
	/** День сборки в имени файла; по умолчанию — сегодня по Москве. */
	day?: string;
	/** Вид PDF; для остальных форматов не значит ничего. По умолчанию — сводка. */
	pdfLayout?: ReportPdfLayout;
};

export async function renderReport(
	view: ReportView,
	format: ReportFormat,
	{ day = formatIsoDay(), pdfLayout = 'summary' }: RenderOptions = {}
): Promise<ReportFile> {
	const file = {
		fileName: reportFileName(view, format, day, pdfLayout),
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
			return { ...file, body: await reportPdf(view, pdfLayout) };
	}
}

export { reportFileName, isReportFormat } from './filename';
export { reportJson } from './json';
export { reportSheets } from './sheets';
