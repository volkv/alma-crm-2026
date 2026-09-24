<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import FilterXIcon from '@lucide/svelte/icons/filter-x';
	import ListFilterIcon from '@lucide/svelte/icons/list-filter';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import DateField from '$lib/components/form/date-field.svelte';
	import type {
		ReportColumnDefinition,
		ReportColumnKey,
		ReportFilterOptions,
		ReportParam,
		ReportQuery
	} from '$lib/contracts/reports';
	import ColumnPicker from './column-picker.svelte';
	import MultiFilter from './multi-filter.svelte';
	import { clearedHref, reportHref, selectedValues } from './query';

	/**
	 * Панель фильтров отчёта. Каждый контрол пишет в адрес и ничего не помнит
	 * сам: экран — это ссылка, и открытая по ней таблица обязана совпасть с
	 * файлом, выгруженным с того же адреса.
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

	/**
	 * Фильтры за кнопкой «Все фильтры». На виду — период и три отбора, которыми
	 * отчёт сужают чаще всего: вуз, пространство и направление. Остальные
	 * восемь отборов и две отметки в одном ряду отодвигали результат за край
	 * экрана.
	 */
	const MORE_PARAMS: readonly ReportParam[] = [
		'party',
		'prog',
		'prod',
		'owner',
		'assignee',
		'stage',
		'state',
		'transfer'
	];

	/**
	 * Сколько отборов действует за кнопкой: свёрнутый фильтр не должен сужать
	 * выборку молча, поэтому число стоит на самой кнопке.
	 */
	const hiddenActive = $derived(
		MORE_PARAMS.filter((param) => selectedValues(page.url, param).length > 0).length +
			(query.mode === 'snapshot' && query.overdue ? 1 : 0) +
			(query.mode === 'snapshot' && query.paused ? 1 : 0)
	);

	let moreOpen = $state(false);

	function go(changes: Parameters<typeof reportHref>[1]) {
		return goto(reportHref(page.url, changes), { keepFocus: true, noScroll: true });
	}
</script>

<!-- `data-tour` — метка подсказок (`$lib/onboarding/screens`). -->
<div class="flex flex-col gap-2" data-slot="report-filters" data-tour="reports-filters">
	<div class="flex flex-wrap items-center gap-2">
		<!-- Подписи периода стоят в строку с полями, а не над ними: строка над
		     фильтрами отнимала у результата высоту первого экрана. -->
		<div class="flex items-center gap-2">
			<Label for="report-from" class="text-sm font-normal text-muted-foreground">Период с</Label>
			<DateField
				id="report-from"
				class="w-40"
				value={query.from}
				max={query.to}
				onchange={(from) => void go({ from })}
			/>
			<Label for="report-to" class="text-sm font-normal text-muted-foreground">по</Label>
			<DateField
				id="report-to"
				class="w-40"
				value={query.to}
				min={query.from}
				onchange={(to) => void go({ to })}
			/>
		</div>

		<MultiFilter param="org" label="Вуз" options={options.organizations} />
		<MultiFilter param="workspace" label="Пространство" options={options.workspaces} />
		<MultiFilter param="dir" label="Направление" options={options.directions} />

		<Button
			variant="ghost"
			size="sm"
			aria-expanded={moreOpen}
			aria-controls="report-filters-more"
			data-testid="report-filters-more"
			onclick={() => (moreOpen = !moreOpen)}
		>
			<ListFilterIcon aria-hidden="true" />
			Все фильтры{hiddenActive > 0 ? ` (${hiddenActive})` : ''}
		</Button>

		<div class="ml-auto flex flex-wrap items-center gap-2">
			<ColumnPicker {available} selected={selectedColumns} />
			{#if isFiltered}
				<Button variant="ghost" size="sm" href={clearedHref(page.url)}>
					<FilterXIcon aria-hidden="true" />
					Сбросить фильтр
				</Button>
			{/if}
		</div>
	</div>

	{#if moreOpen}
		<div id="report-filters-more" class="flex flex-wrap items-center gap-2">
			<MultiFilter param="party" label="Тип контрагента" options={options.parties} />
			<MultiFilter param="prog" label="Программа" options={options.programs} />
			<MultiFilter param="prod" label="Продукт" options={options.products} />
			<MultiFilter param="owner" label="Ответственный" options={options.owners} />
			<MultiFilter param="assignee" label="Ответственный за вуз" options={options.owners} />
			<MultiFilter param="stage" label="Стадия" options={options.stages} />
			<MultiFilter param="state" label="Состояние" options={options.states} />
			<MultiFilter param="transfer" label="Статус передачи" options={options.transferStatuses} />

			{#if query.mode === 'snapshot'}
				<!-- Обе отметки считаются на момент среза, а не «сейчас»: в движении
				     спрашивать не о чем — там строка это событие, а не стояние. -->
				<Label class="flex items-center gap-2 text-sm font-normal">
					<Checkbox
						checked={query.overdue}
						onCheckedChange={(checked) => void go({ overdue: checked === true ? 'true' : null })}
					/>
					Только просроченные
				</Label>
				<Label class="flex items-center gap-2 text-sm font-normal">
					<Checkbox
						checked={query.paused}
						onCheckedChange={(checked) => void go({ paused: checked === true ? 'true' : null })}
					/>
					Только на паузе
				</Label>
			{/if}
		</div>
	{/if}
</div>
