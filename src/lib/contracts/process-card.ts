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
import { PANEL_CATALOG, PANEL_KEYS, type PanelKey } from '$lib/platform/registry';
import { DOCUMENT_TEMPLATE_KEYS, type DocumentTemplateKey } from './documents';

/**
 * Каталог панелей — панели ядра и всех установленных модулей
 * (`$lib/platform/registry`). Порядок здесь — порядок на экране: сначала сроки
 * и коммерческие условия, потом обучение, в конце документы. Своих литералов у
 * состава карточки больше нет: ключи панелей объявляют манифесты модулей, и
 * модуль, добавленный в `crm.config.ts`, попадает в каталог без правки ядра.
 */
export const CARD_PANELS = PANEL_KEYS;

export type CardPanel = PanelKey;

export const CARD_PANEL_LABELS = Object.fromEntries(
	PANEL_CATALOG.map((panel) => [panel.key, panel.label])
) as Record<CardPanel, string>;

/** Что панель показывает — подсказка в редакторе процесса. */
export const CARD_PANEL_HINTS = Object.fromEntries(
	PANEL_CATALOG.map((panel) => [panel.key, panel.hint])
) as Record<CardPanel, string>;

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
