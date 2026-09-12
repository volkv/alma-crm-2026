/**
 * Как справочники называются по-русски и каким цветом показывают состояние.
 *
 * Перечисления живут в контрактах кодами (`educational_institution`), а человек
 * читает слова. Словари здесь один раз: иначе «СПО» в списке и «Среднее
 * профессиональное» в карточке расходятся, и это замечают на демонстрации.
 */
import type { FieldOption } from '$lib/components/form/field-select.svelte';
import type { StatusTone } from '$lib/components/status-badge.svelte';
import {
	AFFILIATION_ROLE_KINDS,
	EDUCATION_LEVELS,
	LIFECYCLE_STATUSES,
	ORGANIZATION_KINDS,
	PROGRAM_LEVELS,
	SITE_KINDS,
	type AffiliationRoleKind,
	type ConsentBasis,
	type EducationLevel,
	type LifecycleStatus,
	type OrganizationKind,
	type ProgramLevel,
	type SiteKind
} from '$lib/contracts/directory';

export const ORGANIZATION_KIND_LABELS: Record<OrganizationKind, string> = {
	educational_institution: 'Учебное заведение',
	customer_company: 'Компания-заказчик',
	operator: 'Оператор'
};

export const ORGANIZATION_KIND_TONES: Record<OrganizationKind, StatusTone> = {
	educational_institution: 'accent',
	customer_company: 'info',
	operator: 'neutral'
};

export const EDUCATION_LEVEL_LABELS: Record<EducationLevel, string> = {
	vo: 'Высшее образование',
	spo: 'Среднее профессиональное',
	school: 'Школа'
};

export const SITE_KIND_LABELS: Record<SiteKind, string> = {
	campus: 'Кампус',
	branch: 'Филиал',
	department: 'Подразделение',
	other: 'Другое'
};

export const AFFILIATION_ROLE_LABELS: Record<AffiliationRoleKind, string> = {
	rector: 'Ректор',
	vice_rector: 'Проректор',
	dean: 'Декан',
	head_of_department: 'Заведующий кафедрой',
	teacher: 'Преподаватель',
	coordinator: 'Координатор',
	other: 'Другое'
};

export const PROGRAM_LEVEL_LABELS: Record<ProgramLevel, string> = {
	bachelor: 'Бакалавриат',
	master: 'Магистратура',
	specialist: 'Специалитет',
	spo: 'СПО',
	school: 'Школа',
	dpo: 'ДПО'
};

export const LIFECYCLE_STATUS_LABELS: Record<LifecycleStatus, string> = {
	draft: 'Черновик',
	active: 'Действует',
	archived: 'В архиве'
};

/** Черновик ещё не предлагают, действующая программа в работе, архив — история. */
export const LIFECYCLE_STATUS_TONES: Record<LifecycleStatus, StatusTone> = {
	draft: 'warning',
	active: 'success',
	archived: 'neutral'
};

/**
 * Основание обработки персональных данных. Название длиннее кода намеренно:
 * человек в карточке читает не `legal`, а норму, по которой данные лежат.
 */
export const CONSENT_BASIS_LABELS: Record<ConsentBasis, string> = {
	consent: 'Согласие субъекта',
	contract: 'Исполнение договора',
	legal: 'Требование закона'
};

/** Значение, которым список обозначает «ничего не выбрано». */
export const NO_OPTION = 'none';

function toOptions<TKey extends string>(
	keys: readonly TKey[],
	labels: Record<TKey, string>
): FieldOption[] {
	return keys.map((key) => ({ value: key, label: labels[key] }));
}

export const ORGANIZATION_KIND_OPTIONS = toOptions(ORGANIZATION_KINDS, ORGANIZATION_KIND_LABELS);
export const EDUCATION_LEVEL_OPTIONS = toOptions(EDUCATION_LEVELS, EDUCATION_LEVEL_LABELS);
export const SITE_KIND_OPTIONS = toOptions(SITE_KINDS, SITE_KIND_LABELS);
export const AFFILIATION_ROLE_OPTIONS = toOptions(AFFILIATION_ROLE_KINDS, AFFILIATION_ROLE_LABELS);
export const PROGRAM_LEVEL_OPTIONS = toOptions(PROGRAM_LEVELS, PROGRAM_LEVEL_LABELS);
export const LIFECYCLE_STATUS_OPTIONS = toOptions(LIFECYCLE_STATUSES, LIFECYCLE_STATUS_LABELS);

/** Тот же список с первой строкой «не указан» — для необязательного поля. */
export function withEmptyOption(options: FieldOption[], label: string): FieldOption[] {
	return [{ value: NO_OPTION, label }, ...options];
}

/** Строки справочника в виде вариантов выбора. */
export function toLookupOptions(
	items: readonly { id: string; label: string }[],
	emptyLabel?: string
): FieldOption[] {
	const options = items.map((item) => ({ value: item.id, label: item.label }));

	return emptyLabel === undefined ? options : withEmptyOption(options, emptyLabel);
}
