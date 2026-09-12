/**
 * Словарь синонимов: что предлагается по названиям колонок.
 *
 * Проверяется именно предложение, а не сопоставление: применяет его человек, и
 * ошибка словаря — это лишний клик, а не испорченные данные. Но если словарь
 * молча перестанет узнавать «Подано заявок», импорт превратится в ручную
 * разметку одиннадцати колонок на каждую выгрузку.
 */
import { describe, expect, it } from 'vitest';
import { STAT_FIELDS } from '$lib/contracts/stats';
import { mappingConfidence, normalizeHeader, suggestMapping } from '$lib/server/stats/mapping';

/** Шапка, похожая на настоящую выгрузку вуза. */
const RUSSIAN_HEADERS = [
	'Вуз',
	'Код программы',
	'Подано заявок',
	'Зачислено',
	'Параллельные потоки',
	'Завершили обучение',
	'Охват, план',
	'Охват, факт',
	'Комментарий куратора'
];

describe('предложенное сопоставление', () => {
	it('узнаёт русские названия колонок', () => {
		const mapping = suggestMapping(RUSSIAN_HEADERS);

		expect(mapping).toMatchObject({
			Вуз: 'organization',
			'Код программы': 'program',
			'Подано заявок': 'applications',
			Зачислено: 'enrolled',
			'Параллельные потоки': 'parallelStreams',
			'Завершили обучение': 'completed',
			'Охват, план': 'coveragePlan',
			'Охват, факт': 'coverageFact'
		});
	});

	it('находит по синонимам не меньше четырёх полей', () => {
		// Нижняя граница проверки приёмки: словарь обязан снимать с человека
		// основную часть разметки, а не одну колонку из десяти.
		const mapping = suggestMapping(RUSSIAN_HEADERS);

		expect(Object.keys(mapping).length).toBeGreaterThanOrEqual(4);
	});

	it('узнаёт английские названия', () => {
		const mapping = suggestMapping([
			'University',
			'Program',
			'Applications',
			'Enrolled',
			'Parallel streams'
		]);

		expect(mapping).toStrictEqual({
			University: 'organization',
			Program: 'program',
			Applications: 'applications',
			Enrolled: 'enrolled',
			'Parallel streams': 'parallelStreams'
		});
	});

	it('узнаёт организацию по колонке с ИНН', () => {
		expect(suggestMapping(['ИНН организации', 'Программа'])).toStrictEqual({
			'ИНН организации': 'organization',
			Программа: 'program'
		});
	});

	it('не отдаёт одно поле двум колонкам', () => {
		const mapping = suggestMapping(RUSSIAN_HEADERS);
		const fields = Object.values(mapping);

		expect(new Set(fields).size).toBe(fields.length);
	});

	it('оставляет непонятную колонку несопоставленной', () => {
		const mapping = suggestMapping(RUSSIAN_HEADERS);

		expect(mapping['Комментарий куратора']).toBeUndefined();
	});

	it('предлагает только поля из контракта', () => {
		const mapping = suggestMapping(RUSSIAN_HEADERS);

		for (const field of Object.values(mapping)) {
			expect(STAT_FIELDS).toContain(field);
		}
	});

	it('не зависит от регистра, «ё» и знаков препинания', () => {
		expect(normalizeHeader('  Охват, ПЛАН ')).toBe('охват план');
		expect(suggestMapping(['ЗАЧИСЛЕНО'])).toStrictEqual({ ЗАЧИСЛЕНО: 'enrolled' });
	});

	it('различает точное совпадение и вхождение', () => {
		expect(mappingConfidence('Зачислено', 'enrolled')).toBe(1);
		expect(mappingConfidence('Зачислено на программу', 'enrolled')).toBeLessThan(1);
		expect(mappingConfidence('Комментарий куратора', 'enrolled')).toBe(0);
	});
});
