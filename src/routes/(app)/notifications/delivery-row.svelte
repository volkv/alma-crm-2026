<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { formatDateTime } from '$lib/format';
	import {
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
	 */
	let { delivery, canManage }: { delivery: NotificationDeliveryView; canManage: boolean } =
		$props();

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
	<Table.Cell class="whitespace-nowrap">{formatDateTime(delivery.updatedAt)}</Table.Cell>
	<Table.Cell>{NOTIFICATION_KIND_LABELS[delivery.kind]}</Table.Cell>
	<Table.Cell>
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
	<Table.Cell>{delivery.recipientName ?? '—'}</Table.Cell>
	<Table.Cell>{NOTIFICATION_CHANNEL_LABELS[delivery.channel]}</Table.Cell>
	<Table.Cell>
		<StatusBadge {tone} dot>{NOTIFICATION_STATUS_LABELS[delivery.status]}</StatusBadge>
	</Table.Cell>
	<Table.Cell class="whitespace-nowrap">
		{delivery.attempts}
		{#if delivery.nextNotifyAt !== null}
			<span class="block text-xs text-muted-foreground">
				следующее {formatDateTime(delivery.nextNotifyAt)}
			</span>
		{/if}
	</Table.Cell>
	<Table.Cell class="max-w-64 text-xs">
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
	<Table.Cell class="whitespace-nowrap">
		{#if canRetry}
			<form method="POST" action="?/retry" use:enhance>
				<input type="hidden" name="deliveryId" value={delivery.id} />
				<Button type="submit" size="sm" variant="outline">Повторить</Button>
			</form>
		{/if}
	</Table.Cell>
</Table.Row>
