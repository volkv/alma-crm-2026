/**
 * Имя файла выгрузки: по нему отчёт узнаётся в папке загрузок через месяц.
 *
 * В имени стоит и то, о чём отчёт (пространство, режим и период), и день сборки:
 * два файла с
 * одним периодом, снятые в разные дни, — это разные файлы, и различать их по
 * времени изменения на диске нельзя. У PDF в имени стоит и вид: сводку и
 * полный отчёт за один период легко скачать оба, и различаться они обязаны до
 * того, как файл откроют.
 */
import {
	REPORT_FORMATS,
	REPORT_PDF_LAYOUT_LABELS,
	type ReportFormat,
	type ReportPdfLayout,
	type ReportView,
	reportTitle
} from '$lib/contracts/reports';
import { formatDate, formatIsoDay } from '$lib/format';

export function reportFileName(
	view: ReportView,
	format: ReportFormat,
	day: string = formatIsoDay(),
	pdfLayout: ReportPdfLayout = 'summary'
): string {
	const subject =
		view.meta.mode === 'snapshot'
			? `срез на ${formatDate(view.meta.period.end)}`
			: `движение ${formatDate(view.meta.period.start)} — ${formatDate(view.meta.period.end)}`;

	const layout = format === 'pdf' ? `, ${REPORT_PDF_LAYOUT_LABELS[pdfLayout].toLowerCase()}` : '';

	return `${reportTitle(view.meta.workspace.name)}, ${subject}${layout} (собран ${formatDate(day)}).${format}`;
}

export function isReportFormat(value: string): value is ReportFormat {
	return (REPORT_FORMATS as readonly string[]).includes(value);
}
