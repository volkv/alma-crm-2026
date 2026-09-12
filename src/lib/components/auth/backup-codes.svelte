<script lang="ts">
	import InlineHint from '$lib/components/inline-hint.svelte';

	/**
	 * Резервные коды в тот единственный раз, когда их видно.
	 *
	 * Показывать их второй раз нечем: в базе лежат хеши. Поэтому текст рядом
	 * говорит не «сохраните», а что именно будет, если не сохранить, — и это не
	 * запугивание, а единственное предупреждение, которое человек здесь получит.
	 */
	let { codes }: { codes: readonly string[] } = $props();
</script>

<div class="flex flex-col gap-3">
	<InlineHint tone="warning">
		Каждый код работает один раз и заменяет код из приложения. Запишите их сейчас: второй раз
		система их не покажет — в базе остаются только отпечатки.
	</InlineHint>

	<ul
		class="grid grid-cols-1 gap-1.5 rounded-md border border-border bg-surface-muted p-3 font-mono text-sm sm:grid-cols-2"
		data-testid="backup-codes"
	>
		{#each codes as code (code)}
			<li class="tracking-wider select-all">{code}</li>
		{/each}
	</ul>
</div>
