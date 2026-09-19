<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { formatDateTime, pluralize } from '$lib/format';
	import {
		isStubChannel,
		NOTIFICATION_CHANNEL_LABELS,
		NOTIFICATION_KIND_LABELS,
		NOTIFICATION_STATUS_LABELS,
		RETRIABLE_DELIVERY_STATUSES,
		type NotificationDeliveryView
	} from '$lib/contracts/notifications';

	/**
	 * Одна строка журнала доставок.
	 *
	 * Кнопка повтора не прячется у чужих состояний, а просто отсутствует там,
	 * где повторять нечего: отправленное не повторяют, а заглушке повтор ничего
	 * не изменит — она и в первый раз ничего не отправила.
	 *
	 * Текст письма лежит под строкой, а не в её колонке: письмо — это несколько
	 * абзацев, и в колонке журнала оно превратило бы таблицу в простыню. Развёрнут
	 * он раскрывающимся блоком, потому что вопрос «что там было» задают об одной
	 * строке, а не обо всех сразу.
	 *
	 * Попытки и подробности до `2xl` стоят не своими колонками, а строкой под
	 * состоянием: на экране в 1280 точек списку остаётся около тысячи, и
	 * ключевые «повод — получатель — канал — состояние» обязаны помещаться без
	 * горизонтальной прокрутки (`docs/design.md`, «Приоритет колонок»).
	 */
	let { delivery, canManage }: { delivery: NotificationDeliveryView; canManage: boolean } =
		$props();

	/** Столько же колонок, сколько в шапке таблицы (`+page.svelte`). */
	const COLUMNS = 9;

	let letterOpen = $state(false);

	const hasLetter = $derived(delivery.subject !== null || delivery.body !== null);

	const tone = $derived(
		delivery.status === 'sent'
			? 'success'
			: delivery.status === 'failed'
				? 'danger'
				: delivery.status === 'stub'
					? 'neutral'
					: 'warning'
	);

	const canRetry = $derived(
		canManage && (RETRIABLE_DELIVERY_STATUSES as readonly string[]).includes(delivery.status)
	);
</script>

<Table.Row>
	<Table.Cell class="whitespace-normal">{formatDateTime(delivery.updatedAt)}</Table.Cell>
	<Table.Cell class="whitespace-normal">{NOTIFICATION_KIND_LABELS[delivery.kind]}</Table.Cell>
	<Table.Cell class="max-w-56 whitespace-normal">
		{#if delivery.interactionTitle !== null}
			<a
				class="underline underline-offset-4"
				href={resolve('/(app)/interactions/[id=uuid]', { id: delivery.interactionId })}
			>
				{delivery.interactionTitle}
			</a>
		{:else}
			—
		{/if}
		{#if delivery.stageName !== null}
			<span class="block text-xs text-muted-foreground">стадия «{delivery.stageName}»</span>
		{/if}
	</Table.Cell>
	<Table.Cell class="whitespace-normal">{delivery.recipientName ?? '—'}</Table.Cell>
	<Table.Cell>{NOTIFICATION_CHANNEL_LABELS[delivery.channel]}</Table.Cell>
	<Table.Cell>
		<StatusBadge {tone} dot>{NOTIFICATION_STATUS_LABELS[delivery.status]}</StatusBadge>
		{#if delivery.attempts > 0 || delivery.lastError !== null}
			<span
				class="mt-0.5 block max-w-40 text-xs whitespace-normal text-muted-foreground 2xl:hidden"
			>
				{pluralize(delivery.attempts, ['попытка', 'попытки', 'попыток'])}
				{#if delivery.lastError !== null}
					<span class={delivery.status === 'failed' ? 'text-danger-soft-foreground' : ''}>
						· {delivery.lastError}
					</span>
				{/if}
			</span>
		{/if}
	</Table.Cell>
	<Table.Cell class="hidden whitespace-normal 2xl:table-cell">
		{delivery.attempts}
		{#if delivery.nextNotifyAt !== null}
			<span class="block text-xs text-muted-foreground">
				следующее {formatDateTime(delivery.nextNotifyAt)}
			</span>
		{/if}
	</Table.Cell>
	<Table.Cell class="hidden max-w-64 text-xs whitespace-normal 2xl:table-cell">
		{#if delivery.lastError !== null}
			<span
				class={delivery.status === 'failed'
					? 'text-danger-soft-foreground'
					: 'text-muted-foreground'}
			>
				{delivery.lastError}
			</span>
		{:else if delivery.sentAt !== null}
			<span class="text-muted-foreground">отправлено {formatDateTime(delivery.sentAt)}</span>
		{:else}
			—
		{/if}
	</Table.Cell>
	<Table.Cell class="whitespace-normal">
		<div class="flex flex-wrap items-center gap-2">
			{#if hasLetter}
				<Button
					size="sm"
					variant="ghost"
					aria-expanded={letterOpen}
					onclick={() => (letterOpen = !letterOpen)}
				>
					{letterOpen ? 'Скрыть текст' : 'Текст письма'}
				</Button>
			{/if}
			{#if canRetry}
				<!-- `data-tour` — метка подсказок по этому экрану
					(`$lib/onboarding/screens`); рамка встаёт вокруг первой строки, где
					повтор вообще имеет смысл. -->
				<form data-tour="notifications-retry" method="POST" action="?/retry" use:enhance>
					<input type="hidden" name="deliveryId" value={delivery.id} />
					<Button type="submit" size="sm" variant="outline">Повторить</Button>
				</form>
			{/if}
		</div>
	</Table.Cell>
</Table.Row>

{#if letterOpen}
	<Table.Row>
		<Table.Cell colspan={COLUMNS} class="bg-surface-muted">
			<div class="flex flex-col gap-2">
				<p class="font-medium">{delivery.subject ?? '—'}</p>
				<p class="whitespace-pre-line text-muted-foreground">{delivery.body ?? '—'}</p>
				{#if isStubChannel(delivery.channel)}
					<p class="text-xs text-muted-foreground">
						{NOTIFICATION_CHANNEL_LABELS[delivery.channel]}: заглушка, не отправлено — это текст,
						который ушёл бы настоящим каналом.
					</p>
				{/if}
			</div>
		</Table.Cell>
	</Table.Row>
{/if}
