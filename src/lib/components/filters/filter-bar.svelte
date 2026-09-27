<script lang="ts" module>
	import { goto } from '$app/navigation';
	import type { FilterOption, StripFilter } from './filter-strip.svelte';
	import { filterHref, toggledFilterHref } from '$lib/components/directory/query';

	/**
	 * Фильтры ряда отборов, которые живут в адресе как обычные параметры
	 * списка: `status=active` для одного значения, `kind=a,b` для нескольких.
	 * Экрану со своим форматом адреса (взаимодействия, отчёт, журнал событий)
	 * эти обёртки не нужны — он собирает `StripFilter` сам, со своим `ontoggle`.
	 *
	 * Номер страницы при каждом изменении сбрасывается (`filterHref`): у нового
	 * набора строк третьей страницы может и не быть.
	 */

	/** Строка поиска ряда отборов (`filter-bar.svelte`). */
	export type FilterSearch = {
		value: string;
		placeholder: string;
		onsearch: (value: string) => void;
	};

	/** Смена отбора не уводит фокус из меню и не прокручивает страницу к началу. */
	const NAVIGATION = { keepFocus: true, noScroll: true } as const;

	/** Поиск по параметру `q` — тому же, что читает `DataTable`. */
	export function searchParam(url: URL, placeholder: string): FilterSearch {
		return {
			value: url.searchParams.get('q') ?? '',
			placeholder,
			onsearch: (value) => void goto(filterHref(url, 'q', value), NAVIGATION)
		};
	}

	type ParamFilterSpec = {
		param: string;
		label: string;
		options: readonly FilterOption[];
		testId?: string;
	};

	/**
	 * Фильтр с одним значением: повторное нажатие на выбранный пункт снимает
	 * фильтр, другой пункт заменяет прежний.
	 */
	export function singleParamFilter(url: URL, spec: ParamFilterSpec): StripFilter {
		const current = url.searchParams.get(spec.param) ?? '';

		return {
			kind: 'list',
			key: spec.param,
			label: spec.label,
			options: spec.options,
			selected: spec.options.some((option) => option.value === current) ? [current] : [],
			single: true,
			testId: spec.testId,
			ontoggle: (value) =>
				void goto(filterHref(url, spec.param, value === current ? '' : value), NAVIGATION)
		};
	}

	/** Фильтр с несколькими значениями через запятую — они работают как «или». */
	export function multiParamFilter(url: URL, spec: ParamFilterSpec): StripFilter {
		const current = (url.searchParams.get(spec.param) ?? '').split(',');

		return {
			kind: 'list',
			key: spec.param,
			label: spec.label,
			options: spec.options,
			selected: spec.options
				.filter((option) => current.includes(option.value))
				.map((option) => option.value),
			testId: spec.testId,
			ontoggle: (value) => void goto(toggledFilterHref(url, spec.param, value), NAVIGATION)
		};
	}

	/** Переключатель: параметр со значением `value` в адресе — включён, без него — нет. */
	export function toggleParamFilter(
		url: URL,
		spec: { param: string; label: string; value?: string; testId?: string }
	): StripFilter {
		const value = spec.value ?? 'true';
		const active = url.searchParams.get(spec.param) === value;

		return {
			kind: 'toggle',
			key: spec.param,
			label: spec.label,
			active,
			testId: spec.testId,
			ontoggle: () => void goto(filterHref(url, spec.param, active ? '' : value), NAVIGATION)
		};
	}
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import FunnelXIcon from '@lucide/svelte/icons/funnel-x';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import FilterStrip from './filter-strip.svelte';
	import ListSearch from './list-search.svelte';

	/**
	 * Ряд отборов над списком — один на все экраны со списками: поиск, за ним
	 * фильтры, сброс и то, что относится к виду («Колонки», переключатель).
	 * С `sm` это одна строка: фильтры, которые не поместились, уходят в панель
	 * под воронкой (`filter-strip.svelte`), и строка не переносится. На
	 * телефоне две: поиск (с `lead` рядом) и под ним фильтры с `end`; панель
	 * спрятанных фильтров раскрывается третьей строкой. Цели нажатия на
	 * телефоне — 44 px. Кнопки с `data-owner-avatar` из правила высоты
	 * исключены: растянутая по высоте аватарка превращала круг и ободок выбора
	 * в овал, — зону нажатия они растят сами (`owner-filter.svelte`).
	 *
	 * Сброс снимает весь отбор разом — фильтры и поиск; адрес без отбора
	 * собирает экран (`clearHref`), кнопка есть, только пока есть что снимать.
	 *
	 * `testId` — префикс меток для тестов: `<testId>-search`,
	 * `<testId>-filter-more`, `<testId>-filter-clear`.
	 */
	let {
		search,
		filters,
		testId,
		clearHref,
		lead,
		end,
		...rest
	}: {
		/** Строка поиска первой в ряду; у списка без поиска её нет. */
		search?: FilterSearch;
		filters: readonly StripFilter[];
		testId: string;
		/** Адрес того же списка без отбора; `null` — снимать нечего, кнопки нет. */
		clearHref: string | null;
		/** Что стоит сразу за поиском в его строке: аватарки ответственных. */
		lead?: Snippet;
		/** Что прижато к концу строки: «Колонки», переключатель вида. */
		end?: Snippet;
	} & HTMLAttributes<HTMLDivElement> = $props();
</script>

{#snippet clear()}
	{#if clearHref !== null}
		<Tooltip.Provider delayDuration={300}>
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="icon"
							href={clearHref}
							aria-label="Сбросить фильтры"
							data-testid="{testId}-filter-clear"
						>
							<FunnelXIcon aria-hidden="true" />
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content>Сбросить фильтры</Tooltip.Content>
			</Tooltip.Root>
		</Tooltip.Provider>
	{/if}
{/snippet}

<div
	class="flex flex-wrap items-center gap-x-2 gap-y-3 max-sm:[&_a]:min-h-11 max-sm:[&_button:not([data-owner-avatar])]:min-h-11"
	{...rest}
>
	{#if search || lead}
		<div class="flex w-full min-w-0 items-center gap-3 sm:w-auto sm:shrink-0">
			{#if search}
				<ListSearch
					value={search.value}
					placeholder={search.placeholder}
					testId="{testId}-search"
					onsearch={search.onsearch}
				/>
			{/if}
			{@render lead?.()}
		</div>
	{/if}

	<FilterStrip
		{filters}
		panelId="{testId}-filter-panel"
		moreTestId="{testId}-filter-more"
		trailing={clearHref === null ? undefined : clear}
		{end}
	/>
</div>
