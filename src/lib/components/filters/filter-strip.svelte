<script lang="ts" module>
	/**
	 * Вариант фильтра-списка: значение для адреса и подпись. `group` — заголовок
	 * раздела в меню (события журнала по модулям); варианты одной группы стоят
	 * подряд.
	 */
	export type FilterOption = { value: string; label: string; group?: string };

	/** Фильтр ленты: дропдаун со списком значений, переключатель или период. */
	export type StripFilter =
		| {
				kind: 'list';
				key: string;
				label: string;
				options: readonly FilterOption[];
				selected: readonly string[];
				single?: boolean;
				/** Выбор обязателен (отчётный период): на кнопке значение, а не счётчик. */
				showValue?: boolean;
				testId?: string;
				ontoggle: (value: string) => void;
		  }
		| {
				kind: 'period';
				key: string;
				label: string;
				/** Даты как `2026-09-12`; пустая строка — границы нет. */
				from: string;
				to: string;
				/** Период без границ допустим — у кнопки есть сброс. */
				clearable?: boolean;
				testId?: string;
				onchange: (range: { from: string; to: string }) => void;
		  }
		| {
				kind: 'toggle';
				key: string;
				label: string;
				active: boolean;
				testId?: string;
				ontoggle: () => void;
		  };
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import FunnelIcon from '@lucide/svelte/icons/funnel';
	import { Button } from '$lib/components/ui/button/index.js';
	import { cn } from '$lib/utils.js';
	import FilterCount from './filter-count.svelte';
	import ListFilter from './list-filter.svelte';
	import PeriodFilter from './period-filter.svelte';

	/**
	 * Фильтры над списком одной строкой, которая не переносится: что не
	 * поместилось, уходит с конца под кнопку-воронку, как в трекерах задач.
	 * Воронка раскрывает под строкой панель с одними спрятанными фильтрами —
	 * теми же кнопками, что в строке, а не вложенным меню: дропдаун внутри
	 * дропдауна на телефоне закрывается от первого промаха. Число на воронке —
	 * сколько спрятанных фильтров включено, чтобы отбор не прятался вместе с
	 * кнопкой. Всё поместилось — воронки нет.
	 *
	 * Компонент отдаёт родителю два соседних элемента — строку и панель, — и
	 * оба встают во flex-ряд вызывающего (ему нужен `flex-wrap`). Строка —
	 * фильтры и за ними `end` (переключатель вида) — занимает остаток ширины
	 * ряда: `flex-1`, основа 0, так что её ширину задаёт ряд, а не
	 * содержимое, и пересчёт не качается. Между фильтрами и `end` — зазор
	 * `gap-4` (16 px) вместо обычных 8 px между кнопками: фильтры и то, что
	 * относится к виду («Колонки», переключатель), — разные группы, и вплотную
	 * они сливаются. Зазор отнят у ширины ленты самой раскладкой, поэтому мерка
	 * его учитывает без отдельного слагаемого: не влез фильтр с зазором —
	 * уходит в панель. Уже `min-w-64` строка не сжимается — столько нужно
	 * воронке со счётчиком, сбросу, зазору, «Колонкам» и переключателю; на
	 * планшете, где рядом с поиском и аватарками не остаётся и этого, строка
	 * целиком уходит на свою линию, а не наезжает на соседей и не бросает
	 * переключатель одного. Панель встаёт отдельной линией под рядом
	 * (`order-last w-full`).
	 *
	 * Ширины меряются по невидимой копии всех фильтров (`ghost`): каждый
	 * настоящий фильтр стоит в разметке ровно один раз — в строке или в панели,
	 * — и `data-testid` у него один, а размер копии известен всегда, где бы
	 * ни стоял оригинал. Копия вынута из потока и из дерева доступности.
	 *
	 * До гидратации мерить нечем: сервер отдаёт все фильтры в строке, а лишние
	 * переносятся на вторую линию строки высотой в одну и срезаются — без
	 * воронки, но и без строки, которая лезет за экран. `trailing` — то, что
	 * стоит сразу за лентой и место у неё отнимает (сброс фильтров).
	 */
	let {
		filters,
		panelId,
		moreTestId,
		trailing,
		end
	}: {
		filters: readonly StripFilter[];
		/** `id` панели спрятанных фильтров — на него ссылается `aria-controls` воронки. */
		panelId: string;
		moreTestId?: string;
		trailing?: Snippet;
		/** То, что стоит в конце строки, прижатое вправо: переключатель вида. */
		end?: Snippet;
	} = $props();

	/** Промежуток между кнопками — `gap-2`. */
	const GAP = 8;

	// Список без вариантов не рисует кнопки (`list-filter.svelte`), и в ленте
	// ему нечего занимать.
	const items = $derived(
		filters.filter((filter) => filter.kind !== 'list' || filter.options.length > 0)
	);

	let strip = $state<HTMLDivElement | null>(null);
	let ghost = $state<HTMLDivElement | null>(null);
	let tail = $state<HTMLDivElement | null>(null);

	/** Сколько фильтров помещается в строку; `null` — ещё не мерили (сервер, до гидратации). */
	let shown = $state<number | null>(null);
	let open = $state(false);

	const count = $derived(shown === null ? items.length : Math.min(shown, items.length));
	const visible = $derived(items.slice(0, count));
	const hidden = $derived(items.slice(count));
	// Обязательный период (отчёт) — условие выборки, а не сужение: в число
	// включённых он не входит и свою кнопку не красит (`period-filter.svelte`).
	const hiddenActive = $derived(
		hidden.filter((item) =>
			item.kind === 'toggle'
				? item.active
				: item.kind === 'period'
					? item.clearable === true && (item.from !== '' || item.to !== '')
					: item.selected.length > 0
		).length
	);
	// Раздвинули окно, и всё поместилось — панели показывать нечего.
	const panelOpen = $derived(open && hidden.length > 0);

	function width(element: HTMLElement): number {
		return Math.ceil(element.getBoundingClientRect().width);
	}

	function measure() {
		if (strip === null || ghost === null) return;

		const cells = Array.from(ghost.querySelectorAll<HTMLElement>(':scope > [data-cell]'));
		// Дробные ширины округляются в запас — кнопки вверх, лента вниз: сумма
		// округлённых вниз `offsetWidth` могла бы превысить ленту на пиксель-два,
		// и последний фильтр съел бы зазор перед переключателем.
		const widths = cells.map((cell) => width(cell));
		// Воронку копия держит со счётчиком: место под него занято заранее, и
		// появление числа не выталкивает из строки ещё один фильтр.
		const moreCell = ghost.querySelector<HTMLElement>(':scope > [data-more]');
		const moreWidth = moreCell === null ? 0 : width(moreCell);
		const available =
			Math.floor(strip.getBoundingClientRect().width) - (tail === null ? 0 : width(tail) + GAP);
		const total =
			widths.reduce((sum, width) => sum + width, 0) + GAP * Math.max(widths.length - 1, 0);

		if (total <= available) {
			shown = widths.length;
			return;
		}

		const budget = available - moreWidth - GAP;
		let used = 0;
		let fits = 0;

		for (const width of widths) {
			const next = used + (fits > 0 ? GAP : 0) + width;

			if (next > budget) break;

			used = next;
			fits += 1;
		}

		shown = fits;
	}

	// Ширина меняется и у строки (окно, боковая панель), и у фильтров (появился
	// счётчик выбранного, пришли варианты) — копия следит за вторым, строка за
	// первым. Первый замер — сразу, до кадра: наблюдатель срабатывает только
	// при отрисовке, и строка успела бы мигнуть лишней воронкой. Число фильтров
	// читается здесь, чтобы смена набора (стадия есть только у таблицы)
	// пересчитала строку, даже если общая ширина случайно совпала.
	$effect(() => {
		void items.length;
		if (strip === null || ghost === null) return;

		const observer = new ResizeObserver(() => measure());

		measure();
		observer.observe(strip);
		observer.observe(ghost);
		if (tail !== null) observer.observe(tail);

		return () => observer.disconnect();
	});
