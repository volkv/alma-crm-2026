<script lang="ts">
	import CalendarRangeIcon from '@lucide/svelte/icons/calendar-range';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as Popover from '$lib/components/ui/popover/index.js';
	import DateField from '$lib/components/form/date-field.svelte';
	import { formatDate } from '$lib/format';

	/**
	 * Фильтр по периоду — такая же кнопка ряда отборов, как `list-filter.svelte`,
	 * а не два поля дат с подписями: поля в строку не помещались рядом с
	 * остальными фильтрами и выглядели другим контролом. На кнопке — выбранные
	 * границы, по нажатию — две даты «с» и «по».
	 *
	 * Период, у которого границы задаёт сам экран (отчёт считается за период
	 * всегда), кнопку в цвет выбранного не красит: это не сужение, а условие
	 * выборки. Необязательный (`clearable`, журнал событий) красит, пока задана
	 * хоть одна граница, и даёт снять обе разом.
	 */
	let {
		label,
		from,
		to,
		clearable = false,
		testId,
		onchange
	}: {
		label: string;
		from: string;
		to: string;
		clearable?: boolean;
		testId?: string;
		onchange: (range: { from: string; to: string }) => void;
	} = $props();

	const uid = $props.id();
	const active = $derived(clearable && (from !== '' || to !== ''));

	const caption = $derived.by(() => {
		if (from !== '' && to !== '') return `${formatDate(from)} — ${formatDate(to)}`;
		if (from !== '') return `с ${formatDate(from)}`;
		if (to !== '') return `по ${formatDate(to)}`;
		return null;
	});
</script>

<Popover.Root>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant={active ? 'selected' : 'outline'}
				data-testid={testId}
				data-active={active ? 'true' : undefined}
				title={caption === null ? undefined : `${label}: ${caption}`}
			>
				<CalendarRangeIcon aria-hidden="true" />
				{#if caption === null}
					{label}
				{:else}
					<span class="sr-only">{label}:</span>
					<span class="tabular-nums">{caption}</span>
				{/if}
				<ChevronDownIcon aria-hidden="true" />
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content align="start" class="w-auto gap-3">
		<div class="text-xs font-medium text-muted-foreground">{label}</div>
		<div class="grid grid-cols-[auto_1fr] items-center gap-2">
			<Label for="{uid}-from" class="font-normal text-muted-foreground">с</Label>
			<DateField
				id="{uid}-from"
				class="w-44"
				value={from}
				max={to || undefined}
				onchange={(next) => onchange({ from: next, to })}
			/>
			<Label for="{uid}-to" class="font-normal text-muted-foreground">по</Label>
			<DateField
				id="{uid}-to"
				class="w-44"
				value={to}
				min={from || undefined}
				onchange={(next) => onchange({ from, to: next })}
			/>
		</div>
		{#if active}
			<Button variant="ghost" size="sm" onclick={() => onchange({ from: '', to: '' })}>
				Снять период
			</Button>
		{/if}
	</Popover.Content>
</Popover.Root>
