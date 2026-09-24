/**
 * Диаграмма файлом: PNG и PDF собирает браузер, а не сервер.
 *
 * Картинка уже умеет рисоваться на клиенте, и отправлять её на сервер, чтобы
 * получить обратно тот же растр, значило бы принимать чужой файл: проверять
 * подпись, потолок размера и размеры холста — отдельную работу по
 * безопасности, за которой не стоит ни одно требование. Поэтому сервер
 * картинок не принимает, а таблица чисел в серверном PDF рисуется без
 * диаграммы: числа и картинка не должны приезжать из разных мест.
 *
 * Файл — не снимок экранного холста. Диаграмма без заголовка, периода и
 * отбора, вставленная в документ, не говорит, что на ней: поэтому лист
 * собирается заново — шапка с условиями выборки, та же диаграмма и легенда —
 * и всегда светлым, в какой бы теме его ни выгрузили.
 *
 * PDF собирается здесь же, без библиотеки. Одностраничный документ с единственным
 * изображением — это семь объектов и таблица смещений; целая библиотека вёрстки
 * ради них стоила бы трёхсот килобайт в бандле. Изображение кладётся JPEG'ом:
 * его PDF понимает потоком как есть (`DCTDecode`), тогда как PNG пришлось бы
 * распаковывать и пересобирать по частям вместе с каналом прозрачности.
 */
import {
	chartConfiguration,
	horizontalHeight,
	loadChart,
	printPalette,
	type ChartSeries
} from './chart-config';

/** Ширина области диаграммы на листе, в точках CSS. */
const SHEET_CHART_WIDTH = 1120;

/** Поля листа. */
const SHEET_PADDING = 32;

/** Плотность растра: картинку вставляют в документ и печатают. */
const SHEET_SCALE = 2;

/** Высота вертикальной диаграммы на листе вместе с легендой. */
const SHEET_VERTICAL_HEIGHT = 400;

/** Под легенду горизонтальной диаграммы. */
const SHEET_LEGEND_HEIGHT = 36;

const TITLE_SIZE = 18;
const TITLE_LINE = 26;
const CONTEXT_SIZE = 13;
const CONTEXT_LINE = 20;
const HEADER_GAP = 16;

export type ChartSheetInput = {
	title: string;
	/** Строки шапки: период, отбор, область доступа, момент сборки. */
	context: readonly string[];
	labels: readonly string[];
	datasets: readonly ChartSeries[];
	horizontal: boolean;
	stacked: boolean;
	fontFamily: string;
};

/** Разбивка строки по словам под ширину листа. */
function wrap(context: CanvasRenderingContext2D, text: string, width: number): string[] {
	const lines: string[] = [];
	let line = '';

	for (const word of text.split(' ')) {
		const next = line === '' ? word : `${line} ${word}`;

		if (line !== '' && context.measureText(next).width > width) {
			lines.push(line);
			line = word;
		} else {
			line = next;
		}
	}

	if (line !== '') {
		lines.push(line);
	}

	return lines;
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
	const context = canvas.getContext('2d');

	if (context === null) {
		throw new Error('Браузер не дал холст для сборки картинки');
	}

	return context;
}

/**
 * Диаграмма на отдельном холсте в светлой палитре. Холст висит за краем окна:
 * Chart.js меряет шрифты и размеры по документу, и вне документа он их не
 * узнает. После съёмки растр копируется, а экземпляр и холст уничтожаются.
 */
async function renderChart(input: ChartSheetInput, height: number): Promise<HTMLCanvasElement> {
	const Chart = await loadChart();
	const host = document.createElement('div');
	const canvas = document.createElement('canvas');

	host.setAttribute('aria-hidden', 'true');
	host.style.cssText = `position:fixed;left:-20000px;top:0;width:${SHEET_CHART_WIDTH}px;height:${height}px;pointer-events:none`;
	canvas.style.cssText = `width:${SHEET_CHART_WIDTH}px;height:${height}px`;
	canvas.width = SHEET_CHART_WIDTH;
	canvas.height = height;
	host.append(canvas);
	document.body.append(host);

	try {
		const configuration = chartConfiguration({
			labels: input.labels,
			datasets: input.datasets,
			horizontal: input.horizontal,
			stacked: input.stacked,
			palette: printPalette(input.datasets),
			fontFamily: input.fontFamily,
			legend: true
		});

		configuration.options = {
			...configuration.options,
			responsive: false,
			devicePixelRatio: SHEET_SCALE
		};

		const chart = new Chart(canvas, configuration);

		try {
			// `destroy` стирает холст: растр переносится до него.
			const copy = document.createElement('canvas');

			copy.width = canvas.width;
			copy.height = canvas.height;
			context2d(copy).drawImage(canvas, 0, 0);

			return copy;
		} finally {
			chart.destroy();
		}
	} finally {
		host.remove();
	}
}

