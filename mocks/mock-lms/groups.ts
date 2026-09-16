/**
 * Учебные группы имитатора: устойчивый идентификатор и привязка к курсу.
 *
 * Идентификатор выводится из ключа заявки, а не из счётчика: контракт требует
 * от LMS вернуть на повторную заявку **ту же** группу
 * (`docs/exchange-contract.md`, раздел 5), и после перезапуска имитатора ответ
 * обязан остаться прежним — иначе стенд показывал бы дубль там, где его нет.
 */
import { MOCK_COURSES, type MockCourse } from './moodle-data.ts';

/** Номера групп стенда — четырёхзначные, как у настоящей площадки. */
const FIRST_GROUP_NUMBER = 2000;
const GROUP_NUMBER_RANGE = 8000;

function fromKey(key: string): number {
	let hash = 2166136261;

	for (let index = 0; index < key.length; index += 1) {
		hash ^= key.charCodeAt(index);
		hash = Math.imul(hash, 16777619) >>> 0;
	}

	return hash;
}

/**
 * Идентификатор группы по ключу заявки CRM. При совпадении номеров у двух
 * разных заявок берётся следующий свободный: два запроса — две группы, и
 * склеивать их по совпадению хеша нельзя.
 */
export function stableGroupId(requestExternalId: string, taken: (id: string) => boolean): string {
	const start = fromKey(requestExternalId) % GROUP_NUMBER_RANGE;

	for (let offset = 0; offset < GROUP_NUMBER_RANGE; offset += 1) {
		const id = String(FIRST_GROUP_NUMBER + ((start + offset) % GROUP_NUMBER_RANGE));

		if (!taken(id)) {
			return id;
		}
	}

	throw new Error('Свободных номеров групп не осталось');
}

/**
 * Курс под программу заявки. Код программы не найден — первый курс: имитатор
 * заводит группу и с незнакомым кодом, а расхождение видно в журнале.
 */
export function courseForProgram(code: string | null): MockCourse {
	return MOCK_COURSES.find((course) => course.idnumber === code) ?? MOCK_COURSES[0];
}
