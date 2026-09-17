/**
 * Кодировка и разделитель текстовой выгрузки.
 *
 * CSV не несёт в себе ни того, ни другого. Русский Excel сохраняет его в
 * `windows-1251` с точкой с запятой, выгрузка из веб-системы — в UTF-8 с
 * запятой, а «Сохранить как → Текст Юникод» даёт UTF-16 с табуляцией. Все три
 * файла называются одинаково и открываются одной кнопкой, поэтому угадывать
 * приходится по содержимому.
 *
 * Порядок проверок важен: BOM — это объявление кодировки самим файлом, и оно
 * сильнее любой эвристики. Без BOM решает строгая раскодировка UTF-8: почти
 * любой русский текст в `windows-1251` даёт невалидные последовательности
 * UTF-8, а обратное неверно — `windows-1251` примет любые байты и выдаст
 * правдоподобный мусор. Поэтому UTF-8 проверяется первым, а `windows-1251`
 * остаётся ответом по остатку.
 */
import { cptable } from 'xlsx/dist/cpexcel.full.mjs';
import { SpreadsheetError } from './errors';

export const TEXT_ENCODINGS = ['utf-8', 'utf-16le', 'utf-16be', 'windows-1251'] as const;

export type TextEncoding = (typeof TEXT_ENCODINGS)[number];

/** Кодировки, в которых продукт отдаёт текстовые выгрузки. */
export type OutputEncoding = Extract<TextEncoding, 'utf-8' | 'windows-1251'>;

export const CSV_DELIMITERS = [';', ',', '\t'] as const;

export type CsvDelimiter = (typeof CSV_DELIMITERS)[number];

export type DecodedText = {
	text: string;
	encoding: TextEncoding;
	/** Была ли в файле метка порядка байтов. */
	bom: boolean;
};

