/**
 * Идентификаторы сидируемых записей.
 *
 * Они обязаны быть одинаковыми при каждом запуске: только так повторный сид
 * узнаёт свои строки и не плодит дубли, а ссылки между наборами (роль человека
 * → организация, версия программы → пользователь) можно расставить, ничего не
 * вычитывая обратно из базы.
 *
 * Способ — UUID версии 5: SHA-1 от пространства имён и ключа. Пространство
 * имён ниже — константа этого проекта; смена константы означает новый набор
 * идентификаторов, то есть новые строки рядом со старыми, а не их обновление.
 */
import { createHash } from 'node:crypto';

/** Пространство имён сидов. Менять нельзя — см. комментарий выше. */
const NAMESPACE = '6f2c2b8e-7a1d-4c8f-9a3e-2b5d41c0e7a9';

const namespaceBytes = Buffer.from(NAMESPACE.replaceAll('-', ''), 'hex');

/** Наборы сидов; ключ уникален внутри набора, а не по всей базе. */
export type SeedKind =
	| 'user'
	| 'organization'
	| 'site'
	| 'person'
	| 'consent'
	| 'affiliation'
	| 'program'
	| 'program-version'
	| 'product'
	| 'interaction';

/**
 * Идентификатор записи набора. Реализация UUID v5 по RFC 9562: биты версии и
 * варианта проставляются вручную, потому что в стандартной библиотеке Node
 * есть только `randomUUID` (версия 4).
 */
export function seedId(kind: SeedKind, key: string): string {
	const digest = createHash('sha1')
		.update(namespaceBytes)
		.update(Buffer.from(`${kind}:${key}`, 'utf8'))
		.digest();

	digest[6] = (digest[6] & 0x0f) | 0x50;
	digest[8] = (digest[8] & 0x3f) | 0x80;

	const hex = digest.subarray(0, 16).toString('hex');

	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
