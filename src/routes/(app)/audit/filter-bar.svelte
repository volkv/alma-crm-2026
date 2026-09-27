<script lang="ts">
	import { goto } from '$app/navigation';
	import type { SvelteTable } from '@tanstack/svelte-table';
	import ColumnsMenu from '$lib/components/data-table/columns-menu.svelte';
	import type { DataTableFeatures } from '$lib/components/data-table/features';
	import FilterBar, { searchParam } from '$lib/components/filters/filter-bar.svelte';
	import type { StripFilter } from '$lib/components/filters/filter-strip.svelte';
	import { AUDIT_OUTCOMES, AUDIT_SOURCES, type AuditEventView } from '$lib/contracts/audit';
	import {
		AUDIT_EVENT_GROUPS,
		AUDIT_EVENT_LABELS,
		AUDIT_OUTCOME_LABELS,
		AUDIT_SOURCE_LABELS,
		subjectTypeLabel,
		SUBJECT_TYPES
	} from './labels';
	import { auditHref, clearedAuditHref, hasAuditFilter, type AuditFilterParam } from './filters';

	/**
	 * Панель фильтров журнала — тот же ряд отборов, что над остальными списками
	 * (`filters/filter-bar.svelte`). Ничего не хранит: всё, что выбрано, стоит в
	 * адресе страницы — поэтому выборка остаётся ссылкой, переживает «назад» и
	 * той же ссылкой уезжает в выгрузку. Адрес у журнала свой (`filters.ts`:
	 * многозначные параметры повторяются, а не склеиваются через запятую),
	 * поэтому фильтры собраны здесь, а не общими обёртками.
	 */
	let {
		url,
		actors,
		table
	}: {
		url: URL;
		/** Кого предлагать в фильтре по действующему лицу; пусто — выбора нет. */
		actors: readonly { id: string; fullName: string }[];
		table: SvelteTable<DataTableFeatures, AuditEventView> | null;
	} = $props();

	function go(changes: Parameters<typeof auditHref>[1]) {
		return goto(auditHref(url, changes), { keepFocus: true, noScroll: true });
	}

	/** Пункт множественного фильтра: был выбран — убираем, не был — добавляем. */
	function toggle(param: AuditFilterParam, value: string) {
		const current = url.searchParams.getAll(param);
		const next = current.includes(value)
			? current.filter((item) => item !== value)
			: [...current, value];

		return go({ [param]: next });
	}

	/** Одиночный фильтр: повторное нажатие снимает, другой пункт заменяет. */
	function pick(param: AuditFilterParam, value: string) {
		return go({ [param]: url.searchParams.get(param) === value ? null : value });
	}

	const EVENT_OPTIONS = AUDIT_EVENT_GROUPS.flatMap((group) =>
		group.types.map((type) => ({
			value: type,
			label: AUDIT_EVENT_LABELS[type],
			group: group.label
		}))
	);
	const OUTCOME_OPTIONS = AUDIT_OUTCOMES.map((outcome) => ({
		value: outcome,
		label: AUDIT_OUTCOME_LABELS[outcome]
	}));
	const SOURCE_OPTIONS = AUDIT_SOURCES.map((source) => ({
		value: source,
		label: AUDIT_SOURCE_LABELS[source]
	}));
	const SUBJECT_OPTIONS = SUBJECT_TYPES.map((type) => ({
		value: type,
		label: subjectTypeLabel(type)
	}));

	const filters = $derived.by((): StripFilter[] => {
		const subject = url.searchParams.get('subject') ?? '';
		const single = (param: AuditFilterParam) => {
			const value = url.searchParams.get(param);
			return value === null ? [] : [value];
		};

		return [
			{
				kind: 'period',
				key: 'period',
				label: 'Период',
				from: url.searchParams.get('from') ?? '',
				to: url.searchParams.get('to') ?? '',
				clearable: true,
				testId: 'audit-filter-period',
				onchange: ({ from, to }) => void go({ from, to })
			},
			{
				kind: 'list',
				key: 'type',
				label: 'Событие',
				options: EVENT_OPTIONS,
				selected: url.searchParams.getAll('type'),
				testId: 'audit-filter-type',
				ontoggle: (value) => void toggle('type', value)
			},
			{
				kind: 'list',
				key: 'outcome',
				label: 'Результат',
				options: OUTCOME_OPTIONS,
				selected: url.searchParams.getAll('outcome'),
				testId: 'audit-filter-outcome',
				ontoggle: (value) => void toggle('outcome', value)
			},
			{
				kind: 'list',
				key: 'source',
				label: 'Источник',
				options: SOURCE_OPTIONS,
				selected: url.searchParams.getAll('source'),
				testId: 'audit-filter-source',
				ontoggle: (value) => void toggle('source', value)
			},
			{
				kind: 'list',
				key: 'actor',
				label: 'Кто действовал',
				options: actors.map((actor) => ({ value: actor.id, label: actor.fullName })),
				selected: single('actor'),
				single: true,
				testId: 'audit-filter-actor',
				ontoggle: (value) => void pick('actor', value)
			},
			{
				kind: 'list',
				key: 'subjectType',
				label: 'Над чем',
				options: SUBJECT_OPTIONS,
				selected: single('subjectType'),
				single: true,
				testId: 'audit-filter-subject-type',
				ontoggle: (value) => void pick('subjectType', value)
			},
			// Одна запись приходит ссылкой из карточки объекта; включить её из ряда
			// нельзя, только снять.
			...(subject === ''
				? []
				: [
						{
							kind: 'toggle',
							key: 'subject',
							label: `Одна запись: ${subject.slice(0, 8)}`,
							active: true,
							testId: 'audit-filter-subject',
							ontoggle: () => void go({ subject: null })
						} satisfies StripFilter
					])
		];
	});
</script>

<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`). -->
<FilterBar
	data-tour="audit-filters"
	testId="audit"
	search={searchParam(url, 'Поиск по человеку и типу события')}
	{filters}
	clearHref={hasAuditFilter(url) ? clearedAuditHref(url) : null}
>
	{#snippet end()}
		<ColumnsMenu {table} labelClass="max-2xl:sr-only" title="Колонки" />
	{/snippet}
</FilterBar>
