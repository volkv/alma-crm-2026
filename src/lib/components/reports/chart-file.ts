/**
 * Диаграмма файлом: PNG и PDF собирает браузер, а не сервер.
 *
 * Картинка уже нарисована на экране, и отправлять её на сервер, чтобы получить
 * обратно тот же растр, значило бы принимать чужой файл: проверять подпись,
 * потолок размера и размеры холста — отдельную работу по безопасности, за
 * которой не стоит ни одно требование. Поэтому сервер картинок не принимает, а
 * таблица чисел в серверном PDF рисуется без диаграммы: числа и картинка не
 * должны приезжать из разных мест.
 *
 * PDF собирается здесь же, без библиотеки. Одностраничный документ с единственным
 * изображением — это семь объектов и таблица смещений; целая библиотека вёрстки
 * ради них стоила бы трёхсот килобайт в бандле. Изображение кладётся JPEG'ом:
 * его PDF понимает потоком как есть (`DCTDecode`), тогда как PNG пришлось бы
 * распаковывать и пересобирать по частям вместе с каналом прозрачности.
 */

/** Поля страницы в пунктах: узкая рамка, чтобы диаграмма не липла к краю. */
const MARGIN_POINTS = 24;

/** A4 альбомная в пунктах — тот же лист, что у серверного PDF отчёта. */
const PAGE_WIDTH_POINTS = 842;
const PAGE_HEIGHT_POINTS = 595;

/** Качество JPEG: выше почти не видно, а вес растёт вдвое. */
const JPEG_QUALITY = 0.92;

/**
 * Холст диаграммы поверх листа. Сама диаграмма прозрачна, и без подложки PNG на
 * чужом фоне читался бы наоборот, а JPEG, не знающий прозрачности, залил бы её
 * чёрным.
 *
 * Цвет листа приходит снаружи — это цвет панели той темы, в которой диаграмму
 * нарисовали. Подписи и сетка на холсте тоже из темы, поэтому белый лист под
 * тёмной диаграммой дал бы светлый текст на белом: файл, который нельзя
 * прочитать ни на экране, ни на бумаге.
 */
function onSheet(canvas: HTMLCanvasElement, background: string): HTMLCanvasElement {
	const sheet = document.createElement('canvas');

	sheet.width = canvas.width;
	sheet.height = canvas.height;

	const context = sheet.getContext('2d');

	if (context === null) {
		throw new Error('Браузер не дал холст для сборки картинки');
	}

	context.fillStyle = background;
	context.fillRect(0, 0, sheet.width, sheet.height);
	context.drawImage(canvas, 0, 0);

	return sheet;
}

function download(blob: Blob, fileName: string): void {
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');

	link.href = url;
	link.download = fileName;
	link.click();

	URL.revokeObjectURL(url);
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
	const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
	const bytes = new Uint8Array(binary.length);

	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}

	return bytes;
}

/** Строка в байты по одному знаку: в PDF всё, кроме потоков, — латиница. */
function ascii(value: string): Uint8Array {
	const bytes = new Uint8Array(value.length);

	for (let index = 0; index < value.length; index += 1) {
		bytes[index] = value.charCodeAt(index) & 0xff;
	}

	return bytes;
}

/** Куда вписать картинку, сохранив её пропорции. */
function fitOnPage(width: number, height: number) {
	const maxWidth = PAGE_WIDTH_POINTS - MARGIN_POINTS * 2;
	const maxHeight = PAGE_HEIGHT_POINTS - MARGIN_POINTS * 2;
	const scale = Math.min(maxWidth / width, maxHeight / height);
	const drawWidth = width * scale;
	const drawHeight = height * scale;

	return {
		width: drawWidth,
		height: drawHeight,
		x: (PAGE_WIDTH_POINTS - drawWidth) / 2,
		y: (PAGE_HEIGHT_POINTS - drawHeight) / 2
	};
}

function pdfWithImage(jpeg: Uint8Array, width: number, height: number): Blob {
	const box = fitOnPage(width, height);
	const round = (value: number): string => value.toFixed(2);
	const content = `q ${round(box.width)} 0 0 ${round(box.height)} ${round(box.x)} ${round(box.y)} cm /Im0 Do Q\n`;

	const objects: Uint8Array[][] = [
		[ascii('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')],
		[ascii('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n')],
		[
			ascii(
				`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH_POINTS} ${PAGE_HEIGHT_POINTS} ]` +
					' /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n'
			)
		],
		[
			ascii(
				`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height}` +
					` /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`
			),
			jpeg,
			ascii('\nendstream\nendobj\n')
		],
		[ascii(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`)]
	];

	const parts: Uint8Array[] = [ascii('%PDF-1.4\n')];
	const offsets: number[] = [];
	let position = parts[0].length;

	for (const object of objects) {
		offsets.push(position);

		for (const chunk of object) {
			parts.push(chunk);
			position += chunk.length;
		}
	}

	// Таблица смещений: каждая строка ровно двадцать байт, иначе читатель PDF
	// найдёт объекты не там, где они лежат.
	const xref = [
		`xref\n0 ${objects.length + 1}\n`,
		'0000000000 65535 f \n',
		...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
	].join('');

	parts.push(ascii(xref));
	parts.push(
		ascii(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`)
	);

	return new Blob(parts as BlobPart[], { type: 'application/pdf' });
}

export function downloadChartPng(
	canvas: HTMLCanvasElement,
	fileName: string,
	background: string
): void {
	const sheet = onSheet(canvas, background);

	download(dataUrlToBlob(sheet.toDataURL('image/png'), 'image/png'), fileName);
}

export function downloadChartPdf(
	canvas: HTMLCanvasElement,
	fileName: string,
	background: string
): void {
	const sheet = onSheet(canvas, background);
	const jpeg = dataUrlToBytes(sheet.toDataURL('image/jpeg', JPEG_QUALITY));

	download(pdfWithImage(jpeg, sheet.width, sheet.height), fileName);
}

function dataUrlToBlob(dataUrl: string, type: string): Blob {
	return new Blob([dataUrlToBytes(dataUrl)] as BlobPart[], { type });
}
