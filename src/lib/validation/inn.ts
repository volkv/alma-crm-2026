/**
 * ИНН — налоговый номер, который приходит вместе с реквизитами организации и
 * служит ключом при сверке с внешними справочниками. Опечатку в нём ловит
 * контрольная сумма ФНС, поэтому проверяем её, а не только длину.
 *
 * Модуль намеренно свободен от Zod и от серверного кода: одна и та же функция
 * работает в схемах контрактов, в формах браузера и в импорте данных.
 */

/** Весовые коэффициенты ФНС для десятой цифры десятизначного ИНН. */
const LEGAL_ENTITY_WEIGHTS = [2, 4, 10, 3, 5, 9, 4, 6, 8] as const;
/** Весовые коэффициенты для одиннадцатой цифры двенадцатизначного ИНН. */
const PERSON_WEIGHTS_11 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8] as const;
/** Весовые коэффициенты для двенадцатой цифры двенадцатизначного ИНН. */
const PERSON_WEIGHTS_12 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8] as const;

function checksum(digits: readonly number[], weights: readonly number[]): number {
	let sum = 0;
	for (let i = 0; i < weights.length; i += 1) {
		sum += digits[i] * weights[i];
	}
	return (sum % 11) % 10;
}

/**
 * `true`, если строка — корректный ИНН юридического лица (10 цифр) или
 * физического лица либо ИП (12 цифр). Пробелы по краям не допускаются:
 * очистку делает схема, которая эту функцию вызывает.
 */
export function isValidInn(value: string): boolean {
	if (!/^\d{10}$|^\d{12}$/.test(value)) {
		return false;
	}

	const digits = [...value].map(Number);

	if (digits.length === 10) {
		return checksum(digits, LEGAL_ENTITY_WEIGHTS) === digits[9];
	}

	return (
		checksum(digits, PERSON_WEIGHTS_11) === digits[10] &&
		checksum(digits, PERSON_WEIGHTS_12) === digits[11]
	);
}