/**
 * Лист выгрузки: заголовок, условия выборки и диаграмма с легендой на белом.
 * Одна и та же сборка идёт и в PNG, и в PDF.
 */
export async function renderChartSheet(input: ChartSheetInput): Promise<HTMLCanvasElement> {
	const palette = printPalette(input.datasets);
	const chartHeight = input.horizontal
		? horizontalHeight(input.labels.length) + SHEET_LEGEND_HEIGHT
		: SHEET_VERTICAL_HEIGHT;
	const chart = await renderChart(input, chartHeight);

	const sheet = document.createElement('canvas');
	const context = context2d(sheet);

	context.font = `400 ${CONTEXT_SIZE}px ${input.fontFamily}`;
	const contextLines = input.context.flatMap((line) => wrap(context, line, SHEET_CHART_WIDTH));

	context.font = `600 ${TITLE_SIZE}px ${input.fontFamily}`;
	const titleLines = wrap(context, input.title, SHEET_CHART_WIDTH);

	const headerHeight = titleLines.length * TITLE_LINE + contextLines.length * CONTEXT_LINE;
	const width = SHEET_CHART_WIDTH + SHEET_PADDING * 2;
	const height = SHEET_PADDING * 2 + headerHeight + HEADER_GAP + chartHeight;

	sheet.width = width * SHEET_SCALE;
	sheet.height = height * SHEET_SCALE;

	// Размер холста сбрасывает всё состояние контекста: шрифт и масштаб
	// ставятся после него.
	context.scale(SHEET_SCALE, SHEET_SCALE);
	context.fillStyle = palette.sheet;
	context.fillRect(0, 0, width, height);
	context.textBaseline = 'top';

	let y = SHEET_PADDING;

	context.fillStyle = palette.ink;
	context.font = `600 ${TITLE_SIZE}px ${input.fontFamily}`;

	for (const line of titleLines) {
		context.fillText(line, SHEET_PADDING, y + (TITLE_LINE - TITLE_SIZE) / 2);
		y += TITLE_LINE;
	}

	context.fillStyle = palette.axis;
	context.font = `400 ${CONTEXT_SIZE}px ${input.fontFamily}`;

	for (const line of contextLines) {
		context.fillText(line, SHEET_PADDING, y + (CONTEXT_LINE - CONTEXT_SIZE) / 2);
		y += CONTEXT_LINE;
	}

	y += HEADER_GAP;
	context.drawImage(chart, SHEET_PADDING, y, SHEET_CHART_WIDTH, chartHeight);

	return sheet;
}

/** Поля страницы в пунктах: узкая рамка, чтобы диаграмма не липла к краю. */
const MARGIN_POINTS = 24;

/** A4 альбомная в пунктах — тот же лист, что у серверного PDF отчёта. */
const PAGE_WIDTH_POINTS = 842;
const PAGE_HEIGHT_POINTS = 595;

/** Качество JPEG: выше почти не видно, а вес растёт вдвое. */
const JPEG_QUALITY = 0.92;

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

export function downloadChartPng(sheet: HTMLCanvasElement, fileName: string): void {
	download(dataUrlToBlob(sheet.toDataURL('image/png'), 'image/png'), fileName);
}

export function downloadChartPdf(sheet: HTMLCanvasElement, fileName: string): void {
	const jpeg = dataUrlToBytes(sheet.toDataURL('image/jpeg', JPEG_QUALITY));

	download(pdfWithImage(jpeg, sheet.width, sheet.height), fileName);
}

function dataUrlToBlob(dataUrl: string, type: string): Blob {
	return new Blob([dataUrlToBytes(dataUrl)] as BlobPart[], { type });
}
