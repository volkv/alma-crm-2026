import { describe, expect, it } from 'vitest';
import { isValidInn } from '$lib/validation/inn';

describe('isValidInn', () => {
	it('принимает настоящие ИНН юридических лиц', () => {
		expect(isValidInn('7707083893')).toBe(true);
		expect(isValidInn('7736207543')).toBe(true);
	});

	it('принимает настоящий ИНН физического лица', () => {
		expect(isValidInn('500100732259')).toBe(true);
	});

	it('отвергает ИНН с испорченной контрольной цифрой', () => {
		// Те же номера с изменённой последней цифрой: длина верная, сумма — нет.
		expect(isValidInn('7707083894')).toBe(false);
		expect(isValidInn('500100732258')).toBe(false);
		// У двенадцатизначного проверяются обе контрольные цифры.
		expect(isValidInn('500100732269')).toBe(false);
	});

	it('отвергает всё, что не десять и не двенадцать цифр', () => {
		expect(isValidInn('')).toBe(false);
		expect(isValidInn('77070838')).toBe(false);
		expect(isValidInn('77070838931')).toBe(false);
		expect(isValidInn('7707O83893')).toBe(false);
		expect(isValidInn(' 7707083893')).toBe(false);
	});
});
