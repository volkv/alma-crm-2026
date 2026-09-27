/**
 * Разбор статьи справки не зависит от переводов строк: клон на Windows отдаёт
 * файлы с `\r\n`, и справка на нём обязана открываться так же, как на Linux.
 */
import { describe, expect, it } from 'vitest';
import { parseHelpArticle } from '$lib/help/article';

const PATH = './content/user/01-start.md';
const LF = '---\ntitle: Вход\norder: 1\nrole: user\nsummary: Коротко\n---\n\nТекст\nстатьи\n';

describe('статья справки', () => {
	it('разбирается одинаково с LF, CRLF и BOM', () => {
		const expected = parseHelpArticle(PATH, LF);

		expect(parseHelpArticle(PATH, LF.replaceAll('\n', '\r\n'))).toEqual(expected);
		expect(parseHelpArticle(PATH, String.fromCharCode(0xfeff) + LF)).toEqual(expected);
		expect(expected.title).toBe('Вход');
		expect(expected.markdown).toBe('\nТекст\nстатьи\n');
	});
});
