<script lang="ts">
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { InteractionView } from '$lib/contracts/interactions';
	import { formatDate } from '$lib/format';
	import ContextSection from './context-section.svelte';
	import type { CounterpartyShape } from './model';

	/**
	 * Сроки записи. У вуза их два — срок соглашения и учебный год. У лица
	 * соглашения нет: его сроки — это договор и оплата, а у записи остаётся
	 * период обучения.
	 */
	let {
		interaction,
		shape,
		onEditPlan
	}: {
		interaction: InteractionView;
		shape: CounterpartyShape;
		/** Открыть правку названия и сроков; `null` — права на правку нет. */
		onEditPlan: (() => void) | null;
	} = $props();

	const period = (start: string | null, end: string | null) =>
		start === null && end === null
			? null
			: `${start === null ? '…' : formatDate(start)} — ${end === null ? '…' : formatDate(end)}`;
	const agreement = $derived(
		period(interaction.agreementPeriodStart, interaction.agreementPeriodEnd)
	);
	const academic = $derived(period(interaction.academicPeriodStart, interaction.academicPeriodEnd));
</script>

<ContextSection title="Сроки">
	{#snippet action()}
		{#if onEditPlan !== null}
			<Button size="xs" variant="outline" onclick={onEditPlan}>
				<PencilIcon aria-hidden="true" />
				Изменить план
			</Button>
		{/if}
	{/snippet}
	<dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
		{#if shape === 'institution'}
			<dt class="text-muted-foreground">Соглашение</dt>
			<dd class="tabular-nums">{agreement ?? '—'}</dd>
			<dt class="text-muted-foreground">Учебный год</dt>
			<dd class="tabular-nums">{academic ?? '—'}</dd>
		{:else}
			<dt class="text-muted-foreground">Обучение</dt>
			<dd class="tabular-nums">{academic ?? '—'}</dd>
		{/if}
	</dl>
</ContextSection>