const BOMS: readonly { bytes: readonly number[]; encoding: TextEncoding }[] = [
	{ bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8' },
	{ bytes: [0xff, 0xfe], encoding: 'utf-16le' },
	{ bytes: [0xfe, 0xff], encoding: 'utf-16be' }
];

/** Кодовая страница `windows-1251` в таблицах SheetJS. */
const CP1251 = 1251;

function bomAt(bytes: Uint8Array): (typeof BOMS)[number] | undefined {
	return BOMS.find(
		(bom) => bytes.length >= bom.bytes.length && bom.bytes.every((byte, i) => bytes[i] === byte)
	);
}

/**
 * Управляющие символы, которых в таблице быть не может. Табуляция и переводы
 * строк из списка исключены — это разделители. Всё остальное из диапазона C0
 * (и `\u0000` в первую очередь) означает, что файл не текст, а двоичный: PNG,
 * PDF или архив, который принесли под видом выгрузки.
 */
// eslint-disable-next-line no-control-regex
const BINARY_MARKERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

function decodeStrict(bytes: Uint8Array, encoding: TextEncoding): string | null {
	try {
		return new TextDecoder(encoding, { fatal: true }).decode(bytes);
	} catch {
		// Единственное, что значит исключение здесь, — «байты не этой кодировки».
		// Ответом на это будет следующая кодировка в порядке проверки, а если
		// кончились — ошибка `unknown_format` у вызывающего.
		return null;
	}
}

/**
 * Текст файла и кодировка, в которой он записан, или `null`, если содержимое
 * оказалось двоичным.
 *
 * Отдельно от `decodeText` затем, что «это не текст» — не всегда отказ: тот,
 * кто выясняет тип принесённого файла, спрашивает именно так и ответ «нет»
 * обрабатывает сам.
 */
export function decodeTextOrNull(bytes: Uint8Array): DecodedText | null {
	const bom = bomAt(bytes);
	const encoding = bom?.encoding ?? 'utf-8';
	const body = bom === undefined ? bytes : bytes.subarray(bom.bytes.length);

	// Объявленную кодировку не перепроверяем: если файл сказал «я UTF-16», а
	// байты не складываются, это повреждённый файл, а не повод гадать дальше.
	const strict = decodeStrict(body, encoding);
	const decoded =
		strict === null && bom === undefined
			? { text: decodeStrict(body, 'windows-1251'), encoding: 'windows-1251' as const }
			: { text: strict, encoding };

	if (decoded.text === null || BINARY_MARKERS.test(decoded.text)) {
		return null;
	}

	// BOM в начале строки — это не данные: без него первая колонка называлась бы
	// «\ufeffОрганизация» и не нашлась бы в сопоставлении.
	return {
		text: decoded.text.replace(/^\ufeff/, ''),
		encoding: decoded.encoding,
		bom: bom !== undefined
	};
}

/**
 * Текст файла и кодировка, в которой он записан. Бросает `unknown_format`,
 * если содержимое оказалось двоичным.
 */
export function decodeText(bytes: Uint8Array, fileName: string): DecodedText {
	const decoded = decodeTextOrNull(bytes);

	if (decoded === null) {
		throw new SpreadsheetError('unknown_format', `Файл «${fileName}» не похож на таблицу`, [
			'Принимаем книги XLS и XLSX и текстовые файлы CSV',
			'Если файл выгружен из другой системы, сохраните его как CSV или XLSX'
		]);
	}

	return decoded;
}

/** Первая непустая строка: по ней считается разделитель. */
function headerLine(text: string): string {
	for (const line of text.split('\n')) {
		const trimmed = line.replace(/\r$/, '');

		if (trimmed.trim() !== '') {
			return trimmed;
		}
	}

	return '';
}

/**
 * Разделитель колонок. Считаются только символы вне кавычек: «Университет,
 * филиал» в кавычках — обычное название, и голый подсчёт принял бы файл с
 * точками с запятой за файл с запятыми.
 *
 * Считается по строке заголовка, а не по всему файлу: в данных запятая
 * встречается и внутри значений, а в шапке — почти никогда.
 */
export function detectDelimiter(text: string): CsvDelimiter {
	const line = headerLine(text);
	let best: CsvDelimiter = CSV_DELIMITERS[0];
	let bestCount = 0;

	for (const delimiter of CSV_DELIMITERS) {
		let count = 0;
		let quoted = false;

		for (const char of line) {
			if (char === '"') {
				quoted = !quoted;
			} else if (char === delimiter && !quoted) {
				count += 1;
			}
		}

		if (count > bestCount) {
			best = delimiter;
			bestCount = count;
		}
	}

	return best;
}

/**
 * Байты текстовой выгрузки. `windows-1251` берётся из таблиц SheetJS: в
 * платформе кодировщика для неё нет — `TextEncoder` умеет только UTF-8.
 *
 * Символ, которого в кодовой странице нет, не заменяется молча: подстановка
 * пробела на месте «→» или эмодзи означала бы, что выгрузка тихо отличается от
 * того, что человек видел на экране.
 */
export function encodeText(text: string, encoding: OutputEncoding): Buffer {
	if (encoding === 'utf-8') {
		return Buffer.from(text, 'utf8');
	}

	const table = cptable[CP1251].enc;
	const bytes: number[] = [];
	const missing = new Set<string>();

	for (const char of text) {
		// Тип таблицы объявляет значение как `number`, но ключей в ней меньше,
		// чем символов Unicode: отсутствующие и надо поймать.
		const byte: number | undefined = table[char];

		if (byte === undefined) {
			missing.add(char);
		} else {
			bytes.push(byte);
		}
	}

	if (missing.size > 0) {
		throw new SpreadsheetError(
			'encoding',
			'Выгрузка в кодировке windows-1251 не может передать часть символов',
			[
				`Не укладываются в кодировку: ${[...missing].slice(0, 10).join(' ')}`,
				'Выберите выгрузку в UTF-8 — в ней эти символы сохранятся'
			]
		);
	}

	return Buffer.from(bytes);
}
