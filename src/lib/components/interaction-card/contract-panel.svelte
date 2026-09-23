<script lang="ts">
	import StatusBadge from '$lib/components/status-badge.svelte';
	import type { InteractionContractView } from '$lib/contracts/interactions';
	import { formatDate } from '$lib/format';
	import ContextSection from './context-section.svelte';

	/**
	 * Позиции договора, по которым идёт работа: продукт, лицензия и передача.
	 * Номер и статус договора названы в шапке карточки — здесь только то, чего
	 * в шапке нет.
	 */
	let { contract }: { contract: InteractionContractView } = $props();

	/** «Передан» — дело сделано; всё остальное ещё ждёт действия. */
	const transferred = (status: string) =>
		status.trim().toLocaleLowerCase('ru').startsWith('передан');
</script>

<ContextSection title="Позиции договора">
	{#if contract.items.length === 0}
		<p class="text-sm text-muted-foreground">Позиции договора для этой работы не выбраны.</p>
	{:else}
		<ul class="flex flex-col gap-2">
			{#each contract.items as item (item.id)}
				<li class="flex flex-col gap-0.5">
					<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
						<span class="text-sm font-medium">{item.name}</span>
						<StatusBadge tone={transferred(item.transferStatus) ? 'success' : 'warning'}>
							{item.transferStatus}
						</StatusBadge>
					</div>
					<p class="text-xs text-muted-foreground">
						{#if item.licenseUntil}
							Лицензия до {formatDate(item.licenseUntil)}
						{:else}
							Лицензия не оформлена
						{/if}
					</p>
				</li>
			{/each}
		</ul>
	{/if}
</ContextSection>
