<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import FilterBar from '$lib/components/filters/filter-bar.svelte';
	import type { StripFilter } from '$lib/components/filters/filter-strip.svelte';
	import type {
		FilterOption,
		ReportColumnDefinition,
		ReportColumnKey,
		ReportFilterOptions,
		ReportParam,
		ReportQuery
	} from '$lib/contracts/reports';
	import ColumnPicker from './column-picker.svelte';
	import { clearedHref, reportHref, selectedValues, toggledHref } from './query';

	/**
	 * Панель фильтров отчёта — тот же ряд отборов, что над списками
	 * (`filters/filter-bar.svelte`). Каждый контрол пишет в адрес и ничего не
	 * помнит сам: экран — это ссылка, и открытая по ней таблица обязана
	 * совпасть с файлом, выгруженным с того же адреса.
	 *
	 * Порядок — по частоте: период и три отбора, которыми отчёт сужают чаще
	 * всего (вуз, пространство, направление), дальше остальные. Что не
	 * поместилось по ширине, уходит под воронку со счётчиком включённых —
	 * свёрнутый фильтр не сужает выборку молча.
	 */
	let {
		query,
		options,
		available,
		selectedColumns,
		isFiltered
	}: {
		query: ReportQuery;
		options: ReportFilterOptions;
		available: readonly ReportColumnDefinition[];
		selectedColumns: readonly ReportColumnKey[];
		isFiltered: boolean;
	} = $props();

	function go(changes: Parameters<typeof reportHref>[1]) {
		return goto(reportHref(page.url, changes), { keepFocus: true, noScroll: true });
	}

	function list(param: ReportParam, label: string, values: readonly FilterOption[]): StripFilter {
		return {
			kind: 'list',
			key: param,
			label,
			options: values,
			selected: selectedValues(page.url, param),
			testId: `report-filter-${param}`,
			ontoggle: (value) =>
				void goto(toggledHref(page.url, param, value), { keepFocus: true, noScroll: true })
		};
	}

	const filters = $derived<StripFilter[]>([
		{
			kind: 'period',
			key: 'period',
			label: 'Период',
			from: query.from,
			to: query.to,
			testId: 'report-period',
			onchange: ({ from, to }) => void go({ from, to })
		},
		// Пространство — первым из отборов: отчёт общий, и охват выбирают раньше
		// остального.
		list('workspace', 'Пространство', options.workspaces),
		list('org', 'Вуз', options.organizations),
		list('dir', 'Направление', options.directions),
		list('party', 'Тип контрагента', options.parties),
		list('prog', 'Программа', options.programs),
		list('prod', 'Продукт', options.products),
		list('owner', 'Ответственный', options.owners),
		list('assignee', 'Ответственный за вуз', options.owners),
		list('stage', 'Стадия', options.stages),
		list('state', 'Состояние', options.states),
		list('transfer', 'Статус передачи', options.transferStatuses),
		// Обе отметки считаются на момент среза, а не «сейчас»: в движении
		// спрашивать не о чем — там строка это событие, а не стояние.
		...(query.mode === 'snapshot'
			? ([
					{
						kind: 'toggle',
						key: 'overdue',
						label: 'Просроченные',
						active: query.overdue,
						testId: 'report-filter-overdue',
						ontoggle: () => void go({ overdue: query.overdue ? null : 'true' })
					},
					{
						kind: 'toggle',
						key: 'paused',
						label: 'На паузе',
						active: query.paused,
						testId: 'report-filter-paused',
						ontoggle: () => void go({ paused: query.paused ? null : 'true' })
					}
				] satisfies StripFilter[])
			: [])
	]);
</script>

<!-- `data-tour` — метка подсказок (`$lib/onboarding/screens`). -->
<FilterBar
	data-slot="report-filters"
	data-tour="reports-filters"
	testId="report"
	{filters}
	clearHref={isFiltered ? clearedHref(page.url) : null}
>
	{#snippet end()}
		<ColumnPicker {available} selected={selectedColumns} />
	{/snippet}
</FilterBar>
