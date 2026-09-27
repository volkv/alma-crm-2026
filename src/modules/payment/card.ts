/** Оплата в карточке: панель стоимости и оплаты и факт в шапке у лица. */
import { defineCardUi } from '$lib/platform/card-ui';
import manifest from './index';
import PaymentFact from './ui/payment-fact.svelte';
import PaymentPanel from './ui/payment-panel.svelte';

export default defineCardUi(manifest, {
	panels: { payment: PaymentPanel },
	headerFacts: { payment: PaymentFact },
	dialogs: null
});
