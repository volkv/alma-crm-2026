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
	 *
	 * Журнал широкий, а экран рабочего ноутбука — 1280 точек, из которых на
	 * список остаётся около тысячи. Поэтому система обмена, ответ получателя и
	 * ссылка на взаимодействие до `2xl` стоят не своими колонками, а строкой под
	 * направлением, состоянием и событием: ключевые «когда — направление —
	 * событие — состояние» обязаны помещаться без горизонтальной прокрутки, а
	 * данные при этом не должны пропадать с экрана (`docs/design.md`, «Приоритет
	 * колонок»).
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

	/**
	 * Тип события по частям: `learning_group.requested` — одно слово в двадцать
	 * четыре знака, и в колонке оно не переносится нигде, распирая таблицу на
	 * рабочем экране. Перенос разрешён после точки (`<wbr>`) — там, где имя
	 * события и так читается как две части.
	 */
	const eventParts = $derived(message.eventType.split('.'));

	/**
	 * Ключ по частям: `crm-group-50d7922d-…-1` — одно слово в полсотни знаков, и
	 * `break-all` рвал его посреди шестнадцатеричной группы. Сверить такой ключ
	 * с ответом системы глазами невозможно, поэтому перенос разрешён только там,
	 * где ключ и так читается по частям — после `-`, `.` и `_`.
	 */
	const keyParts = (value: string) => value.split(/(?<=[-._])/);

	const canRetry = $derived(
		message.direction === 'outbound' &&
			(RETRIABLE_STATES as readonly string[]).includes(message.state)
	);
</script>

<!-- `<wbr>` после каждого разделителя: браузер переносит ключ по ним, а не
	посреди символов. -->
{#snippet key(value: string)}{#each keyParts(value) as part, index (index)}{part}<wbr
		/>{/each}{/snippet}

<Table.Row>
	<Table.Cell class="whitespace-normal">{formatDateTime(message.createdAt)}</Table.Cell>
	<Table.Cell class="whitespace-normal">
		{EXCHANGE_DIRECTION_LABELS[message.direction]}
		<span class="mt-0.5 block font-mono text-xs break-all text-muted-foreground 2xl:hidden">
			{message.system}:{message.instance}
		</span>
	</Table.Cell>
	<Table.Cell class="hidden font-mono text-xs 2xl:table-cell">
		{message.system}:{message.instance}
	</Table.Cell>
	<Table.Cell class="font-mono text-xs whitespace-normal">
		{#each eventParts as part, index (index)}{#if index > 0}.<wbr />{/if}{part}{/each}
		{#if message.interactionId !== null}
			<a
				class="mt-0.5 block max-w-40 font-sans whitespace-normal underline underline-offset-4 2xl:hidden"
				href={resolve('/(app)/interactions/[id=uuid]', { id: message.interactionId })}
			>
				{message.interactionTitle ?? 'Взаимодействие'}
			</a>
		{/if}
	</Table.Cell>
	<Table.Cell class="max-w-32 font-mono text-xs break-words whitespace-normal">
		{#if message.externalId === null}—{:else}{@render key(message.externalId)}{/if}
		<span class="block text-muted-foreground">{@render key(message.eventId)}</span>
	</Table.Cell>
	<Table.Cell>
		<StatusBadge {tone} dot>{EXCHANGE_STATE_LABELS[message.state]}</StatusBadge>
		{#if message.lastError !== null}
			<span
				class="mt-0.5 block max-w-40 text-xs whitespace-normal text-danger-soft-foreground 2xl:hidden"
			>
				{message.lastError}
			</span>
		{:else if message.responseStatus !== null}
			<span class="mt-0.5 block text-xs text-muted-foreground 2xl:hidden">
				ответ {message.responseStatus}
			</span>
		{/if}
	</Table.Cell>
	<Table.Cell class="whitespace-normal">
		{message.attempt}
		{#if message.nextAttemptAt !== null}
			<span class="block text-xs text-muted-foreground">
				повтор {formatDateTime(message.nextAttemptAt)}
			</span>
		{/if}
	</Table.Cell>
	<Table.Cell class="hidden max-w-64 text-xs whitespace-normal 2xl:table-cell">
		{#if message.lastError !== null}
			<span class="text-danger-soft-foreground">{message.lastError}</span>
		{:else if message.responseStatus !== null}
			<span class="text-muted-foreground">ответ {message.responseStatus}</span>
		{:else}
			—
		{/if}
	</Table.Cell>
	<Table.Cell class="hidden max-w-48 whitespace-normal 2xl:table-cell">
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
	<Table.Cell class="whitespace-normal">
		<div class="flex flex-wrap gap-2">
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
			class="flex flex-col gap-form"
		>
			<input type="hidden" name="messageId" value={message.id} />
			<div class="flex min-w-0 flex-col gap-field">
				<Label for="reason-{message.id}">Как разобрали</Label>
				<Textarea
					id="reason-{message.id}"
					name="reason"
					rows={3}
					required
					placeholder="Например: статус перенесён в CMS вручную"
				/>
			</div>
			<div class="flex justify-end gap-2">
				<Button type="button" variant="outline" onclick={() => (dismissOpen = false)}>
					Отмена
				</Button>
				<Button type="submit">Пометить</Button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>
