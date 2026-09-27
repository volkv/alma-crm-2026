<script lang="ts">
	import StatusBadge from '$lib/components/status-badge.svelte';
	import type { HeaderFactProps } from '$lib/platform/card-ui';

	/**
	 * Оплата в шапке карточки. Обучение физического лица держится на ней, как
	 * работа с вузом — на договоре, поэтому у лица она стоит среди главных фактов.
	 */
	let { model, label, hide }: HeaderFactProps = $props();
</script>

<div class="min-w-0 {hide}">
	<dt class="text-xs text-muted-foreground">{label}</dt>
	<dd class="mt-0.5 text-sm">
		<StatusBadge tone={model.payment.tone} dot wrap>{model.payment.text}</StatusBadge>
	</dd>
</div>
