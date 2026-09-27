/**
 * Серверная часть «Договоров и лицензий» в карточке: выбор договора записи и
 * его позиций. Правка идёт той же командой ядра, что и правка плана, — права,
 * область и проверку версии держит она.
 */
import { updateInteractionSchema } from '$lib/contracts/interactions';
import { defineCardServer, NO_OPTION } from '$lib/platform/card.server';
import {
	actorFromEvent,
	getInteraction,
	parse,
	run,
	text,
	updateInteraction
} from '$lib/platform/core.server';
import contracts from './index';

export default defineCardServer(contracts, {
	actions: {
		/**
		 * Договор записи и выбранные из него позиции.
		 *
		 * Своё действие, а не поле формы плана: договор принадлежит контрагенту, и
		 * сменить его — это сказать, что работа идёт по другому обязательству.
		 * Остальной план едет как есть, ровно как стороны и продукты в правке плана.
		 */
		contract: async (event) => {
			const ctx = actorFromEvent(event);
			const data = await event.request.formData();
			const current = await getInteraction(ctx, event.params.id);
			const chosen = text(data, 'contractId');
			// «Без договора» список выбирает своим значением: пустое значение
			// всплывающий список не хранит, и отличить «не выбрано» от «не прислано»
			// по пустой строке было бы нельзя.
			const contractId = chosen === null || chosen === NO_OPTION ? null : chosen;

			const parsed = parse(updateInteractionSchema, {
				id: current.id,
				editVersion: Number(data.get('editVersion')),
				title: current.title,
				agreementPeriodStart: current.agreementPeriodStart,
				agreementPeriodEnd: current.agreementPeriodEnd,
				academicPeriodStart: current.academicPeriodStart,
				academicPeriodEnd: current.academicPeriodEnd,
				ownerUserId: current.ownerUserId,
				reason: text(data, 'reason'),
				externalSource: current.externalSource,
				externalId: current.externalId,
				parties: current.parties.map((party) => ({
					organizationId: party.organizationId,
					partyRole: party.partyRole,
					isPrimary: party.isPrimary,
					contactAffiliationId: party.contactAffiliationId,
					siteIds: party.sites.map((site) => site.id)
				})),
				programs: current.programs.map((program) => ({
					programId: program.programId,
					programVersionId: program.programVersionId
				})),
				productIds: current.products.map((product) => product.productId),
				contractId,
				contractItemIds: contractId === null ? [] : data.getAll('contractItemIds')
			});

			if (!parsed.ok) return parsed.failure;

			return run(() => updateInteraction(ctx, parsed.data));
		}
	},
	files: {},
	load: null
});
