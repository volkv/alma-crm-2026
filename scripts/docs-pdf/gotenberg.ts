/**
 * Gotenberg глазами сборщика документации.
 *
 * Служба та же, что печатает отчёты и договоры в работающей системе
 * (`src/lib/server/reports/gotenberg.ts`), но клиент здесь свой и намеренно
 * отдельный: тот живёт внутри приложения, читает конфигурацию через `getConfig()`
 * и бросает доменную ошибку документа, а этот запускается обычным Node без
 * приложения вообще — и ему нужны два маршрута, которых у приложения нет
 * (объединение файлов и чтение числа страниц).
 *
 * Адрес берётся из `GOTENBERG_URL`, как и у приложения; значение по умолчанию
 * совпадает с `docker-compose.yml`, где служба выставлена на хост портом 3001.
 */
import { readFile } from 'node:fs/promises';

/** Файл рядом с печатаемой страницей: картинка, на которую она ссылается. */
export type PageAsset = {
	/** Имя, под которым файл ляжет рядом с `index.html`. Без каталогов. */
	name: string;
	/** Путь к файлу на диске. */
	source: string;
};

export type PdfPart = {
	/** Имя файла при объединении: по нему же задаётся порядок. */
	name: string;
	body: Buffer;
};

/**
 * Потолок ожидания одной печати. README с двумя десятками снимков экрана —
 * это мегабайты картинок, которые Chromium сначала получает, потом раскладывает
 * по страницам; минуты ему хватает с запасом, а полторы — это уже «служба
 * молчит», а не «служба занята».
 */
const RENDER_TIMEOUT_MS = 90_000;

/** Имена, по которым Chromium узнаёт страницу и её подвал. Менять нельзя. */
const PAGE_FILE_NAME = 'index.html';
const FOOTER_FILE_NAME = 'footer.html';

/**
 * A4 в дюймах — так размеры страницы принимает служба. Стороны всегда книжные:
 * при `landscape=true` Chromium меняет их местами сам, и лист, которому заранее
 * дали альбомные размеры, возвращается в книжный.
 */
const A4_WIDTH_INCHES = '8.27';
const A4_HEIGHT_INCHES = '11.69';

function serviceUrl(): string {
	const url = process.env.GOTENBERG_URL ?? 'http://localhost:3001';

	return url.endsWith('/') ? url : `${url}/`;
}

async function call(route: string, form: FormData): Promise<Response> {
	const endpoint = new URL(route, serviceUrl());

	let response: Response;

	try {
		response = await fetch(endpoint, {
			method: 'POST',
			body: form,
			signal: AbortSignal.timeout(RENDER_TIMEOUT_MS)
		});
	} catch (error) {
		throw new Error(
			`Gotenberg (${endpoint.origin}) не ответил за ${RENDER_TIMEOUT_MS / 1000} с. ` +
				'Поднимите службу: docker compose up -d gotenberg',
			{ cause: error }
		);
	}

	if (!response.ok) {
		throw new Error(
			`Gotenberg ответил ${response.status} на ${route}: ${(await response.text()).trim()}`
		);
	}

	return response;
}

/**
 * Страница в PDF. Картинки едут отдельными файлами, а не строками `data:`:
 * страница остаётся читаемой, а служба получает ровно те байты, что лежат в
 * репозитории. Имена файлов плоские — вложенные каталоги Gotenberg рядом со
 * страницей не заводит, и ссылка `assets/x.png` превратилась бы в пустой
 * прямоугольник вместо картинки.
 */
export async function htmlToPdf(options: {
	html: string;
	footer: string;
	assets: readonly PageAsset[];
	landscape?: boolean;
}): Promise<Buffer> {
	const form = new FormData();

	form.append('files', new Blob([options.html], { type: 'text/html' }), PAGE_FILE_NAME);
	form.append('files', new Blob([options.footer], { type: 'text/html' }), FOOTER_FILE_NAME);

	for (const asset of options.assets) {
		const body = await readFile(asset.source);

		form.append('files', new Blob([new Uint8Array(body)]), asset.name);
	}

	form.append('landscape', String(options.landscape === true));
	form.append('paperWidth', A4_WIDTH_INCHES);
	form.append('paperHeight', A4_HEIGHT_INCHES);
	form.append('marginTop', '0.6');
	form.append('marginBottom', '0.7');
	form.append('marginLeft', '0.6');
	form.append('marginRight', '0.6');
	form.append('printBackground', 'true');

	const response = await call('forms/chromium/convert/html', form);

	return Buffer.from(await response.arrayBuffer());
}

/**
 * Склейка нескольких PDF в один. Порядок служба берёт из имён файлов по
 * алфавиту, поэтому части именуются с числовым префиксом — это единственный
 * способ его задать.
 */
export async function mergePdfs(
	parts: readonly PdfPart[],
	metadata: Record<string, string>
): Promise<Buffer> {
	const form = new FormData();

	for (const part of parts) {
		form.append(
			'files',
			new Blob([new Uint8Array(part.body)], { type: 'application/pdf' }),
			part.name
		);
	}

	form.append('metadata', JSON.stringify(metadata));

	const response = await call('forms/pdfengines/merge', form);

	return Buffer.from(await response.arrayBuffer());
}

/**
 * Число страниц готового файла. Считает его та же служба: разбирать PDF своими
 * руками ради одного числа — значит завести в репозитории третий разборщик
 * формата, а сторонний инструмент в системе (`pdfinfo`) пришлось бы ставить и
 * на машину, и в CI.
 */
export async function pageCount(pdf: Buffer): Promise<number> {
	const form = new FormData();
	const name = 'document.pdf';

	form.append('files', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), name);

	const response = await call('forms/pdfengines/metadata/read', form);
	const metadata = (await response.json()) as Record<string, { PageCount?: unknown }>;
	const pages = metadata[name]?.PageCount;

	if (typeof pages !== 'number' || !Number.isInteger(pages) || pages < 1) {
		throw new Error(`Gotenberg не сообщил число страниц файла: ${JSON.stringify(metadata)}`);
	}

	return pages;
}
