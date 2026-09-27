<script lang="ts">
	/**
	 * Круглый счётчик на кнопке фильтра: сколько значений выбрано или сколько
	 * спрятанных фильтров включено. Заливка — цвет отмеченного (`link`), как у
	 * счётчика непрочитанного: на подложке выбранного кнопки он читается
	 * отдельным знаком. При нуле счётчика нет. Читалке число достаётся вместе
	 * со словом — голая цифра после подписи ничего не объясняет.
	 */
	let { count, label = 'выбрано' }: { count: number; label?: string } = $props();
</script>

{#if count > 0}
	<span
		class="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-link px-1 text-xs leading-none font-semibold text-link-foreground tabular-nums"
	>
		<span class="sr-only">{label}:</span>
		{count}
	</span>
{/if}
