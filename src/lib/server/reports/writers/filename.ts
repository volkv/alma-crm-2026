/**
 * Имя файла выгрузки: по нему отчёт узнаётся в папке загрузок через месяц.
 *
 * В имени стоит и то, о чём отчёт (режим и период), и день сборки: два файла с
 * одним периодом, снятые в разные дни, — это разные файлы, и различать их по
 * времени изменения на диске нельзя.
 */
import { REPORT_FORMATS, type ReportFormat, type ReportView } from '$lib/contracts/reports';
import { formatDate, formatIsoDay } from '$lib/format';

export function reportFileName(
	view: ReportView,
	format: ReportFormat,
	day: string = formatIsoDay()
): string {
	const subject =
		view.meta.mode === 'snapshot'
			? `срез на ${formatDate(view.meta.period.end)}`
			: `движение ${formatDate(view.meta.period.start)} — ${formatDate(view.meta.period.end)}`;

	return `Отчёт по взаимодействиям — ${subject} (собран ${formatDate(day)}).${format}`;
}

export function isReportFormat(value: string): value is ReportFormat {
	return (REPORT_FORMATS as readonly string[]).includes(value);
}
