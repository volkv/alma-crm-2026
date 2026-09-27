/**
 * Каким представлением открывается список взаимодействий: адрес, иначе
 * прошлый выбор, иначе доска — и таблица в пространстве без процесса, которая
 * не запоминается, чтобы не переключить остальные пространства.
 */
import { describe, expect, it } from 'vitest';
import { chooseView } from '../../../src/routes/(app)/w/[workspace]/interactions/view-preference';

describe('выбор представления списка', () => {
	it('адрес важнее памяти, память важнее умолчания, умолчание — доска', () => {
		expect(chooseView({ requested: 'table', stored: 'board', hasWorkflow: true })).toStrictEqual({
			view: 'table',
			remember: true
		});
		expect(chooseView({ requested: null, stored: 'table', hasWorkflow: true })).toStrictEqual({
			view: 'table',
			remember: true
		});
		expect(chooseView({ requested: 'xyz', stored: 'мусор', hasWorkflow: true })).toStrictEqual({
			view: 'board',
			remember: true
		});
	});

	it('без процесса и без выбора открывает таблицу и её не запоминает', () => {
		expect(chooseView({ requested: null, stored: undefined, hasWorkflow: false })).toStrictEqual({
			view: 'table',
			remember: false
		});
		expect(chooseView({ requested: null, stored: 'board', hasWorkflow: false })).toStrictEqual({
			view: 'board',
			remember: true
		});
	});
});
