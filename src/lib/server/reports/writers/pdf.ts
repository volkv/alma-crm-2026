/**
 * PDF отчёта: сводка или полный отчёт по всей выборке.
 *
 * Сводка — одна страница печати. Полный отчёт печатается частями по
 * `REPORT_PDF_PART_ROWS` строк одна за другой и склеивается службой в один
 * файл: так служба печати тратит на любую часть не больше памяти, чем на
 * сводку (замер — `docs/reports.md`, «PDF: сводка и полный отчёт»).
 *
 * Полный PDF собирается синхронно, в том же запросе и из того же объекта
 * отчёта, что и остальные форматы, — а значит, из того же снимка базы. По замеру
 * это секунды, а не минуты, и фоновая очередь с отдельным скачиванием дала бы
 * вторую точку проверки прав ради ожидания, которого нет.
 */
import {
	REPORT_FORMAT_LABELS,
	REPORT_PDF_FULL_MAX_ROWS,
	type ReportPdfLayout,
	type ReportView
} from '$lib/contracts/reports';
import { ValidationError } from '../../errors';
import { mergePdfs, renderPdf } from '../gotenberg';
import { reportPdfParts } from './html';

/**
 * Очередь полных PDF в процессе: одновременно печатается один. Две большие
 * выгрузки разом удвоили бы память службы печати — ту самую, которую экономит
 * печать частями. Сводка очереди не ждёт: она одна часть, того же размера.
 */
let fullPdfQueue: Promise<void> = Promise.resolve();

function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
	const run = fullPdfQueue.then(task);

	// Очередь ждёт окончания задачи, чем бы та ни кончилась; ошибка уходит
	// вызывающему через `run`, а не теряется.
	fullPdfQueue = run.then(
		() => undefined,
		() => undefined
	);

	return run;
}

async function renderParts(view: ReportView, layout: ReportPdfLayout): Promise<Buffer> {
	const parts = reportPdfParts(view, layout);
	const files: Buffer[] = [];

	// Части печатаются по одной: параллельная печать вернула бы пик памяти
	// службы к тому, что был у файла одним куском.
	for (const part of parts) {
		files.push(await renderPdf(part.page, part.footer));
	}

	return files.length === 1 ? files[0] : mergePdfs(files);
}

export async function reportPdf(view: ReportView, layout: ReportPdfLayout): Promise<Buffer> {
	if (layout === 'summary') {
		return renderParts(view, layout);
	}

	if (view.rows.length > REPORT_PDF_FULL_MAX_ROWS) {
		throw new ValidationError('Полный PDF для такой выборки не собрать', [
			`В выборке ${view.rows.length} строк, полный PDF печатает до ${REPORT_PDF_FULL_MAX_ROWS}`,
			`Вся таблица есть в ${REPORT_FORMAT_LABELS.xlsx}; сводка PDF собирается на любой выборке, или сузьте период или фильтр`
		]);
	}

	return oneAtATime(() => renderParts(view, layout));
}
