<script lang="ts">
	import StatusBadge from '$lib/components/status-badge.svelte';
	import type { CardTiming } from './model';

	/**
	 * Срок текущей стадии: тон и слова — из модели, дата — рядом мелким
	 * текстом. Единственное место карточки, где названа просрочка.
	 */
	let { timing }: { timing: CardTiming } = $props();
</script>

<span class="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
	<StatusBadge tone={timing.tone} dot>{timing.text}</StatusBadge>
	<span class="text-xs text-muted-foreground">{timing.detail}</span>
</span>
