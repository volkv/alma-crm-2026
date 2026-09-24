/**
 * Выводы карточки организации, которые считаются из уже загруженного: статус
 * партнёра по договорам и подписи происхождения реквизитов. Отдельно от
 * разметки — чтобы правило читалось одним местом, а не собиралось из условий
 * в шаблоне.
 */
import type { StatusTone } from '$lib/components/status-badge.svelte';
import type { ContractView } from '$lib/contracts/directory';
import type { FieldSource, PassportField } from '$lib/contracts/enrichment';
import { licenseState } from '$lib/contracts/license';
import { formatDate } from '$lib/format';

export const PASSPORT_FIELD_LABELS: Record<PassportField, string> = {
	kind: 'вид',
	educationLevel: 'уровень образования',
	legalName: 'полное наименование',
	shortName: 'краткое наименование',
	inn: 'ИНН',
	kpp: 'КПП',
	ogrn: 'ОГРН',
	region: 'регион',
	website: 'сайт'
};

export const PASSPORT_SOURCE_LABELS: Record<FieldSource, string> = {
	dadata: 'ЕГРЮЛ (Dadata)',
	sveden: 'сайт вуза, раздел «Сведения»',
	guess: 'догадка по выписке'
};

export type PartnerStatus = {
	label: string;
	tone: StatusTone;
	/** Уточнение под бейджем: номер и срок договора, число истекающих лицензий. */
	detail: string | null;
};

/**
 * Статус партнёра — по договорам, а не отдельным полем: партнёр — тот, с кем
 * действует договор. Черновик — переговоры ещё идут; закрытые договоры —
 * партнёрство было и закончилось. Истекающие и истёкшие лицензии называются
 * тут же: это первое, что надо знать о действующем партнёре.
 */
export function partnerStatus(
	contracts: readonly ContractView[],
	today: string,
	licenseWarningDays: number
): PartnerStatus {
	const active = contracts.filter((contract) => contract.status === 'active');

	if (active.length > 0) {
		const expiring = active
			.flatMap((contract) => contract.items)
			.filter((item) => {
				const state = licenseState(item.licenseUntil, today, licenseWarningDays);

				return state === 'expiring' || state === 'expired';
			}).length;
		const [first] = active;
		const term = first.validUntil === null ? '' : ` до ${formatDate(first.validUntil)}`;

		return {
			label: expiring > 0 ? 'Партнёр, лицензии истекают' : 'Партнёр',
			tone: expiring > 0 ? 'warning' : 'success',
			detail:
				active.length > 1
					? `Действующих договоров: ${active.length}`
					: `Договор № ${first.number}${term}`
		};
	}

	if (contracts.some((contract) => contract.status === 'draft')) {
		return { label: 'Договор готовится', tone: 'info', detail: 'Есть черновик договора' };
	}

	if (contracts.length > 0) {
		return { label: 'Бывший партнёр', tone: 'neutral', detail: 'Все договоры закрыты' };
	}

	return { label: 'Договора нет', tone: 'neutral', detail: null };
}
