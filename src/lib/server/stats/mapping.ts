/**
 * Словарь синонимов колонок для данных об обучении.
 *
 * Выгрузки приходят из разных систем, и одна и та же величина называется в них
 * по-разному: «Подано заявок», «Заявки», «applications». Здесь лежит только
 * словарь; правило выбора — общее для всех импортов и живёт в
 * `spreadsheet/mapping.ts`.
 */
import { STAT_FIELDS, type StatField, type StatMapping } from '$lib/contracts/stats';
import {
	fieldMappingConfidence,
	suggestFieldMapping,
	type FieldSynonyms
} from '../spreadsheet/mapping';

/**
 * Синонимы названий колонок. Однобуквенных и слишком общих слов здесь нет
 * намеренно: подстрока «с» нашлась бы в каждом заголовке.
 */
const SYNONYMS: FieldSynonyms<StatField> = {
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
 * Предложенное сопоставление: колонка → поле. Правило выбора общее для всех
 * импортов, здесь к нему подставляется словарь данных об обучении.
 */
export function suggestMapping(headers: readonly string[]): StatMapping {
	return suggestFieldMapping(headers, STAT_FIELDS, SYNONYMS);
}

/** Насколько уверенно колонка сопоставлена: показывается рядом с предложением. */
export function mappingConfidence(column: string, field: StatField): number {
	return fieldMappingConfidence(column, field, STAT_FIELDS, SYNONYMS);
}
