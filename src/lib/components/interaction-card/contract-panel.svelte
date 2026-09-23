<script lang="ts">
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { InteractionContractView } from '$lib/contracts/interactions';
	import { formatDate } from '$lib/format';
	import ContextSection from './context-section.svelte';

	/**
	 * Договор, по которому идёт работа, и его позиции: продукт, лицензия и
	 * передача. Номер и состояние договора названы в шапке карточки — здесь
	 * срок договора и то, чего в шапке нет. Сам договор ведут в карточке
	 * контрагента, здесь его только выбирают.
	 */
	let {
		contract,
		onEdit
	}: {
		contract: InteractionContractView | null;
		/** Открыть выбор договора и позиций; `null` — права на правку нет. */
		onEdit: (() => void) | null;
	} = $props();

	/** «Передан» — дело сделано; всё остальное ещё ждёт действия. */
	const transferred = (status: string) =>
		status.trim().toLocaleLowerCase('ru').startsWith('передан');

	const day = (value: string | null) => (value === null ? '…' : formatDate(value));
</script>

<ContextSection title="Договор и позиции">
	{#snippet action()}
		{#if onEdit !== null}
			<Button size="xs" variant="outline" onclick={onEdit}>
				<PencilIcon aria-hidden="true" />
				{contract === null ? 'Выбрать договор' : 'Изменить'}
			</Button>
		{/if}
	{/snippet}

	{#if contract === null}
		<p class="text-sm text-muted-foreground">
			Договор не выбран: коммерческих условий у продуктов записи нет.
		</p>
	{:else}
		{#if contract.signedOn !== null || contract.validUntil !== null}
			<p class="text-xs text-muted-foreground tabular-nums">
				Договор № {contract.number}: {day(contract.signedOn)} — {day(contract.validUntil)}
			</p>
		{/if}
		{#if contract.items.length === 0}
			<p class="text-sm text-muted-foreground">Позиции договора для этой работы не выбраны.</p>
		{:else}
			<ul class="flex flex-col gap-2">
				{#each contract.items as item (item.id)}
					<li class="flex flex-col gap-0.5">
						<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
							<span class="text-sm font-medium break-words">{item.code} — {item.name}</span>
							<StatusBadge tone={transferred(item.transferStatus) ? 'success' : 'warning'}>
								{item.transferStatus}
							</StatusBadge>
						</div>
						<p class="text-xs text-muted-foreground">
							{#if item.licenseSignedAt === null && item.licenseUntil === null}
								Лицензия не оформлена
							{:else}
								Лицензия: {day(item.licenseSignedAt)} — {day(item.licenseUntil)}
							{/if}
						</p>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</ContextSection>
