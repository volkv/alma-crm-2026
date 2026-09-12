<script lang="ts">
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleXIcon from '@lucide/svelte/icons/circle-x';
	import { enhance } from '$app/forms';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { actionEnhance } from '$lib/components/interactions/action-enhance';
	import type { InteractionClosingView } from '$lib/contracts/interactions';

	/**
	 * Закрытие взаимодействия: завершение и отмена.
	 *
	 * Обе команды спрашивают текст в диалоге, потому что обе оставляют след в
	 * истории: «завершено» без единого слова об итоге и «отменено» без причины
	 * через месяц не объяснят ничего. Приговор считает сервер — кнопка остаётся
	 * на экране и с объяснением, почему она недоступна.
	 */
	let { closing }: { closing: InteractionClosingView } = $props();

	let completeOpen = $state(false);
	let cancelOpen = $state(false);
</script>

<div class="flex flex-col gap-2 border-t border-border pt-2">
	<div class="flex flex-col gap-1" title={closing.complete.reasons.join('; ')}>
		<Button
			type="button"
			size="sm"
			variant="outline"
			class="w-full min-w-0"
			disabled={!closing.complete.allowed}
			onclick={() => (completeOpen = true)}
		>
			<CircleCheckIcon aria-hidden="true" />
			<span class="truncate">Завершить</span>
		</Button>
		{#if !closing.complete.allowed}
			<p class="text-xs text-muted-foreground">{closing.complete.reasons[0]}</p>
		{/if}
	</div>

	<div class="flex flex-col gap-1" title={closing.cancel.reasons.join('; ')}>
		<Button
			type="button"
			size="sm"
			variant="outline"
			class="w-full min-w-0"
			disabled={!closing.cancel.allowed}
			onclick={() => (cancelOpen = true)}
		>
			<CircleXIcon aria-hidden="true" />
			<span class="truncate">Отменить</span>
		</Button>
		{#if !closing.cancel.allowed}
			<p class="text-xs text-muted-foreground">{closing.cancel.reasons[0]}</p>
		{/if}
	</div>
</div>

<Dialog.Root bind:open={completeOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Завершить взаимодействие</Dialog.Title>
			<Dialog.Description>
				{#if closing.complete.requiresForce}
					Взаимодействие не дошло до последней стадии маршрута: закрытие будет досрочным, и итог
					обязателен.
				{:else}
					Текущая стадия закроется, новых команд по стадиям не будет. Итог останется в истории.
				{/if}
			</Dialog.Description>
		</Dialog.Header>

		<form
			method="POST"
			action="?/complete"
			use:enhance={actionEnhance({ onsuccess: () => (completeOpen = false) })}
			class="flex flex-col gap-4"
		>
			{#if closing.complete.requiresForce}
				<input type="hidden" name="force" value="true" />
			{/if}

			<label class="flex flex-col gap-1.5 text-sm">
				<span>Итог{closing.complete.requiresForce ? '' : ' (необязательно)'}</span>
				<Textarea
					name="summary"
					rows={3}
					required={closing.complete.requiresForce}
					placeholder="Чем кончилось взаимодействие"
				/>
			</label>

			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (completeOpen = false)}>
					Отмена
				</Button>
				<Button type="submit">Завершить</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={cancelOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Отменить взаимодействие</Dialog.Title>
			<Dialog.Description>
				Работа по нему прекращается на текущей стадии. Причина попадёт в историю.
			</Dialog.Description>
		</Dialog.Header>

		<form
			method="POST"
			action="?/cancel"
			use:enhance={actionEnhance({ onsuccess: () => (cancelOpen = false) })}
			class="flex flex-col gap-4"
		>
			<label class="flex flex-col gap-1.5 text-sm">
				<span>Причина</span>
				<Textarea name="reason" rows={3} required placeholder="Почему работа прекращается" />
			</label>

			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (cancelOpen = false)}>
					Не отменять
				</Button>
				<Button type="submit">Отменить взаимодействие</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