</script>

{#snippet filter(item: StripFilter, testId: string | undefined)}
	{#if item.kind === 'list'}
		<ListFilter
			label={item.label}
			options={item.options}
			selected={item.selected}
			single={item.single}
			showValue={item.showValue}
			{testId}
			ontoggle={item.ontoggle}
		/>
	{:else if item.kind === 'period'}
		<PeriodFilter
			label={item.label}
			from={item.from}
			to={item.to}
			clearable={item.clearable}
			{testId}
			onchange={item.onchange}
		/>
	{:else}
		<Button
			variant={item.active ? 'selected' : 'outline'}
			aria-pressed={item.active}
			data-testid={testId}
			onclick={item.ontoggle}
		>
			{item.label}
		</Button>
	{/if}
{/snippet}

{#snippet more(count: number, measuring: boolean)}
	<Button
		variant={count > 0 ? 'selected' : 'outline'}
		aria-label={count > 0 ? `Ещё фильтры, включено: ${count}` : 'Ещё фильтры'}
		title={measuring ? undefined : 'Ещё фильтры'}
		aria-expanded={measuring ? undefined : panelOpen}
		aria-controls={measuring ? undefined : panelId}
		data-testid={measuring ? undefined : moreTestId}
		tabindex={measuring ? -1 : undefined}
		onclick={measuring ? undefined : () => (open = !open)}
	>
		<FunnelIcon aria-hidden="true" />
		<FilterCount {count} label="включено" />
	</Button>
{/snippet}

<div class="flex min-w-64 flex-1 basis-0 items-center gap-4">
	<div
		bind:this={strip}
		class={cn(
			'relative flex min-w-0 flex-1 basis-0 items-center gap-2',
			shown === null && 'max-h-9 flex-wrap overflow-hidden max-sm:max-h-11'
		)}
	>
		{#each visible as item (item.key)}
			{@render filter(item, item.testId)}
		{/each}

		{#if hidden.length > 0}
			{@render more(hiddenActive, false)}
		{/if}

		{#if trailing}
			<div bind:this={tail} class="flex shrink-0 items-center">{@render trailing()}</div>
		{/if}

		<!-- Мерка: все фильтры в том виде, в каком они стоят в строке, и воронка
		со счётчиком. Высота нулевая, лишнее срезано по ширине строки — копия не
		раздвигает ни строку, ни страницу. -->
		<div class="pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden">
			<div bind:this={ghost} class="flex w-max items-center gap-2" inert aria-hidden="true">
				{#each items as item (item.key)}
					<div data-cell class="flex shrink-0">{@render filter(item, undefined)}</div>
				{/each}
				<div data-more class="flex shrink-0">
					{@render more(1, true)}
				</div>
			</div>
		</div>
	</div>

	{@render end?.()}
</div>

<div
	id={panelId}
	role="group"
	aria-label="Ещё фильтры"
	class="{panelOpen ? 'flex' : 'hidden'} order-last w-full flex-wrap items-center gap-2"
>
	{#each hidden as item (item.key)}
		{@render filter(item, item.testId)}
	{/each}
</div>
