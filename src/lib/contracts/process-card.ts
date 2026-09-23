/**
 * Карточка взаимодействия как часть процесса: какие панели в ней стоят и какие
 * документы в ней собираются по шаблону.
 *
 * Состав карточки объявляет процесс, а не код: работа с вузом держится на
 * договоре с позициями и лицензиями, обучение лица — на оплате, слушателях и
 * документе об обучении. Новое пространство собирается администратором из того
 * же каталога без выпуска.
 *
 * Сторона взаимодействия (кто контрагент и на каких условиях) в каталог не
 * входит: без неё карточки нет вовсе, и её вид задаёт не процесс, а вид
 * контрагента — вуз, физическое лицо, юридическое лицо.
 */
import { z } from 'zod';
import { DOCUMENT_TEMPLATE_KEYS, type DocumentTemplateKey } from './documents';

/**
 * Каталог панелей. Порядок здесь — порядок на экране: сначала сроки и
 * коммерческие условия, потом обучение, в конце документы.
 */
export const CARD_PANELS = [
	'terms',
	'contract',
	'payment',
	'learners',
	'learning',
	'training_document',
	'documents'
] as const;

export type CardPanel = (typeof CARD_PANELS)[number];

export const CARD_PANEL_LABELS: Record<CardPanel, string> = {
	terms: 'Сроки',
	contract: 'Договор с позициями и лицензиями',
	payment: 'Стоимость и оплата',
	learners: 'Слушатели',
	learning: 'Группа в системе обучения',
	training_document: 'Документ об обучении',
	documents: 'Документы'
};

/** Что панель показывает — подсказка в редакторе процесса. */
export const CARD_PANEL_HINTS: Record<CardPanel, string> = {
	terms: 'У вуза — срок соглашения и учебный год, у лица — период обучения',
	contract: 'Договор контрагента, выбранные позиции, лицензии и их передача',
	payment: 'Отметка «Оплата получена» из чек-листа процесса; стоимость в записи не хранится',
	learners: 'Сколько слушателей заявлено, зачислено, окончило и отчислено — по данным потоков',
	learning: 'Потоки в системе обучения и заявка на новый',
	training_document: 'Документы вида «Документ об обучении», приложенные к делу',
	documents: 'Все документы дела, загрузка и сборка по шаблону'
};

/** Набор панелей и шаблонов процесса — то, что читает карточка. */
export type ProcessCard = {
	panels: CardPanel[];
	templates: DocumentTemplateKey[];
};

/** Выбор без повторов, в порядке каталога: порядок задаёт каталог, а не форма. */
function inCatalogOrder<T extends string>(catalog: readonly T[]) {
	return (chosen: T[]): T[] => catalog.filter((item) => chosen.includes(item));
}

/**
 * Форма редактора: отмеченные панели и шаблоны. Пустой набор законен —
 * карточка процесса без панелей показывает сторону и ленту.
 */
export const processCardSchema = z.object({
	panels: z
		.array(z.enum(CARD_PANELS, { error: 'Такой панели карточки нет' }))
		.default([])
		.transform(inCatalogOrder(CARD_PANELS)),
	templates: z
		.array(z.enum(DOCUMENT_TEMPLATE_KEYS, { error: 'Такого шаблона документа нет' }))
		.default([])
		.transform(inCatalogOrder(DOCUMENT_TEMPLATE_KEYS))
});
