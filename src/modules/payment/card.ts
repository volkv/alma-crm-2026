/** Оплата в карточке: панель стоимости и оплаты, стоимость и оплата в шапке. */
import { defineCardUi } from '$lib/platform/card-ui';
import manifest from './index';
import PaymentFact from './ui/payment-fact.svelte';
import PaymentPanel from './ui/payment-panel.svelte';
import PriceFact from './ui/price-fact.svelte';

export default defineCardUi(manifest, {
	panels: { payment: PaymentPanel },
	headerFacts: { price: PriceFact, payment: PaymentFact },
	dialogs: null
});
