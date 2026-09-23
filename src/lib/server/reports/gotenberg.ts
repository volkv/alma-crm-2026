/**
 * Печать страницы в PDF силами Gotenberg.
 *
 * Своего рендерера PDF в продукте нет и не будет: таблица отчёта обязана
 * выглядеть так же, как на экране, а единственный способ это обеспечить —
 * печатать её тем же движком, что и показывает браузер. Служба та же, что
 * печатает документы из DOCX (`documents/generate.ts`), маршрут другой —
 * Chromium вместо LibreOffice.
 *
 * Ходит по сети, поэтому зовётся до и вне транзакции: держать блокировки всё
 * время, пока чужая служба собирает файл, нельзя.
 *
 * Два маршрута: печать HTML Chromium'ом и склейка готовых PDF (`pdfengines`) —
 * ею полный отчёт собирается из частей.
 */
import { getConfig } from '../config';
import { DocumentConversionError, hideServiceAddresses } from '../documents/errors';
import { PDF_MIME, sniffDocumentMime } from '../documents/mime';

/**
 * Потолок ожидания одного запроса. Печатается не больше `REPORT_PDF_ROWS`
 * строк за раз (полный отчёт — частями, `writers/pdf.ts`): по замеру это
 * секунда-две, склейка десятков частей — столько же. Минута — запас на
 * холодную службу, а не на объём.
 */
const RENDER_TIMEOUT_MS = 60_000;

/** Имя, по которому Chromium узнаёт печатаемую страницу; менять его нельзя. */
const PAGE_FILE_NAME = 'index.html';

const FOOTER_FILE_NAME = 'footer.html';

/**
 * A4 в дюймах — так размеры страницы принимает служба. Стороны всегда книжные:
 * при `landscape=true` Chromium меняет их местами сам, и лист, которому заранее
 * дали альбомные размеры, возвращается в книжный (проверено прямым запросом
 * к службе — см. `scripts/docs-pdf/gotenberg.ts`, где та же ловушка обойдена).
 */
const PAGE_WIDTH_INCHES = '8.27';
const PAGE_HEIGHT_INCHES = '11.69';

/** Адрес маршрута службы: `GOTENBERG_URL` бывает и со слешем на конце, и без. */
function serviceEndpoint(serviceUrl: string, route: string): URL {
	return new URL(route, serviceUrl.endsWith('/') ? serviceUrl : `${serviceUrl}/`);
}

/** Запрос к службе и проверка того, что она вернула именно PDF. */
async function requestPdf(route: string, form: FormData): Promise<Buffer> {
	const serviceUrl = getConfig().GOTENBERG_URL;

	let response: Response;

	try {
		response = await fetch(serviceEndpoint(serviceUrl, route), {
			method: 'POST',
			body: form,
			signal: AbortSignal.timeout(RENDER_TIMEOUT_MS)
		});
	} catch (error) {
		throw new DocumentConversionError(
			`Служба печати в PDF недоступна или не ответила за ${RENDER_TIMEOUT_MS / 1000} с`,
			{ status: null, cause: error }
		);
	}

	if (!response.ok) {
		throw new DocumentConversionError(
			`Служба печати в PDF ответила ошибкой ${response.status}: ` +
				hideServiceAddresses(await response.text(), serviceUrl),
			{ status: response.status }
		);
	}

	const pdf = Buffer.from(await response.arrayBuffer());

	// Проверяем то, что служба вернула, а не то, о чём её просили: отданный
	// вместо файла HTML ошибки скачался бы под именем отчёта.
	if (sniffDocumentMime(pdf) !== PDF_MIME) {
		throw new DocumentConversionError('Служба печати вернула не PDF', { status: response.status });
	}

	return pdf;
}

export async function renderPdf(page: string, footer: string): Promise<Buffer> {
	const form = new FormData();

	form.append('files', new Blob([page], { type: 'text/html' }), PAGE_FILE_NAME);
	form.append('files', new Blob([footer], { type: 'text/html' }), FOOTER_FILE_NAME);
	form.append('landscape', 'true');
	form.append('paperWidth', PAGE_WIDTH_INCHES);
	form.append('paperHeight', PAGE_HEIGHT_INCHES);
	form.append('marginTop', '0.4');
	form.append('marginBottom', '0.5');
	form.append('marginLeft', '0.4');
	form.append('marginRight', '0.4');
	form.append('printBackground', 'true');

	return requestPdf('forms/chromium/convert/html', form);
}

/**
 * Склейка частей в один файл. Служба склеивает файлы в алфавитном порядке их
 * имён, поэтому номер части в имени дополнен нулями: `part-0010` обязан идти
 * после `part-0009`, а не после `part-0001`.
 */
export async function mergePdfs(parts: readonly Buffer[]): Promise<Buffer> {
	const form = new FormData();

	parts.forEach((part, index) => {
		form.append(
			'files',
			new Blob([new Uint8Array(part)], { type: PDF_MIME }),
			`part-${String(index + 1).padStart(4, '0')}.pdf`
		);
	});

	return requestPdf('forms/pdfengines/merge', form);
}
