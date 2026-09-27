/**
 * Серверная часть «Оплаты» в карточке: стоимость дела — прочитать для панели и
 * шапки и назвать заново. Права, область доступа и версию условий проверяет
 * сервис; что модуль действует в пространстве дела, — реестр до вызова.
 */
import { setInteractionTermsSchema } from '$lib/contracts/terms';
import { defineCardServer } from '$lib/platform/card.server';
import { actorFromEvent, parse, run, text } from '$lib/platform/core.server';
import type { PaymentCardData } from './data';
import payment from './index';
import { readInteractionTerms, setInteractionTerms } from './server/terms';

export default defineCardServer(payment, {
	actions: {
		/** Стоимость дела; пустое поле снимает её. */
		setPrice: async (event) => {
			const data = await event.request.formData();
			const parsed = parse(setInteractionTermsSchema, {
				interactionId: event.params.id,
				version: data.get('version'),
				price: text(data, 'price')
			});

			if (!parsed.ok) return parsed.failure;

			return run(() => setInteractionTerms(actorFromEvent(event), parsed.data));
		}
	},
	files: {},
	load: async ({ ctx, interaction }): Promise<PaymentCardData> => ({
		terms: await readInteractionTerms(ctx, interaction.id)
	})
});
