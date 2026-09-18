import { describe, expect, it } from 'vitest';
import { demoPasswordHint } from '$lib/server/auth/demo-password';

/**
 * Пароль демонстрационных записей на странице входа. Показывать его разрешено
 * ровно на публичном стенде и ровно тогда, когда развёртывание назвало его
 * переменной окружения: приложение своих паролей не знает и выдумать эту строку
 * не может.
 */
describe('подсказка пароля демонстрационного стенда', () => {
	it('показывается на стенде, когда переменная задана', () => {
		expect(demoPasswordHint('lct-demo-2026', true)).toBe('lct-demo-2026');
	});

	it('вне демонстрационного режима не показывается, чем бы ни была задана', () => {
		expect(demoPasswordHint('lct-demo-2026', false)).toBeNull();
	});

	it('без переменной подсказки нет', () => {
		expect(demoPasswordHint(undefined, true)).toBeNull();
		// Пустая строка равна «не задано»: Compose подставляет её там, где
		// переменной нет в `.env`.
		expect(demoPasswordHint('', true)).toBeNull();
	});

	it('испорченное значение не превращается в пустую строку на экране', () => {
		expect(() => demoPasswordHint('   ', true)).toThrow(/DEMO_PASSWORD_HINT/);
		expect(() => demoPasswordHint('x'.repeat(129), true)).toThrow(/DEMO_PASSWORD_HINT/);
	});
});
