/**
 * Догадки о карточке по наименованию и виду деятельности.
 *
 * Ни вида организации, ни уровня образования в ЕГРЮЛ нет: там есть название,
 * организационно-правовая форма и код ОКВЭД. Поэтому два поля карточки —
 * `kind` и `educationLevel` — не читаются, а угадываются, и это честно
 * помечено источником `guess`: сотрудник видит подстановку и правит её одним
 * движением, а не разыскивает, откуда она взялась.
 *
 * Код ОКВЭД главнее названия: «85.22» означает высшее образование по
 * классификатору, а «институт» бывает и у научно-исследовательского института,
 * который никого не учит. Название идёт следом — у многих вузов основной код
 * проставлен как общий «85» или отсутствует вовсе.
 *
 * Модуль свободен от сети и настроек: на вход строки, на выходе значения
 * перечислений справочника.
 */
import type { EducationLevel, OrganizationKind } from '$lib/contracts/directory';

/** Классы ОКВЭД раздела «Образование» (85). */
const OKVED_HIGHER = ['85.22', '85.23']; // высшее образование и аспирантура
const OKVED_VOCATIONAL = ['85.21']; // среднее профессиональное
const OKVED_SCHOOL = ['85.11', '85.12', '85.13', '85.14']; // дошкольное и общее

const HIGHER_WORDS = /универс|академи|высшего образования|высшее образование|\bвуз\b/i;
/** «Институт» отдельно: он же бывает у научных организаций, и один не решает. */
const INSTITUTE_WORD = /институт/i;
const VOCATIONAL_WORDS = /колледж|техникум|училищ/i;
const SCHOOL_WORDS = /школа|школь|лице[йя]|гимнази|общеобразовательн/i;
const EDUCATIONAL_WORDS =
	/образовательн|университ|академи|институт|колледж|техникум|училищ|школ|лице[йя]|гимнази/i;

function okvedStartsWith(okved: string | null, prefixes: readonly string[]): boolean {
	return okved !== null && prefixes.some((prefix) => okved.startsWith(prefix));
}

/**
 * Уровень образования; `null` — по названию и коду не видно, что это учебное
 * заведение, и назначать ему уровень было бы выдумкой.
 */
export function guessEducationLevel(name: string, okved: string | null): EducationLevel | null {
	if (okvedStartsWith(okved, OKVED_HIGHER)) {
		return 'vo';
	}

	if (okvedStartsWith(okved, OKVED_VOCATIONAL)) {
		return 'spo';
	}

	if (okvedStartsWith(okved, OKVED_SCHOOL)) {
		return 'school';
	}

	// Порядок проверок — от частного к общему: «Колледж при университете» учит
	// по программам СПО, и слово «колледж» в нём главное.
	if (VOCATIONAL_WORDS.test(name)) {
		return 'spo';
	}

	if (SCHOOL_WORDS.test(name)) {
		return 'school';
	}

	if (HIGHER_WORDS.test(name) || INSTITUTE_WORD.test(name)) {
		return 'vo';
	}

	return null;
}

/**
 * Вид организации для карточки.
 *
 * Учебным заведением догадка называет запись только вместе с уровнем
 * образования: база уровень у вуза уже не требует, но вид, угаданный без
 * уровня, опирается на одно слово в названии. Всё остальное — юридическое
 * лицо: это самый скромный из возможных ответов, и он же самый безопасный.
 */
export function guessKind(name: string, okved: string | null): OrganizationKind {
	const educational =
		okvedStartsWith(okved, ['85']) || EDUCATIONAL_WORDS.test(name)
			? guessEducationLevel(name, okved)
			: null;

	return educational === null ? 'legal_entity' : 'educational_institution';
}
