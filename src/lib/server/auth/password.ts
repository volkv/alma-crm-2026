/**
 * Пароли: хеширование, проверка и политика.
 *
 * Argon2id с параметрами по умолчанию `@node-rs/argon2` — 19 МиБ памяти, два
 * прохода, один поток. Память здесь важнее числа проходов: именно она делает
 * перебор на видеокартах дорогим. Параметры записаны в самой строке хеша, так
 * что их повышение не ломает уже сохранённые пароли.
 */
import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { PASSWORD_MAX_LENGTH } from '$lib/contracts/auth';
import type { SettingValue } from '$lib/contracts/settings';
import { pluralize } from '$lib/format';

export type PasswordPolicy = SettingValue<'password_policy'>;

export async function hashPassword(password: string): Promise<string> {
	return hash(password);
}

/**
 * Хеш пароля, которого ни у кого нет.
 *
 * Проверка несуществующего пользователя обязана стоить столько же, сколько
 * проверка существующего: иначе по времени ответа перебором узнают, какие
 * адреса заведены в системе.
 */
let dummyHash: Promise<string> | undefined;

export async function verifyPassword(hashed: string | null, password: string): Promise<boolean> {
	if (hashed === null) {
		dummyHash ??= hashPassword(randomBytes(32).toString('base64url'));
		await verify(await dummyHash, password);
		return false;
	}

	return verify(hashed, password);
}

/** Классы символов, из которых политика требует набрать хотя бы несколько. */
const CHARACTER_CLASSES = [/\p{Ll}/u, /\p{Lu}/u, /\p{Nd}/u, /[^\p{Ll}\p{Lu}\p{Nd}]/u];

/**
 * Претензии к паролю по текущей политике; пустой список — пароль годится.
 * Функция чистая: политику читает и ошибку бросает тот, кто её вызвал.
 */
export function validatePassword(policy: PasswordPolicy, password: string): string[] {
	const issues: string[] = [];

	if (password.length < policy.minLength) {
		issues.push(
			`Пароль не короче ${pluralize(policy.minLength, ['символа', 'символов', 'символов'])}`
		);
	}

	if (password.length > PASSWORD_MAX_LENGTH) {
		issues.push(
			`Пароль не длиннее ${pluralize(PASSWORD_MAX_LENGTH, ['символа', 'символов', 'символов'])}`
		);
	}

	const used = CHARACTER_CLASSES.filter((pattern) => pattern.test(password)).length;

	if (used < policy.minClasses) {
		issues.push(
			`Используйте символы хотя бы ${pluralize(policy.minClasses, ['вида', 'видов', 'видов'])} из четырёх: строчные буквы, прописные буквы, цифры, знаки`
		);
	}

	return issues;
}
