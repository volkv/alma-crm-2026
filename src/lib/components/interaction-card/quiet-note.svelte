<script lang="ts">
	import BellOffIcon from '@lucide/svelte/icons/bell-off';
	import type { CardQuiet } from './model';

	/**
	 * «Тишина» словами: сколько дней по записи ничего не происходило, какая
	 * норма у стадии и что с этим сделать. Метка без объяснения заставляла
	 * гадать, плохо это или просто давно.
	 */
	let { quiet, compact = false }: { quiet: CardQuiet; compact?: boolean } = $props();
</script>

<div
	class="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-warning-soft-foreground"
	data-slot="quiet-note"
>
	<BellOffIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
	<p class="min-w-0 text-sm">
		<span class="font-medium">{quiet.text}.</span>
		{#if !compact}
			<span>{quiet.advice}</span>
		{:else}
			<span class="block text-xs">{quiet.advice}</span>
		{/if}
	</p>
</div>
