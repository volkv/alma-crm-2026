/**
 * Сопоставление колонок файла с полями строки.
 *
 * Выгрузки приходят из разных систем, и одна и та же величина называется в них
 * по-разному: «Подано заявок», «Заявки», «applications». Правила ниже — это
 * словарь синонимов: он **предлагает**, а решает человек. Предложение, которое
 * нельзя отменить в интерфейсе, было бы хуже отсутствия предложения — ошибку
 * такого сопоставления потом не найти.
 */
import { STAT_FIELDS, type StatField, type StatMapping } from '$lib/contracts/stats';

/**
 * Синонимы названий колонок. Однобуквенных и слишком общих слов здесь нет
 * намеренно: подстрока «с» нашлась бы в каждом заголовке.
 */
const SYNONYMS: Record<StatField, readonly string[]> = {
	organization: [
		'организация',
		'наименование организации',
		'вуз',
		'университет',
		'учебное заведение',
		'образовательная организация',
		'инн',
		'инн организации',
		'organization',
		'university',
		'institution'
	],
	site: ['площадка', 'филиал', 'кампус', 'подразделение', 'site', 'campus', 'branch'],
	program: [
		'программа',
		'образовательная программа',
		'код программы',
		'название программы',
		'направление подготовки',
		'program',
		'programme',
		'course'
	],
	periodStart: [
		'начало периода',
		'дата начала',
		'период с',
		'начало обучения',
		'period start',
		'start date',
		'date from'
	],
	periodEnd: [
		'конец периода',
		'окончание периода',
		'дата окончания',
		'период по',
		'окончание обучения',
		'period end',
		'end date',
		'date to'
	],
	applications: [
		'заявки',
		'подано заявок',
		'подано',
		'количество заявок',
		'число заявок',
		'заявлений',
		'applications',
		'applied',
		'requests'
	],
	enrolled: [
		'зачислено',
		'обучающихся',
		'обучается',
		'студентов',
		'слушателей',
		'принято на обучение',
		'enrolled',
		'students',
		'enrollment'
	],
	parallelStreams: [
		'потоки',
		'параллельные потоки',
		'число потоков',
		'количество потоков',
		'групп',
		'parallel streams',
		'streams',
		'groups'
	],
	completed: [
		'завершили обучение',
		'завершили',
		'окончили',
		'выпущено',
		'выпуск',
		'completed',
		'graduated'
	],
	coveragePlan: ['охват план', 'план охвата', 'плановый охват', 'план', 'coverage plan', 'planned'],
	coverageFact: [
		'охват факт',
		'факт охвата',
		'фактический охват',
		'факт',
		'coverage fact',
		'actual'
	]
};

/**
 * Название колонки в сравнимом виде: регистр, «ё», знаки препинания и лишние
 * пробелы к делу не относятся — «Охват, план» и «охват план» это одна колонка.
 */
export function normalizeHeader(header: string): string {
	return header
		.toLocaleLowerCase('ru')
		.replaceAll('ё', 'е')
		.replaceAll(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

/** Совпадение колонки с полем и то, насколько оно уверенное. */
type Match = {
	column: string;
	field: StatField;
	/** Точное совпадение сильнее вхождения, длинный синоним — сильнее короткого. */
	score: number;
	exact: boolean;
	synonym: string;
};

function matchesFor(column: string): Match[] {
	const normalized = normalizeHeader(column);
	const matches: Match[] = [];

	if (normalized === '') {
		return matches;
	}

	for (const field of STAT_FIELDS) {
		let best: Match | null = null;

		for (const synonym of SYNONYMS[field]) {
			const exact = normalized === synonym;
			const hit = exact || normalized.includes(synonym);

			if (!hit) {
				continue;
			}

			const score = (exact ? 1000 : 0) + synonym.length;

			if (best === null || score > best.score) {
				best = { column, field, score, exact, synonym };
			}
		}

		if (best !== null) {
			matches.push(best);
		}
	}

	return matches;
}

/**
 * Предложенное сопоставление: колонка → поле.
 *
 * Одно поле достаётся одной колонке: в выгрузке рядом стоят «Охват, план» и
 * «Охват, факт», и если бы поле могло достаться обеим, предложение зависело бы
 * от порядка колонок. Поэтому совпадения разбираются от самого уверенного к
 * самому слабому, и занятые колонка и поле больше не участвуют.
 */
export function suggestMapping(headers: readonly string[]): StatMapping {
	const matches = headers
		.flatMap((header) => matchesFor(header))
		// Порядок колонок в файле — последний ключ: без него два одинаково
		// уверенных совпадения менялись бы местами от запуска к запуску.
		.sort(
			(left, right) =>
				right.score - left.score || headers.indexOf(left.column) - headers.indexOf(right.column)
		);

	const mapping: StatMapping = {};
	const takenFields = new Set<StatField>();

	for (const match of matches) {
		if (takenFields.has(match.field) || match.column in mapping) {
			continue;
		}

		mapping[match.column] = match.field;
		takenFields.add(match.field);
	}

	return mapping;
}

/** Насколько уверенно колонка сопоставлена: показывается рядом с предложением. */
export function mappingConfidence(column: string, field: StatField): number {
	const match = matchesFor(column).find((candidate) => candidate.field === field);

	if (match === undefined) {
		return 0;
	}

	return match.exact ? 1 : 0.6;
}
