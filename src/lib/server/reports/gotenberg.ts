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
 */
import { getConfig } from '../config';
import { DocumentConversionError, hideServiceAddresses } from '../documents/errors';
import { PDF_MIME, sniffDocumentMime } from '../documents/mime';

/**
 * Потолок ожидания. Chromium стартует быстрее LibreOffice, но таблица на две
 * тысячи строк — это полсотни страниц вёрстки.
 */
const RENDER_TIMEOUT_MS = 60_000;

/** Имя, по которому Chromium узнаёт печатаемую страницу; менять его нельзя. */
const PAGE_FILE_NAME = 'index.html';

const FOOTER_FILE_NAME = 'footer.html';

/** A4 альбомная, в дюймах — так размеры страницы принимает служба. */
const PAGE_WIDTH_INCHES = '11.69';
const PAGE_HEIGHT_INCHES = '8.27';

export async function renderPdf(page: string, footer: string): Promise<Buffer> {
	const serviceUrl = getConfig().GOTENBERG_URL;
	const endpoint = new URL(
		'forms/chromium/convert/html',
		serviceUrl.endsWith('/') ? serviceUrl : `${serviceUrl}/`
	);

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

	let response: Response;

	try {
		response = await fetch(endpoint, {
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
