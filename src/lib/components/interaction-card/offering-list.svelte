<script lang="ts">
	import { resolve } from '$app/paths';
	import type { InteractionView } from '$lib/contracts/interactions';

	/**
	 * Программы и продукты записи — одним списком для любого вида контрагента:
	 * что именно предлагаем, у вуза и у лица называется одинаково.
	 *
	 * Названия — ссылки в новой вкладке: карточку программы открывают, чтобы
	 * свериться с описанием и материалами посреди работы над делом, и
	 * закрывать ради этого карточку дела незачем.
	 */
	let { interaction }: { interaction: InteractionView } = $props();

	const LINK = 'break-words text-link hover:text-link-hover hover:underline';
</script>

{#if interaction.programs.length === 0 && interaction.products.length === 0}
	<p class="text-sm text-faint">Программа не выбрана</p>
{:else}
	<ul class="flex flex-col gap-1 text-sm">
		{#each interaction.programs as program (program.programId)}
			<li class="break-words">
				<a
					class={LINK}
					href={resolve('/(app)/programs/[id=uuid]', { id: program.programId })}
					target="_blank"
					rel="noopener"
				>
					<span class="text-muted-foreground tabular-nums">{program.code}</span>
					{program.name}
				</a>
			</li>
		{/each}
	</ul>
	{#if interaction.products.length > 0}
		<p class="text-xs text-muted-foreground">
			Продукты:
			{#each interaction.products as product, index (product.productId)}
				<a
					class={LINK}
					href={resolve('/(app)/products/[id=uuid]', { id: product.productId })}
					target="_blank"
					rel="noopener">{product.name}</a
				>{index < interaction.products.length - 1 ? ', ' : ''}
			{/each}
		</p>
	{/if}
{/if}
