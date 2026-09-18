/**
 * Правила отметки по документу: день факта и момент, которым он ложится в базу.
 *
 * Правило одно на форму и на сервис — форма выставляет им границы календаря,
 * сервис им же отвечает на попытку выйти за них. Поэтому проверяется оно здесь,
 * без базы: два свода правил, на клиенте и на сервере, однажды разойдутся, и
 * разойдутся молча.
 */
import { describe, expect, it } from 'vitest';
import {
	markDayBounds,
	markDayIssue,
	markDocumentStatusSchema,
	markMomentFromDay,
	DOCUMENT_STATUS_FACTS,
	DOCUMENT_STATUS_FACT_LABELS
} from '$lib/contracts/documents';

/** Полдень по Москве: день у такого момента один и тот же в любой зоне машины. */
const NOW = new Date('2026-09-18T09:00:00.000Z');
const CREATED_AT = new Date('2026-09-10T18:30:00.000Z');

describe('названия отметок', () => {
	it('есть у каждого факта', () => {
		for (const fact of DOCUMENT_STATUS_FACTS) {
			expect(DOCUMENT_STATUS_FACT_LABELS[fact]).toBeTruthy();
		}
	});
});

describe('схема отметки', () => {
	const documentId = '3f1c2d4e-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

	it('датируется сутками, а не моментом', () => {
		expect(
			markDocumentStatusSchema.safeParse({ documentId, fact: 'agreed', at: '2026-09-12' }).success
		).toBe(true);
		// Часа у отметки нет и в договоре: согласовывают днём, а не минутой, и
		// принятый момент делал бы вид, что время известно.
		expect(
			markDocumentStatusSchema.safeParse({
				documentId,
				fact: 'agreed',
				at: '2026-09-12T10:00:00+03:00'
			}).success
		).toBe(false);
	});

	it('без дня — отметка встаёт текущим моментом', () => {
		expect(markDocumentStatusSchema.parse({ documentId, fact: 'agreed' }).at).toBeNull();
	});
});

describe('границы дня отметки', () => {
	it('от дня появления документа до сегодняшнего по московскому календарю', () => {
		expect(markDayBounds(CREATED_AT, NOW)).toEqual({ min: '2026-09-10', max: '2026-09-18' });
	});

	it('поздний вечер по Москве — это уже следующий день', () => {
		// 21:30 UTC — это 00:30 следующих суток в Москве, и «сегодня» для отметки
		// именно они: сроки процесса считаются по тому же календарю.
		expect(markDayBounds(CREATED_AT, new Date('2026-09-18T21:30:00.000Z')).max).toBe('2026-09-19');
	});
});

describe('проверка дня отметки', () => {
	const bounds = markDayBounds(CREATED_AT, NOW);

	it('пропускает сегодняшний день и любой день задним числом до дня документа', () => {
		expect(markDayIssue('2026-09-18', bounds)).toBeNull();
		expect(markDayIssue('2026-09-12', bounds)).toBeNull();
		expect(markDayIssue('2026-09-10', bounds)).toBeNull();
	});

	it('не пропускает завтрашний день', () => {
		expect(markDayIssue('2026-09-19', bounds)).toBe(
			'Отметка не может быть позже сегодняшнего дня: факта, которого ещё не было, не бывает'
		);
	});

	it('не пропускает день раньше, чем документ появился в системе', () => {
		expect(markDayIssue('2026-09-09', bounds)).toBe(
			'Отметка не может быть раньше дня, когда документ появился в системе'
		);
	});
});

describe('момент отметки по выбранному дню', () => {
	it('сегодняшний день — это «сейчас»: время известно', () => {
		expect(markMomentFromDay('2026-09-18', NOW)).toEqual(NOW);
	});

	it('прошлый день — его начало по Москве, а не выдуманный час', () => {
		expect(markMomentFromDay('2026-09-12', NOW).toISOString()).toBe('2026-09-11T21:00:00.000Z');
	});

	it('на несуществующем дне отказывает, а не сползает на соседний', () => {
		expect(() => markMomentFromDay('2026-13-40', NOW)).toThrow(RangeError);
	});
});
