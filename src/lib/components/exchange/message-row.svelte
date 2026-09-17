<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import * as Table from '$lib/components/ui/table/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { formatDateTime } from '$lib/format';
	import {
		EXCHANGE_DIRECTION_LABELS,
		EXCHANGE_STATE_LABELS,
		RETRIABLE_STATES,
		type ExchangeMessageView
	} from '$lib/contracts/exchange';

	/**
	 * Одна строка журнала обмена.
	 *
	 * Кнопки не прячутся у чужих состояний, а просто отсутствуют там, где
	 * действие бессмысленно: повторить принятое входящее нельзя — его повторяет
	 * отправитель, а не мы.
	 */
	let { message }: { message: ExchangeMessageView } = $props();

	let dismissOpen = $state(false);

	const tone = $derived(
		message.state === 'failed'
			? 'danger'
			: message.state === 'sent' || message.state === 'processed'
				? 'success'
				: message.state === 'dismissed' || message.state === 'ignored_stale'
					? 'neutral'
					: 'warning'
	);

	const canRetry = $derived(
		message.direction === 'outbound' &&
			(RETRIABLE_STATES as readonly string[]).includes(message.state)
	);
</script>

<Table.Row>
	<Table.Cell class="whitespace-nowrap">{formatDateTime(message.createdAt)}</Table.Cell>
	<Table.Cell>{EXCHANGE_DIRECTION_LABELS[message.direction]}</Table.Cell>
	<Table.Cell class="font-mono text-xs">{message.system}:{message.instance}</Table.Cell>
	<Table.Cell class="font-mono text-xs">{message.eventType}</Table.Cell>
	<Table.Cell class="font-mono text-xs break-all">
		{message.externalId ?? '—'}
		<span class="block text-muted-foreground">{message.eventId}</span>
	</Table.Cell>
	<Table.Cell>
		<StatusBadge {tone} dot>{EXCHANGE_STATE_LABELS[message.state]}</StatusBadge>
	</Table.Cell>
	<Table.Cell class="whitespace-nowrap">
		{message.attempt}
		{#if message.nextAttemptAt !== null}
			<span class="block text-xs text-muted-foreground">
				повтор {formatDateTime(message.nextAttemptAt)}
			</span>
		{/if}
	</Table.Cell>
	<Table.Cell class="max-w-64 text-xs">
		{#if message.lastError !== null}
			<span class="text-danger-soft-foreground">{message.lastError}</span>
		{:else if message.responseStatus !== null}
			<span class="text-muted-foreground">ответ {message.responseStatus}</span>
		{:else}
			—
		{/if}
	</Table.Cell>
	<Table.Cell>
		{#if message.interactionId !== null}
			<a
				class="underline underline-offset-4"
				href={resolve('/(app)/interactions/[id=uuid]', { id: message.interactionId })}
			>
				{message.interactionTitle ?? 'Взаимодействие'}
			</a>
		{:else}
			—
		{/if}
	</Table.Cell>
	<Table.Cell class="whitespace-nowrap">
		<div class="flex gap-2">
			{#if canRetry}
				<form method="POST" action="?/retry" use:enhance>
					<input type="hidden" name="messageId" value={message.id} />
					<Button type="submit" size="sm" variant="outline">Повторить</Button>
				</form>
			{/if}
			{#if message.state === 'failed'}
				<Button size="sm" variant="ghost" onclick={() => (dismissOpen = true)}>
					Пометить обработанным
				</Button>
			{/if}
		</div>
	</Table.Cell>
</Table.Row>

<Dialog.Root bind:open={dismissOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Пометить сообщение обработанным</Dialog.Title>
			<Dialog.Description>
				Это признание «разобрано мимо системы», а не тихое удаление: причина останется в журнале
				обмена рядом с последней ошибкой.
			</Dialog.Description>
		</Dialog.Header>
		<form
			method="POST"
			action="?/dismiss"
			use:enhance={() => {
				return async ({ update }) => {
					dismissOpen = false;
					await update();
				};
			}}
			class="flex flex-col gap-3"
		>
			<input type="hidden" name="messageId" value={message.id} />
			<Label for="reason-{message.id}">Как разобрали</Label>
			<Textarea
				id="reason-{message.id}"
				name="reason"
				rows={3}
				required
				placeholder="Например: статус перенесён в CMS вручную"
			/>
			<div class="flex justify-end gap-2">
				<Button type="button" variant="outline" onclick={() => (dismissOpen = false)}>
					Отмена
				</Button>
				<Button type="submit">Пометить</Button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>
