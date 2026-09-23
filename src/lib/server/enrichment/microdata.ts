/**
 * Чтение микроданных HTML (`itemprop`, `itemtype`) без разбора документа.
 *
 * Раздел «Сведения об образовательной организации» размечен микроданными по
 * приказу Рособрнадзора: у каждого сведения — свой `itemprop`, а у блока —
 * `itemtype` вида `http://obrnadzor.gov.ru/microdata/...`. Читать оттуда нужно
 * десяток значений, и полноценное дерево документа для этого не требуется.
 *
 * Отсюда и отказ от библиотеки разбора HTML: зависимость, которая умеет всё,
 * ради десяти атрибутов — это ещё одна цепочка поставки в сборке и ещё один
 * разбор недоверенной разметки в памяти сервера. Сканер идёт по тегам
 * регулярным выражением, и его слабость известна заранее: вложенность он
 * считает по именам тегов, поэтому незакрытый `<div>` внутри значения обрежет
 * его по следующему закрывающему. Для страницы, где значения — это ФИО,
 * телефон и адрес, цена такой ошибки — обрезанная строка на экране рядом с
 * пометкой источника, а не испорченная карточка: в справочник ничего не
 * записывается само.
 *
 * Модуль намеренно свободен от настроек и сети: на вход строка, на выходе
 * значения, и проверяется он на строках.
 */

/** Теги, у которых значение свойства — в атрибуте, а не в тексте. */
const VALUE_ATTRIBUTES: Record<string, string> = {
	meta: 'content',
	a: 'href',
	area: 'href',
	link: 'href',
	audio: 'src',
	embed: 'src',
	iframe: 'src',
	img: 'src',
	source: 'src',
	track: 'src',
	video: 'src',
	object: 'data',
	data: 'value',
	time: 'datetime'
};

/** Теги без закрывающей пары: искать у них текст нечего. */
const VOID_TAGS = new Set([
	'area',
	'base',
	'br',
	'col',
	'embed',
	'hr',
	'img',
	'input',
	'link',
	'meta',
	'param',
	'source',
	'track',
	'wbr'
]);

const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	laquo: '«',
	raquo: '»',
	mdash: '—',
	ndash: '–',
	shy: ''
};

function codePoint(value: number, whole: string): string {
	return Number.isInteger(value) && value > 0 && value <= 0x10ffff
		? String.fromCodePoint(value)
		: whole;
}

function decodeEntities(value: string): string {
	return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
		const lower = body.toLowerCase();

		if (lower.startsWith('#x')) {
			return codePoint(Number.parseInt(lower.slice(2), 16), whole);
		}

		if (lower.startsWith('#')) {
			return codePoint(Number.parseInt(lower.slice(1), 10), whole);
		}

		return NAMED_ENTITIES[lower] ?? whole;
	});
}

/** Текст в том виде, в каком его читает человек: без сущностей и без разметки. */
export function plainText(html: string): string {
	return decodeEntities(html.replace(/<[^>]*>/g, ' '))
		.replace(/\s+/g, ' ')
		.trim();
}

const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

/** Атрибуты тега по его «внутренностям» — тому, что между именем тега и `>`. */
function attributes(raw: string): Map<string, string> {
	const found = new Map<string, string>();

	for (const match of raw.matchAll(ATTRIBUTE)) {
		const value = match[2] ?? '';
		const unquoted = /^["']/.test(value) ? value.slice(1, -1) : value;

		found.set(match[1].toLowerCase(), decodeEntities(unquoted).trim());
	}

	return found;
}

/** Убирает то, что текстом страницы не является: скрипты, стили, комментарии. */
function withoutNoise(html: string): string {
	return html
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
		.replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ');
}

/**
 * Содержимое элемента, открывающий тег которого кончился на `from`.
 *
 * Вложенность считается по имени тега: каждый следующий `<div` увеличивает
 * глубину, каждый `</div` уменьшает, и значение кончается там, где глубина
 * дошла до нуля. Закрывающего тега может не быть вовсе — тогда берётся остаток
 * страницы, и обрезает его уже потолок длины значения.
 */
function contentOf(html: string, tag: string, from: number): string {
	const marks = new RegExp(`<(/?)${tag}\\b`, 'gi');

	marks.lastIndex = from;

	let depth = 1;
	let mark = marks.exec(html);

	while (mark !== null) {
		depth += mark[1] === '/' ? -1 : 1;

		if (depth === 0) {
			return html.slice(from, mark.index);
		}

		mark = marks.exec(html);
	}

	return html.slice(from);
}

/** Потолок длины одного значения: в микроданных это строка, а не документ. */
const VALUE_MAX = 1000;

export type Microdata = {
	/** Значения свойств по именам: одно имя встречается на странице не раз. */
	properties: Map<string, string[]>;
	/** Все встреченные `itemtype` — по ним видно, чья это разметка. */
	types: Set<string>;
};

const TAG = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

/** Микроданные страницы. Пустой результат — разметки нет, а не «нет страницы». */
export function readMicrodata(html: string): Microdata {
	const source = withoutNoise(html);
	const properties = new Map<string, string[]>();
	const types = new Set<string>();

	for (const match of source.matchAll(TAG)) {
		const tag = match[1].toLowerCase();
		const attrs = attributes(match[2]);
		const itemtype = attrs.get('itemtype');

		if (itemtype !== undefined && itemtype !== '') {
			types.add(itemtype);
		}

		const itemprop = attrs.get('itemprop');

		if (itemprop === undefined || itemprop === '') {
			continue;
		}

		const attribute = VALUE_ATTRIBUTES[tag];
		const raw =
			attribute !== undefined && attrs.has(attribute)
				? (attrs.get(attribute) as string)
				: VOID_TAGS.has(tag)
					? ''
					: plainText(contentOf(source, tag, match.index + match[0].length));
		const value = raw.replace(/\s+/g, ' ').trim().slice(0, VALUE_MAX);

		if (value === '') {
			continue;
		}

		// Имя свойства пишут и `fullName`, и `fullname`: разметку расставляли
		// руками на сотнях сайтов, и различать эти два написания значило бы
		// потерять половину страниц на ровном месте.
		const name = itemprop.toLowerCase();
		const known = properties.get(name);

		if (known === undefined) {
			properties.set(name, [value]);
		} else if (!known.includes(value)) {
			known.push(value);
		}
	}

	return { properties, types };
}

/** Первое значение свойства; `null` — свойства на странице нет. */
export function property(data: Microdata, name: string): string | null {
	return data.properties.get(name.toLowerCase())?.[0] ?? null;
}

/** Первое значение из нескольких написаний одного и того же свойства. */
export function firstProperty(data: Microdata, names: readonly string[]): string | null {
	for (const name of names) {
		const value = property(data, name);

		if (value !== null) {
			return value;
		}
	}

	return null;
}
