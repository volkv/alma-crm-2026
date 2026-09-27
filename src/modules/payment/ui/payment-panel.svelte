<script lang="ts">
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { ContextSection } from '$lib/platform/card';
	import type { CardPanelProps } from '$lib/platform/card-ui';

	/**
	 * Стоимость и оплата. Оплата — факт процесса, а не поле записи: её отмечают
	 * пунктом чек-листа «Оплата получена» на стадии, где процесс его объявил, и
	 * панель читает его оттуда. Стоимости в записи нет вовсе — строка говорит
	 * об этом, а не прячется. Оплата, загруженная выгрузкой сайта, называет
	 * себя отдельной строкой: номер заявки, поток и день загрузки.
	 */
	let { model }: CardPanelProps = $props();

	const payment = $derived(model.payment);
</script>

<ContextSection title="Стоимость и оплата">
	<dl class="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-sm">
		<dt class="text-muted-foreground">Стоимость</dt>
		<dd class="text-faint">в записи не указана</dd>
		<dt class="text-muted-foreground">Оплата</dt>
		<dd><StatusBadge tone={payment.tone} dot>{payment.text}</StatusBadge></dd>
	</dl>
	{#if payment.site !== null}
		<p class="text-xs text-muted-foreground">{payment.site}</p>
	{/if}
	{#if payment.stageName !== null}
		<p class="text-xs text-muted-foreground">
			Отметка — в чек-листе стадии «{payment.stageName}».
		</p>
	{/if}
</ContextSection>
