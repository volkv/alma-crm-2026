/**
 * Ключ из названия: латиница вместо кириллицы, разделитель вместо пробелов и
 * знаков.
 *
 * Ключи стадий, пунктов чек-листа, пространств и процессов — машинные имена:
 * они стоят в адресах и в слепках пройденных стадий и живут дольше названия.
 * Придумывать латиницу — не работа администратора, поэтому форма предлагает
 * ключ из того, что он уже написал, а поправить его можно руками.
 */

const LETTERS: Record<string, string> = {
	а: 'a',
	б: 'b',
	в: 'v',
	г: 'g',
	д: 'd',
	е: 'e',
	ё: 'e',
	ж: 'zh',
	з: 'z',
	и: 'i',
	й: 'y',
	к: 'k',
	л: 'l',
	м: 'm',
	н: 'n',
	о: 'o',
	п: 'p',
	р: 'r',
	с: 's',
	т: 't',
	у: 'u',
	ф: 'f',
	х: 'h',
	ц: 'ts',
	ч: 'ch',
	ш: 'sh',
	щ: 'sch',
	ъ: '',
	ы: 'y',
	ь: '',
	э: 'e',
	ю: 'yu',
	я: 'ya'
};

export type KeyStyle = {
	/** Чем разделять слова: у стадий и пунктов — `_`, в адресах — `-`. */
	separator: '_' | '-';
	maxLength: number;
	/**
	 * Приставка, если ключ начался бы с цифры или вышел пустым; `null` — такой
	 * ключ остаётся пустым, и его вводят руками.
	 */
	fallback: string | null;
};

/** Ключ стадии и пункта чек-листа: `^[a-z][a-z0-9_-]*$`, до 100 символов. */
export const STAGE_KEY_STYLE: KeyStyle = { separator: '_', maxLength: 60, fallback: 'stage' };

/** Ключ пункта чек-листа — те же правила, что у стадии. */
export const CHECKLIST_KEY_STYLE: KeyStyle = { separator: '_', maxLength: 60, fallback: 'item' };

/** Ключ пространства и процесса: `^[a-z0-9]+(-[a-z0-9]+)*$`, от 2 до 40 символов. */
export const ADDRESS_KEY_STYLE: KeyStyle = { separator: '-', maxLength: 40, fallback: null };

/**
 * Ключ, свободный среди `taken`: при совпадении дописывается номер. Пустая
 * строка — из названия ключ не собрать (у адресного ключа без приставки).
 */
export function keyFromName(
	name: string,
	style: KeyStyle,
	taken: ReadonlySet<string> = new Set()
): string {
	const { separator } = style;
	const latin = [...name.toLocaleLowerCase('ru')]
		.map((letter) => LETTERS[letter] ?? letter)
		.join('')
		.replaceAll(/[^a-z0-9]+/g, separator);
	let base = trimSeparators(latin.slice(0, style.maxLength), separator);

	if (base === '' || /^[0-9]/.test(base)) {
		if (style.fallback === null) {
			if (base.length < 2) {
				return '';
			}
		} else {
			base = trimSeparators(
				(base === '' ? style.fallback : `${style.fallback}${separator}${base}`).slice(
					0,
					style.maxLength
				),
				separator
			);
		}
	}

	if (base.length < 2) {
		return style.fallback === null ? '' : `${style.fallback}${separator}${base}`;
	}

	if (!taken.has(base)) {
		return base;
	}

	for (let suffix = 2; ; suffix += 1) {
		const tail = `${separator}${suffix}`;
		const candidate = `${trimSeparators(base.slice(0, style.maxLength - tail.length), separator)}${tail}`;

		if (!taken.has(candidate)) {
			return candidate;
		}
	}
}

function trimSeparators(value: string, separator: string): string {
	const edge = separator === '-' ? /^-+|-+$/g : /^_+|_+$/g;

	return value.replaceAll(edge, '');
}
