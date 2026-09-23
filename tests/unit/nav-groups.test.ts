/**
 * Свёрнутые группы меню: что открыто, пока человек ничего не решал, и что
 * остаётся от его решения после перезагрузки.
 *
 * Проверяется правило, а не разметка: его читает и панель на странице, и
 * выдвижное меню телефона, и оно же решает, куда попадёт человек, открывший
 * систему впервые.
 */
import { describe, expect, it } from 'vitest';
import { navGroupCollapsed, parseNavGroups } from '$lib/components/app-shell/nav-groups';

describe('группы меню по умолчанию', () => {
	it('свернуты только у настроек: их заводят однажды', () => {
		expect(navGroupCollapsed({}, 'settings', false)).toBe(true);
		expect(navGroupCollapsed({}, 'main', false)).toBe(false);
		expect(navGroupCollapsed({}, 'directory', false)).toBe(false);
		expect(navGroupCollapsed({}, 'other', false)).toBe(false);
		expect(navGroupCollapsed({}, 'workspace:b2b', false)).toBe(false);
	});

	it('раскрывают настройки, когда открыта страница внутри них', () => {
		// Меню, в котором не видно, где ты стоишь, отвечает не на тот вопрос, с
		// которым в него смотрят.
		expect(navGroupCollapsed({}, 'settings', true)).toBe(false);
	});

	it('слушают решение человека даже против страницы, на которой он стоит', () => {
		expect(navGroupCollapsed({ settings: true }, 'settings', true)).toBe(true);
		expect(navGroupCollapsed({ settings: false }, 'settings', false)).toBe(false);
		expect(navGroupCollapsed({ main: true }, 'main', false)).toBe(true);
	});
});

describe('запись решений в браузере', () => {
	it('читается обратно такой, какой записана', () => {
		expect(parseNavGroups(JSON.stringify({ settings: false, main: true }))).toEqual({
			settings: false,
			main: true
		});
	});

	it('на чистой установке пуста', () => {
		expect(parseNavGroups(null)).toEqual({});
	});

	it('не валит меню испорченным содержимым: группы встают по умолчанию', () => {
		expect(parseNavGroups('{')).toEqual({});
		expect(parseNavGroups('"settings"')).toEqual({});
		expect(parseNavGroups('[1, 2]')).toEqual({});
		expect(parseNavGroups(JSON.stringify({ settings: 'да', main: false }))).toEqual({
			main: false
		});
	});
});
