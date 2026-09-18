/**
 * Разбор колонки «Контакты вуза» рабочей таблицы.
 *
 * В файле это одна ячейка свободного текста: «Иванова Мария Петровна, +7 (999)
 * 123-45-67, m.ivanova@vuz.ru; Петров П. П., проректор, p@vuz.ru». Порядок
 * частей не закреплён ничем, поэтому разбор идёт от того, что узнаётся
 * однозначно: почта и телефон — по виду, а остальное — это имя и должность.
 *
 * Модуль чистый: ни базы, ни прав. Он отвечает на один вопрос — «что за люди
 * названы в этой ячейке», — и на него обязан отвечать одинаково и на
 * предпросмотре, и на применении.
 *
 * Чего он не делает: не догадывается. Строка, в которой не нашлось имени,
 * возвращается как неразобранная, а не превращается в человека без фамилии:
 * запись о человеке — это персональные данные, и заводить её по догадке нельзя.
 */

/** Имя человека в том виде, в каком его показывают и сверяют. */
export type ContactName = {
	lastName: string;
	firstName: string;
	/** `null` — отчества в ячейке нет. */
	middleName: string | null;
};

/** Чем контакт узнаётся среди уже заведённых у организации. */
export type ContactIdentity = ContactName & {
	email: string | null;
	phone: string | null;
};

/** Человек, названный в ячейке контактов. */
export type ParsedContact = ContactIdentity & {
	/** Должность из ячейки или общее название роли, если её там не назвали. */
	position: string;
};

/** Что вышло из ячейки: разобранные люди и куски, в которых имени не нашлось. */
export type ContactParseResult = {
	contacts: ParsedContact[];
	/** Куски ячейки, из которых человека не собрать: их текст как есть. */
	unparsed: string[];
};

/** Должность, когда в ячейке её не назвали. */
export const CONTACT_DEFAULT_POSITION = 'Контакт вуза (импорт каталога)';

/**
 * Почта: узкий вид, а не RFC. Ячейка — это текст, набранный человеком, и
 * широкий разбор принял бы за адрес обрывок фразы со «собакой».
 */
const EMAIL = /[\p{L}\d._%+-]+@[\p{L}\d.-]+\.\p{L}{2,}/u;

/** Телефон: плюс, скобки, дефисы и пробелы вокруг цифр. */
const PHONE = /\+?\d[\d\s()-]{7,}\d/;

/** Сколько цифр обязано быть в телефоне: короче — это не номер, а год или дом. */
const PHONE_MIN_DIGITS = 10;

/** Инициалы одним словом: `И.И.` и `И.И` — это два инициала, а не одно имя. */
const PAIRED_INITIALS = /^(\p{L})\.\s*(\p{L})\.?$/u;

/** Слово имени: буквы, дефис и, у инициала, точка. Цифре в имени места нет. */
const NAME_WORD = /^\p{L}[\p{L}-]*\.?$/u;

/** Сколько слов подряд считается ФИО: фамилия, имя и, если есть, отчество. */
const MAX_NAME_WORDS = 3;

/** Люди в ячейке разделены точкой с запятой или переводом строки. */
const PEOPLE_SEPARATOR = /[;\n\r]+/;

/** Части одного человека разделены запятой. */
const PART_SEPARATOR = /\s*,\s*/;

/** Почта в сравнимом виде: регистр адреса значения не имеет. */
export function normalizeContactEmail(email: string): string {
	return email.trim().toLocaleLowerCase('ru');
}

/** Телефон в сравнимом виде: одни цифры, потому что скобки пишут кто как. */
export function normalizeContactPhone(phone: string): string {
	return phone.replaceAll(/\D/g, '');
}

/** ФИО одной строкой — так его показывает предпросмотр и ищет дедупликация. */
export function contactFullName(contact: ContactName): string {
	return [contact.lastName, contact.firstName, contact.middleName]
		.filter((part): part is string => part !== null)
		.join(' ');
}

/** Разбивает `И.И.` на два слова, остальные слова оставляет как есть. */
function splitInitials(word: string): string[] {
	const paired = PAIRED_INITIALS.exec(word);

	return paired === null ? [word] : [`${paired[1]}.`, `${paired[2]}.`];
}

/** Первая буква заглавная, остальные как в файле: `ИВАНОВ` → `Иванов`. */
function capitalize(word: string): string {
	return word.slice(0, 1).toLocaleUpperCase('ru') + word.slice(1).toLocaleLowerCase('ru');
}

/**
 * Имя из остатка куска: первые два-три слова.
 *
 * Два слова — это фамилия и имя, три — с отчеством; всё, что дальше, — уже
 * должность («Иванов Иван Иванович, начальник отдела» без запятой). Меньше
 * двух слов — имени нет: у человека в справочнике фамилия и имя обязательны.
 */
function readName(words: readonly string[]): { name: ContactName; rest: string[] } | null {
	const expanded = words.flatMap(splitInitials);
	const named: string[] = [];

	for (const word of expanded) {
		if (named.length === MAX_NAME_WORDS || !NAME_WORD.test(word)) {
			break;
		}

		named.push(word);
	}

	if (named.length < 2) {
		return null;
	}

	return {
		name: {
			lastName: capitalize(named[0]),
			firstName: capitalize(named[1]),
			middleName: named[2] === undefined ? null : capitalize(named[2])
		},
		rest: expanded.slice(named.length)
	};
}

/** Один человек из куска ячейки или `null`, если имени в нём не нашлось. */
function parseOne(chunk: string): ParsedContact | null {
	let rest = chunk;

	const email = EMAIL.exec(rest)?.[0] ?? null;

	if (email !== null) {
		rest = rest.replace(email, ' ');
	}

	const phoneMatch = PHONE.exec(rest)?.[0] ?? null;
	const phone =
		phoneMatch !== null && normalizeContactPhone(phoneMatch).length >= PHONE_MIN_DIGITS
			? phoneMatch.trim()
			: null;

	if (phone !== null) {
		rest = rest.replace(phoneMatch as string, ' ');
	}

	// Должность едет в отдельной части ячейки («Петров П. П., проректор»),
	// поэтому части не склеиваются: имя ищется в первой, где оно вообще есть.
	const parts = rest
		.split(PART_SEPARATOR)
		.map((part) => part.trim())
		.filter((part) => part !== '');

	for (const [index, part] of parts.entries()) {
		const read = readName(part.split(/\s+/));

		if (read === null) {
			continue;
		}

		const position = [...read.rest, ...parts.slice(index + 1)].join(' ').trim();

		return {
			...read.name,
			email,
			phone,
			position: position === '' ? CONTACT_DEFAULT_POSITION : position
		};
	}

	return null;
}

/**
 * Люди из ячейки контактов.
 *
 * Пустая ячейка — это ноль людей и ноль претензий: «здесь нет данных», а не
 * «данные неверны». Кусок без имени попадает в `unparsed` целиком — человек
 * увидит в претензии ровно тот текст, который система не поняла.
 */
export function parseContacts(value: string): ContactParseResult {
	const contacts: ParsedContact[] = [];
	const unparsed: string[] = [];

	for (const raw of value.split(PEOPLE_SEPARATOR)) {
		const chunk = raw.trim();

		if (chunk === '') {
			continue;
		}

		const contact = parseOne(chunk);

		if (contact === null) {
			unparsed.push(chunk);
		} else {
			contacts.push(contact);
		}
	}

	return { contacts, unparsed };
}
