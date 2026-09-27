/**
 * Разбор адреса отчёта.
 *
 * Адрес — единственный источник для таблицы, диаграмм и всех четырёх выгрузок,
 * поэтому его разбор ломается молча: непонятый фильтр не показывает ошибку, он
 * показывает другие числа. Здесь проверяется ровно граница между «значение не
 * годится и просто не фильтр» и «вопрос задан неверно, отвечать нечем».
 */
import { describe, expect, it } from 'vitest';
import { moscowDayStart, snapshotMoment } from '$lib/contracts/calendar';
import {
	columnsForMode,
	quarterStart,
	reportSemantics,
	resolveColumns
} from '$lib/contracts/reports';
import { ValidationError } from '$lib/server/errors';
import { readReportQuery } from '$lib/server/reports/query';

const TODAY = '2026-09-17';

function read(query: string) {
	return readReportQuery(new URL(`http://localhost/reports${query}`), TODAY);
}

describe('период', () => {
	it('по умолчанию берёт квартал до сегодняшнего дня', () => {
		const parsed = read('');

		expect(parsed.mode).toBe('snapshot');
		expect(parsed.from).toBe('2026-07-01');
		expect(parsed.to).toBe(TODAY);
	});

	it('квартал считается по месяцу, а не по кварталам подряд', () => {
		expect(quarterStart('2026-01-05')).toBe('2026-01-01');
		expect(quarterStart('2026-06-30')).toBe('2026-04-01');
		expect(quarterStart('2026-12-31')).toBe('2026-10-01');
	});

	it('отказывается собирать отчёт по испорченной дате', () => {
		// Молча подставленный квартал означал бы отчёт не за тот период, о чём
		// читающий не узнает.
		expect(() => read('?from=вчера')).toThrow(ValidationError);
	});

	it('отказывается собирать отчёт за период задом наперёд', () => {
		expect(() => read('?from=2026-12-31&to=2026-10-01')).toThrow(ValidationError);
	});

	it('момент среза — начало суток, следующих за днём «по»', () => {
		const asOf = snapshotMoment('2026-12-31');

		expect(asOf.toISOString()).toBe('2026-12-31T21:00:00.000Z');
		expect(asOf.getTime() - moscowDayStart('2026-12-31').getTime()).toBe(24 * 60 * 60 * 1000);
	});
});

describe('многозначные фильтры', () => {
	const uuid = '11111111-1111-4111-8111-111111111111';
	const other = '22222222-2222-4222-8222-222222222222';

	it('понимают перечисление через запятую', () => {
		expect(read(`?prod=${uuid},${other}`).prod).toStrictEqual([uuid, other]);
	});

	it('понимают повторённый параметр', () => {
		expect(read(`?prod=${uuid}&prod=${other}`).prod).toStrictEqual([uuid, other]);
	});

	it('выбрасывают то, что не является идентификатором записи', () => {
		// Человек правил ссылку руками: показывать ему отказ вместо отчёта незачем.
		expect(read(`?org=${uuid},мусор`).org).toStrictEqual([uuid]);
	});

	it('выбрасывают значение вне словаря', () => {
		expect(read('?state=active,летающее').state).toStrictEqual(['active']);
		expect(read('?party=individual,нечто').party).toStrictEqual(['individual']);
	});

	it('пустое значение фильтром не считается', () => {
		expect(read('?prod=').prod).toStrictEqual([]);
		expect(read('?stage=,,').stage).toStrictEqual([]);
	});

	it('признаки читаются только как «да»', () => {
		expect(read('?overdue=true').overdue).toBe(true);
		expect(read('?overdue=1').overdue).toBe(false);
		expect(read('').overdue).toBe(false);
	});

	it('неизвестный параметр адреса не мешает', () => {
		expect(read('?page=3&sort=title&mode=movement').mode).toBe('movement');
	});

	it('непонятный режим — это срез, а не отказ', () => {
		expect(read('?mode=диаграмма').mode).toBe('snapshot');
	});
});

describe('набор колонок', () => {
	it('без параметра даёт набор по умолчанию своего режима', () => {
		const snapshot = resolveColumns('snapshot', []).map((column) => column.key);
		const movement = resolveColumns('movement', []).map((column) => column.key);

		expect(snapshot).toContain('stage');
		expect(snapshot).not.toContain('stageFrom');
		expect(movement).toContain('moveKind');
		expect(movement).not.toContain('stage');
	});

	it('порядок берёт из каталога, а не из адреса', () => {
		const asked = resolveColumns('snapshot', ['state', 'organization', 'interaction']);

		expect(asked.map((column) => column.key)).toStrictEqual([
			'interaction',
			'organization',
			'state'
		]);
	});

	it('обязательные колонки добавляет всегда, а неизвестные ключи игнорирует', () => {
		const asked = resolveColumns('snapshot', ['stage', 'такой-колонки-нет']);

		expect(asked.map((column) => column.key)).toStrictEqual([
			'interaction',
			'organization',
			'stage'
		]);
	});

	it('колонку чужого режима не показывает', () => {
		const asked = resolveColumns('snapshot', ['moveKind']);

		expect(asked.map((column) => column.key)).toStrictEqual(['interaction', 'organization']);
	});

	it('каталог каждого режима непустой и не пересекается по чужим колонкам', () => {
		expect(columnsForMode('snapshot').length).toBeGreaterThan(0);
		expect(columnsForMode('movement').length).toBeGreaterThan(0);
		expect(columnsForMode('snapshot').some((column) => column.key === 'movedAt')).toBe(false);
	});
});

describe('текст правила', () => {
	it('называет дату среза и границы исключения', () => {
		const text = reportSemantics('snapshot', '2026-10-01', '2026-12-31');

		expect(text).toContain('Срез на 31.12.2026');
		expect(text).toContain('закрытые раньше 01.10.2026');
	});

	it('в движении говорит про переходы, а не про стояние', () => {
		const text = reportSemantics('movement', '2026-10-01', '2026-12-31');

		expect(text).toContain('Движение за 01.10.2026 — 31.12.2026');
		expect(text).toContain('Возвраты и пропуски считаются отдельно');
	});
});
