/**
 * Раскладка доски: колонки задаёт маршрут, состояние карточки — движок.
 *
 * Обе функции чистые, и проверяются они здесь, без базы: порядок колонок,
 * пустая стадия, счётчики обрезанной колонки и старшинство состояний — это
 * правила, а не запрос. Вопрос «что вернул `row_number()`» закрыт
 * интеграционным тестом.
 */
import { describe, expect, it } from 'vitest';
import type { InteractionBoardCard, StageView } from '$lib/contracts/interactions';
import {
	boardCardState,
	buildBoardColumns,
	chooseBoardRoute,
	type BoardEntry
} from '$lib/server/interactions/board';

const ROUTE_ID = '11111111-1111-4111-8111-111111111111';

function stage(position: number, key: string, name: string): StageView {
	return {
		id: `stage-${key}`,
		routeId: ROUTE_ID,
		position,
		key,
		name,
		category: 'contact',
		slaDays: 5,
		staleAfterDays: null,
		requiresResult: false,
		requiresConfirmation: false,
		checklist: []
	};
}

function card(id: string, stageId: string): InteractionBoardCard {
	return {
		id,
		title: `Взаимодействие ${id}`,
		organizationName: 'Учебное заведение',
		offerings: [],
		ownerName: 'Ответственный',
		stageId,
		dueAt: new Date('2026-09-20T09:00:00.000Z'),
		state: 'current',
		openBlockers: 0,
		transitions: []
	};
}

function entry(
	id: string,
	stageId: string,
	totals: { count: number; overdue: number }
): BoardEntry {
	return { card: card(id, stageId), totals };
}

const STAGES = [stage(2, 'documents', 'Обмен документами'), stage(1, 'contact', 'Поиск контактов')];

describe('buildBoardColumns', () => {
	it('ставит колонки в порядке стадий маршрута, а не в порядке строк', () => {
		const columns = buildBoardColumns(STAGES, [
			entry('a', 'stage-documents', { count: 1, overdue: 0 })
		]);

		expect(columns.map((column) => column.key)).toEqual(['contact', 'documents']);
	});

	it('оставляет стадию без карточек колонкой с нулями', () => {
		const columns = buildBoardColumns(STAGES, [
			entry('a', 'stage-documents', { count: 1, overdue: 1 })
		]);

		expect(columns[0]).toMatchObject({ key: 'contact', count: 0, overdue: 0, cards: [] });
	});

	it('берёт счётчики колонки из подсчёта по всей стадии, а не по показанным', () => {
		// Колонка обрезана потолком: показаны две карточки из сорока.
		const columns = buildBoardColumns(STAGES, [
			entry('a', 'stage-contact', { count: 40, overdue: 7 }),
			entry('b', 'stage-contact', { count: 40, overdue: 7 })
		]);

		expect(columns[0]).toMatchObject({ count: 40, overdue: 7 });
		expect(columns[0].cards.map((item) => item.id)).toEqual(['a', 'b']);
	});

	it('сохраняет порядок карточек внутри колонки', () => {
		const columns = buildBoardColumns(STAGES, [
			entry('first', 'stage-contact', { count: 3, overdue: 0 }),
			entry('second', 'stage-contact', { count: 3, overdue: 0 }),
			entry('third', 'stage-contact', { count: 3, overdue: 0 })
		]);

		expect(columns[0].cards.map((item) => item.id)).toEqual(['first', 'second', 'third']);
	});
});

describe('boardCardState', () => {
	it('называет помеху раньше паузы и просрочки', () => {
		expect(boardCardState({ blockingBlockers: 1, isPaused: true, isOverdue: true })).toBe(
			'blocked'
		);
	});

	it('называет паузу раньше просрочки: часы стадии остановлены', () => {
		expect(boardCardState({ blockingBlockers: 0, isPaused: true, isOverdue: true })).toBe('paused');
	});

	it('различает просроченную и идущую в срок', () => {
		expect(boardCardState({ blockingBlockers: 0, isPaused: false, isOverdue: true })).toBe(
			'overdue'
		);
		expect(boardCardState({ blockingBlockers: 0, isPaused: false, isOverdue: false })).toBe(
			'current'
		);
	});
});

describe('chooseBoardRoute', () => {
	const withWork = {
		id: 'route-a',
		name: 'Версия 1',
		version: 1,
		interactions: 5,
		isDefault: false
	};
	const byDefault = {
		id: 'route-b',
		name: 'Версия 2',
		version: 2,
		interactions: 0,
		isDefault: true
	};

	it('открывает запрошенную версию, даже если по ней никто не идёт', () => {
		expect(chooseBoardRoute([withWork, byDefault], 'route-b')).toBe('route-b');
	});

	it('не верит непонятной версии из адреса', () => {
		expect(chooseBoardRoute([withWork, byDefault], 'не-идентификатор')).toBe('route-a');
	});

	it('предпочитает маршрут по умолчанию, когда работа есть и на нём', () => {
		const working = { ...byDefault, interactions: 2 };

		expect(chooseBoardRoute([withWork, working], null)).toBe(working.id);
	});

	it('берёт версию с работой, когда на маршруте по умолчанию пусто', () => {
		expect(chooseBoardRoute([withWork, byDefault], null)).toBe('route-a');
	});

	it('возвращается к маршруту по умолчанию, когда работы нет нигде', () => {
		expect(chooseBoardRoute([{ ...withWork, interactions: 0 }, byDefault], null)).toBe('route-b');
	});

	it('без опубликованных маршрутов не выбирает ничего', () => {
		expect(chooseBoardRoute([], null)).toBeNull();
	});
});
