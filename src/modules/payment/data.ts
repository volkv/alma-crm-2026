/**
 * Данные «Оплаты» для карточки: то, что `load` в `card.server.ts` кладёт в
 * `data.moduleData.payment`. Тип отдельно от серверной части, чтобы панель
 * брала его, не касаясь серверного файла.
 */
import type { InteractionTermsView } from '$lib/contracts/terms';

export type PaymentCardData = {
	/** Коммерческие условия дела: стоимость и версия для правки. */
	terms: InteractionTermsView;
};
