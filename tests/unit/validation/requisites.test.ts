import { describe, expect, it } from 'vitest';
import { isValidKpp, isValidOgrn } from '$lib/validation/requisites';

describe('isValidKpp', () => {
	it('принимает цифровой и буквенный код причины', () => {
		expect(isValidKpp('780201001')).toBe(true);
		expect(isValidKpp('7802AB001')).toBe(true);
	});

	it('отвергает короткий номер и строчные буквы', () => {
		expect(isValidKpp('12')).toBe(false);
		expect(isValidKpp('7802ab001')).toBe(false);
		expect(isValidKpp('78020100')).toBe(false);
	});
});

describe('isValidOgrn', () => {
	it('принимает ОГРН и ОГРНИП с верной контрольной цифрой', () => {
		expect(isValidOgrn('1027700132195')).toBe(true);
		expect(isValidOgrn('304500116000157')).toBe(true);
	});

	it('отвергает испорченную контрольную цифру и чужую длину', () => {
		expect(isValidOgrn('1027700132196')).toBe(false);
		expect(isValidOgrn('304500116000158')).toBe(false);
		expect(isValidOgrn('1')).toBe(false);
		expect(isValidOgrn('10277001321950')).toBe(false);
	});
});
