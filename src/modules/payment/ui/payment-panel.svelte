<script lang="ts">
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { applyAction, enhance } from '$app/forms';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { formatPriceRub } from '$lib/contracts/terms';
	import { formatDate } from '$lib/format';
	import { ContextSection } from '$lib/platform/card';
	import type { CardPanelProps } from '$lib/platform/card-ui';
	import type { PaymentCardData } from '../data';

	/**
	 * Стоимость и оплата. Стоимость — коммерческое условие дела: её называют
	 * здесь же, в рублях, и она видна в шапке. Оплата — факт процесса, а не поле
	 * записи: её отмечают пунктом чек-листа «Оплата получена» на стадии, где
	 * процесс его объявил, и панель читает его оттуда. Оплата, загруженная
	 * выгрузкой сайта, называет себя отдельной строкой: номер заявки, поток и
	 * день загрузки.
	 */
	let { model, can, data }: CardPanelProps = $props();

	const payment = $derived(model.payment);
	const terms = $derived((data as PaymentCardData | undefined)?.terms ?? null);

	let editing = $state(false);
	let price = $state('');
	let refusal = $state<string | null>(null);

	function startEditing() {
		price =
			terms?.priceKopecks == null
				? ''
				: (terms.priceKopecks / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
		refusal = null;
		editing = true;
	}

	/** Отказ — у самого поля: тост погас бы вместе с причиной. */
	const submit: SubmitFunction = () => {
		refusal = null;

		return async ({ result, update }) => {
			if (result.type === 'failure') {
				const failure = (result.data ?? {}) as { message?: unknown; issues?: unknown };
				const issues = Array.isArray(failure.issues)
					? failure.issues.filter((issue): issue is string => typeof issue === 'string')
					: [];

				refusal = [
					typeof failure.message === 'string' ? failure.message : 'Не сохранено',
					...issues
				]
					.filter((part) => part !== '')
					.join('. ');

				return;
			}

			if (result.type === 'success') {
				await update({ reset: false });
				editing = false;

				return;
			}

			await applyAction(result);
		};
	};
</script>

<ContextSection title="Стоимость и оплата">
	{#snippet action()}
		{#if can.edit && terms !== null && !editing}
			<Button size="xs" variant="outline" onclick={startEditing}>
				<PencilIcon aria-hidden="true" />
				{terms.priceKopecks === null ? 'Указать стоимость' : 'Изменить'}
			</Button>
		{/if}
	{/snippet}

	{#if editing && terms !== null}
		<form method="POST" action="?/setPrice" use:enhance={submit} class="flex flex-col gap-form">
			<input type="hidden" name="version" value={terms.version} />
			<div class="flex flex-col gap-field">
				<Label for="card-price">Стоимость, ₽</Label>
				<Input
					id="card-price"
					name="price"
					inputmode="decimal"
					autocomplete="off"
					placeholder="Например: 45 000"
					bind:value={price}
					aria-describedby="card-price-hint"
				/>
				<p id="card-price-hint" class="text-xs text-muted-foreground">
					Рубли, копейки через запятую. Пустое поле снимает стоимость.
				</p>
			</div>
			{#if refusal !== null}
				<InlineHint tone="warning">{refusal}</InlineHint>
			{/if}
			<div class="flex justify-end gap-2">
				<Button type="button" size="sm" variant="outline" onclick={() => (editing = false)}>
					Отмена
				</Button>
				<Button type="submit" size="sm">Сохранить</Button>
			</div>
		</form>
	{/if}

	<dl class="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-sm">
		<dt class="text-muted-foreground">Стоимость</dt>
		<dd class="min-w-0">
			{#if terms === null || terms.priceKopecks === null}
				<span class="text-faint">не указана</span>
			{:else}
				<span class="font-medium tabular-nums">{formatPriceRub(terms.priceKopecks)}</span>
				{#if terms.updatedAt !== null}
					<span class="block text-xs text-muted-foreground">
						{formatDate(terms.updatedAt)}{terms.updatedByName ? `, ${terms.updatedByName}` : ''}
					</span>
				{/if}
			{/if}
		</dd>
		<dt class="text-muted-foreground">Оплата</dt>
		<!-- `min-w-0`: иначе колонка сетки не уже своего текста, и плашка упирается в край. -->
		<dd class="min-w-0"><StatusBadge tone={payment.tone} dot wrap>{payment.text}</StatusBadge></dd>
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
