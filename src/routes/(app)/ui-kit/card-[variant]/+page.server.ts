import { error } from '@sveltejs/kit';
import { actorFromEvent } from '$lib/server/actor';
import { getOrganization } from '$lib/server/directory/read';
import { toPageError } from '$lib/server/http';
import { readInteractionExchange } from '$lib/server/integrations/exchange/groups';
import {
	getInteraction,
	listComments,
	listInteractionChanges
} from '$lib/server/interactions/read';
import { getInteractionSummary } from '$lib/server/interactions/summary';
import { getInteractionClosing } from '$lib/server/stages/commands';
import { getInteractionStatus } from '$lib/server/stages/status';
import { seedId } from '../../../../../scripts/seed/ids';
import type { PageServerLoad } from './$types';

/**
 * Макеты карточки взаимодействия на живых записях демонстрационного набора.
 *
 * Данные читаются теми же функциями, что и настоящая карточка, — макет
 * показывает реальные по форме и содержанию записи, а не придуманный слепок.
 * Записи выбраны так, чтобы на них были видны оба процесса и главные
 * состояния: вуз на исполнительской стадии с договором и потоком в системе
 * обучения, та же форма с просрочкой на первой стадии, физическое лицо на
 * обучении и юридическое лицо на договоре и оплате.
 */
const SAMPLES = {
	b2b: { key: 'ukct-zanyatiya', label: 'Вуз: идут занятия' },
	b2c: { key: 'sorokin-obuchenie', label: 'Физлицо: обучение' },
	'b2b-overdue': { key: 'szpu-vo', label: 'Вуз: просрочка' },
	'b2c-company': { key: 'mayak-dogovor', label: 'Юрлицо: договор и оплата' }
} as const;

type SampleKey = keyof typeof SAMPLES;

const VARIANTS = ['a', 'b'] as const;

type Variant = (typeof VARIANTS)[number];

const isSample = (value: string): value is SampleKey => value in SAMPLES;
const isVariant = (value: string): value is Variant =>
	(VARIANTS as readonly string[]).includes(value);

export const load: PageServerLoad = async (event) => {
	const { variant } = event.params;

	if (!isVariant(variant)) {
		error(404, 'Такого варианта карточки нет');
	}

	// Образец — выбор глазами, он живёт в адресе; непонятное значение — это
	// образец по умолчанию, а не ошибка.
	const asked = event.url.searchParams.get('sample') ?? '';
	const sample: SampleKey = isSample(asked) ? asked : 'b2b';
	const id = seedId('interaction', SAMPLES[sample].key);
	const ctx = actorFromEvent(event);

	try {
		const [interaction, status, summary, closing, comments, changes, exchange] = await Promise.all([
			getInteraction(ctx, id),
			getInteractionStatus(ctx, id),
			getInteractionSummary(ctx, id),
			getInteractionClosing(ctx, id),
			listComments(ctx, id),
			listInteractionChanges(ctx, id),
			readInteractionExchange(ctx, id)
		]);

		const primary = interaction.parties.find((party) => party.isPrimary);
		const counterparty =
			primary === undefined ? null : await getOrganization(ctx, primary.organizationId);

		return {
			variant,
			sample,
			samples: Object.entries(SAMPLES).map(([key, value]) => ({ key, label: value.label })),
			source: {
				interaction,
				status,
				summary,
				closing,
				comments,
				changes,
				counterparty,
				exchange: { groups: exchange.groups, issue: exchange.issue }
			}
		};
	} catch (cause) {
		toPageError(cause);
	}
};
