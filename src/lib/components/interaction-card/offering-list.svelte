<script lang="ts">
	import type { InteractionView } from '$lib/contracts/interactions';

	/**
	 * Программы и продукты записи — одним списком для любого вида контрагента:
	 * что именно предлагаем, у вуза и у лица называется одинаково.
	 */
	let { interaction }: { interaction: InteractionView } = $props();
</script>

{#if interaction.programs.length === 0 && interaction.products.length === 0}
	<p class="text-sm text-faint">Программа не выбрана</p>
{:else}
	<ul class="flex flex-col gap-1 text-sm">
		{#each interaction.programs as program (program.programId)}
			<li class="break-words">
				<span class="text-muted-foreground tabular-nums">{program.code}</span>
				{program.name}
			</li>
		{/each}
	</ul>
	{#if interaction.products.length > 0}
		<p class="text-xs text-muted-foreground">
			Продукты: {interaction.products.map((product) => product.name).join(', ')}
		</p>
	{/if}
{/if}
