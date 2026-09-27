/**
 * «Оплата»: отметка «Оплата получена» и факт оплаты с сайта. Обучение
 * физического лица держится на ней, поэтому у лица шапка карточки называет
 * оплату, а не договор.
 */
import { defineModule } from '$lib/platform/define';

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
	requiredByStage: null
});
