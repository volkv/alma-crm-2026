/**
 * «Оплата»: отметка «Оплата получена» и факт оплаты с сайта. Обучение
 * физического лица держится на ней, поэтому у лица шапка карточки называет
 * оплату, а не договор.
 */
import type { PAYMENT_CHECKLIST_KEY } from '$lib/contracts/payments';
import { defineModule } from '$lib/platform/define';

/**
 * Пункт чек-листа «Оплата получена». Значение — строкой: манифест читает сид
 * обычным процессом Node, поэтому из контрактов сюда идут только типы, а
 * совпадение с ключом ядра проверяет компилятор.
 */
const PAYMENT_ITEM: typeof PAYMENT_CHECKLIST_KEY = 'payment_received';

export default defineModule({
	key: 'payment',
	label: 'Оплата',
	description: 'Стоимость и отметка об оплате в карточке, факт оплаты с сайта в шапке у лица',
	panels: [
		{
			key: 'payment',
			label: 'Стоимость и оплата',
			hint: 'Отметка «Оплата получена» из чек-листа процесса; стоимость в записи не хранится',
			order: 30
		}
	],
	headerFacts: [{ key: 'payment', label: 'Оплата', shapes: ['person'] }],
	cardActions: [],
	sections: [],
	documents: { templates: [], kinds: [] },
	// Стадию с пунктом «Оплата получена» без модуля не пройти: отметку ставят в
	// его панели, и факт оплаты с сайта называет его шапка.
	requiredByStage: (stage) => stage.checklist.some((item) => item.key === PAYMENT_ITEM)
});
