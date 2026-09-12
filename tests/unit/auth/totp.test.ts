import { describe, expect, it } from 'vitest';
import { totpCodeSchema } from '$lib/contracts/auth';
import {
	base32Decode,
	base32Encode,
	formatSecretForHuman,
	generateTotpSecret,
	normalizeTotpCode,
	otpauthUri,
	TOTP_DIGITS,
	TOTP_STEP_SECONDS,
	totpCode,
	totpCodeAt,
	totpCounter,
	verifyTotp
} from '$lib/server/auth/totp';

/**
 * Реализация TOTP проверяется векторами из RFC 6238, а не сама собой: это
 * единственный способ узнать, что код, который покажет телефон, и код, который
 * ждёт сервер, — один и тот же. Секрет вектора — строка «12345678901234567890»
 * в ASCII, то есть вот эта запись base32.
 */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

/**
 * Время (секунды) и восьмизначный код из приложения B к RFC 6238, обрезанный до
 * шести цифр — столько их в коде у нас. Обрезка законна: динамическое усечение
 * берёт остаток от деления, поэтому шестизначный код это последние шесть цифр
 * восьмизначного.
 */
const RFC_VECTORS: [seconds: number, code: string][] = [
	[59, '287082'],
	[1111111109, '081804'],
	[1111111111, '050471'],
	[1234567890, '005924'],
	[2000000000, '279037'],
	[20000000000, '353130']
];

describe('TOTP', () => {
	it('повторяет векторы RFC 6238', () => {
		for (const [seconds, code] of RFC_VECTORS) {
			expect(totpCodeAt(RFC_SECRET, seconds * 1000)).toBe(code);
		}
	});

	it('всегда отдаёт ровно шесть цифр, включая ведущие нули', () => {
		const secret = generateTotpSecret();

		for (let counter = 0; counter < 200; counter += 1) {
			expect(totpCode(secret, counter)).toMatch(/^\d{6}$/);
		}

		// Вектор с ведущим нулём: без дополнения он превратился бы в пятизначный.
		expect(totpCodeAt(RFC_SECRET, 1234567890 * 1000)).toBe('005924');
	});

	it('принимает соседний шаг в обе стороны и не принимает следующий за ним', () => {
		const at = 1_700_000_000_000;
		const current = totpCounter(at);
		const step = TOTP_STEP_SECONDS * 1000;

		expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, current), { at })).toBe(current);
		expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, current - 1), { at })).toBe(current - 1);
		expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, current + 1), { at })).toBe(current + 1);

		// Два шага назад — это минута; такой код уже не действует.
		expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, current - 2), { at })).toBeNull();
		expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, current + 2), { at })).toBeNull();

		// Тот же код на следующем шаге отвечает другим номером — по нему
		// вызывающий и отличает повторное предъявление от нового кода.
		expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, current), { at: at + step })).toBe(current);
	});

	it('не принимает мусор вместо кода', () => {
		const at = 1_700_000_000_000;

		expect(verifyTotp(RFC_SECRET, '', { at })).toBeNull();
		expect(verifyTotp(RFC_SECRET, '12345', { at })).toBeNull();
		expect(verifyTotp(RFC_SECRET, '1234567', { at })).toBeNull();
		expect(verifyTotp(RFC_SECRET, 'abcdef', { at })).toBeNull();
	});

	it('терпит пробел между группами, которым код показывает приложение', () => {
		const at = 1_700_000_000_000;
		const code = totpCodeAt(RFC_SECRET, at);
		const grouped = `${code.slice(0, 3)} ${code.slice(3)}`;

		expect(normalizeTotpCode(grouped)).toBe(code);
		expect(verifyTotp(RFC_SECRET, grouped, { at })).toBe(totpCounter(at));
	});

	it('схема кода на форме и длина кода в алгоритме не расходятся', () => {
		const code = totpCodeAt(generateTotpSecret(), Date.now());

		expect(code).toHaveLength(TOTP_DIGITS);
		expect(totpCodeSchema.safeParse({ code }).success).toBe(true);
		expect(totpCodeSchema.safeParse({ code: `${code}7` }).success).toBe(false);
	});
});

describe('base32', () => {
	it('переживает круг «закодировать — разобрать»', () => {
		const bytes = Uint8Array.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);

		expect(Array.from(base32Decode(base32Encode(bytes)))).toEqual(Array.from(bytes));
	});

	it('разбирает секрет, переписанный руками: с пробелами, дефисами и в нижнем регистре', () => {
		const secret = generateTotpSecret();
		const human = formatSecretForHuman(secret).toLowerCase();

		expect(Array.from(base32Decode(human))).toEqual(Array.from(base32Decode(secret)));
	});

	it('не молчит о символе, которого нет в алфавите', () => {
		// «1» и «0» в base32 нет: молча превратить их в другой секрет значит
		// выдать человеку код, который никогда не сойдётся.
		expect(() => base32Decode('ABC10DEF')).toThrow(/base32/);
	});

	it('даёт секрет из 32 символов — столько, сколько ещё переписывают руками', () => {
		expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
	});
});

describe('ссылка otpauth', () => {
	it('называет издателя, учётную запись и параметры алгоритма', () => {
		const uri = otpauthUri({
			issuer: 'LCT CRM localhost:4173',
			account: 'admin@staff.lct-crm.local',
			secret: RFC_SECRET
		});
		const url = new URL(uri);

		expect(url.protocol).toBe('otpauth:');
		expect(decodeURIComponent(url.pathname)).toContain('LCT CRM localhost:4173:');
		expect(decodeURIComponent(url.pathname)).toContain('admin@staff.lct-crm.local');
		expect(url.searchParams.get('secret')).toBe(RFC_SECRET);
		expect(url.searchParams.get('issuer')).toBe('LCT CRM localhost:4173');
		expect(url.searchParams.get('algorithm')).toBe('SHA1');
		expect(url.searchParams.get('digits')).toBe(String(TOTP_DIGITS));
		expect(url.searchParams.get('period')).toBe(String(TOTP_STEP_SECONDS));
	});
});
