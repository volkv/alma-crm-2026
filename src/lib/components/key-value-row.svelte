<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * One field–value pair inside `KeyValue`. Pass plain text through `value`;
	 * use the `children` snippet when the value is a badge, a link or anything
	 * else that is not a string. An empty value renders as a dash rather than
	 * collapsing the row, so the card keeps the same shape for every record.
	 */
	let {
		label,
		value,
		children
	}: {
		label: string;
		value?: string | number | null;
		children?: Snippet;
	} = $props();
</script>

<div class="min-w-0">
	<dt class="text-xs text-muted-foreground">{label}</dt>
	<dd class="mt-0.5 text-sm break-words">
		{#if children}
			{@render children()}
		{:else if value === null || value === undefined || value === ''}
			<span class="text-faint">—</span>
		{:else}
			{value}
		{/if}
	</dd>
</div>
