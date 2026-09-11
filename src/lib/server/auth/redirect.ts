/**
 * Куда вернуть человека после входа.
 *
 * Адрес приходит из запроса, поэтому доверять ему нельзя: ссылка вида
 * `/login?next=https://evil.example` превращает собственную страницу входа в
 * трамплин на чужой сайт, а `//evil.example` браузер понимает как адрес с
 * протоколом текущей страницы. Принимается только путь внутри приложения.
 */

/**
 * Управляющие символы разрезают заголовок `Location` на два, поэтому путь с
 * ними — не путь. Проверка посимвольная, а не регулярным выражением: диапазон
 * управляющих символов в самом выражении нечитаем и запрещён линтером.
 */
function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;

		if (code < 0x20 || code === 0x7f) {
			return true;
		}
	}

	return false;
}

/** Путь, на который можно перенаправить, или `/`, если присланному верить нельзя. */
export function safeNextPath(raw: string | null | undefined): string {
	if (raw === undefined || raw === null || raw === '') {
		return '/';
	}

	if (hasControlCharacter(raw)) {
		return '/';
	}

	if (!raw.startsWith('/')) {
		return '/';
	}

	// `//host` — адрес с протоколом текущей страницы, `/\host` браузеры понимают
	// так же: и то и другое уводит с нашего происхождения.
	if (raw.startsWith('//') || raw.startsWith('/\\')) {
		return '/';
	}

	return raw;
}
