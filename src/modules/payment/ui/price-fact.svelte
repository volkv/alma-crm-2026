<script lang="ts">
	import { formatPriceRub } from '$lib/contracts/terms';
	import type { HeaderFactProps } from '$lib/platform/card-ui';
	import type { PaymentCardData } from '../data';

	/**
	 * Стоимость в шапке карточки лица и компании: коммерческое обучение
	 * начинается с цены, и её ищут рядом с условиями, а не в панели сбоку.
	 * Называют её в панели «Стоимость и оплата».
	 */
	let { label, hide, data }: HeaderFactProps = $props();

	const price = $derived((data as PaymentCardData | undefined)?.terms.priceKopecks ?? null);
</script>

<div class="min-w-0 {hide}">
	<dt class="text-xs text-muted-foreground">{label}</dt>
	<dd class="mt-0.5 text-sm">
		{#if price === null}
			<span class="text-faint">не указана</span>
		{:else}
			<span class="font-medium tabular-nums">{formatPriceRub(price)}</span>
		{/if}
	</dd>
</div>
