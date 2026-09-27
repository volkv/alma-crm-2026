import { error } from '@sveltejs/kit';
import { REPORT_FORMATS, REPORT_PDF_LAYOUTS, isReportPdfLayout } from '$lib/contracts/reports';
import { actorFromEvent } from '$lib/server/actor';
import { recordAuditEvent } from '$lib/server/audit';
import { contentDisposition } from '$lib/server/documents/filename';
import { toPageError } from '$lib/server/http';
import { readReportQuery } from '$lib/server/reports/query';
import { buildReport } from '$lib/server/reports/rows';
import { isReportFormat, renderReport } from '$lib/server/reports/writers';
import type { RequestHandler } from './$types';

/**
 * Выгрузка отчёта в одном из четырёх форматов.
 *
 * Маршрут лежит внутри оболочки приложения, а не в `/api`: это ссылка со
 * страницы, сюда приходят с сессионной кукой и ошибку ждут страницей, а не
 * конвертом JSON. Фильтры разбираются тем же модулем, что и на экране, и отчёт
 * собирается тем же сервисом — выгрузка обязана быть той же ссылкой с другим
 * расширением, а не второй выборкой.
 *
 * Права проверяет сборщик отчёта (`interactions.read`): своего права у раздела
 * нет, и второе место, где решают, можно ли, однажды разошлось бы с первым.
 *
 * Для PDF параметр `pdf` выбирает вид: `summary` (по умолчанию — так выглядит
 * кнопка) или `full`. Полный PDF собирается в этом же запросе из того же
 * объекта отчёта, то есть из того же снимка базы, что и остальные форматы.
 */
export const GET: RequestHandler = async (event) => {
	const requested = event.url.searchParams.get('format') ?? '';

	// Испорченный параметр адреса — не предметная ошибка: до сервиса такой
	// запрос не доходит, и переводить тут нечего.
	if (!isReportFormat(requested)) {
		error(400, `Неизвестный формат выгрузки: выберите ${REPORT_FORMATS.join(', ')}`);
	}

	const pdfLayout = event.url.searchParams.get('pdf') ?? 'summary';

	if (!isReportPdfLayout(pdfLayout)) {
		error(400, `Неизвестный вид PDF: выберите ${REPORT_PDF_LAYOUTS.join(', ')}`);
	}

	const ctx = actorFromEvent(event);

	try {
		const query = readReportQuery(event.url);
		const view = await buildReport(ctx, query);
		const file = await renderReport(view, requested, { pdfLayout });

		// В подробностях события — идентификатор отчёта, режим, границы периода,
		// число строк, формат и вид PDF. Идентификатор стоит и в самом файле: по нему файл,
		// пришедший по почте, находит своё событие — кто, когда и что собрал.
		// Фильтры не кладём: они содержат свободный текст, а журнал его не
		// принимает.
		await recordAuditEvent(ctx, {
			type: 'reports.exported',
			outcome: 'success',
			details: {
				reportId: view.meta.reportId,
				mode: query.mode,
				periodStart: query.from,
				periodEnd: query.to,
				rowCount: view.rows.length,
				formatKey: requested,
				...(requested === 'pdf' ? { pdfLayoutKey: pdfLayout } : {})
			}
		});

		return new Response(new Uint8Array(file.body), {
			headers: {
				'Content-Type': file.contentType,
				'Content-Disposition': contentDisposition(file.fileName),
				// Отчёт собран под область доступа того, кто его запросил: ни
				// браузеру, ни промежуточному кэшу хранить его нельзя.
				'Cache-Control': 'no-store',
				'X-Content-Type-Options': 'nosniff'
			}
		});
	} catch (failure) {
		toPageError(failure);
	}
};
