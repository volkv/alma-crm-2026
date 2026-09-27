<script lang="ts">
	import { formatDate } from '$lib/format';
	import type { HeaderFactProps } from '$lib/platform/card-ui';

	/**
	 * Договор в шапке карточки: номер, состояние и срок. Вуз и юридическое лицо
	 * работают по договору, поэтому он стоит среди главных фактов записи.
	 */
	let { model, label, hide }: HeaderFactProps = $props();
</script>

<div class="min-w-0 {hide}">
	<dt class="text-xs text-muted-foreground">{label}</dt>
	<dd class="mt-0.5 text-sm">
		{#if model.contract !== null}
			<span class="font-medium tabular-nums">№ {model.contract.number}</span>
			<span class="block text-xs text-muted-foreground">
				{model.contract.status}{model.contract.validUntil
					? `, до ${formatDate(model.contract.validUntil)}`
					: ''}
			</span>
		{:else}
			<span class="text-faint">не выбран</span>
		{/if}
	</dd>
</div>
