<script lang="ts">
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleXIcon from '@lucide/svelte/icons/circle-x';
	import { enhance } from '$app/forms';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
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
	let {
		closing,
		revision
	}: {
		closing: InteractionClosingView;
		/**
		 * Редакция процесса, с которой отрисована карточка. Едет с обеими формами:
		 * приговор о закрытии считан по финальной стадии этой редакции, и по
		 * изменившемуся процессу сервер откажет, а не закроет запись вслепую.
		 */
		revision: number;
	} = $props();

	let completeOpen = $state(false);
	let cancelOpen = $state(false);
</script>

<div class="flex flex-col gap-2 border-t border-border pt-2">
	<div class="flex flex-col gap-1">
		<Button
			type="button"
			size="sm"
			variant="outline"
			class="w-full min-w-0 justify-start"
			disabled={!closing.complete.allowed}
			onclick={() => (completeOpen = true)}
		>
			<CircleCheckIcon aria-hidden="true" />
			Завершить
		</Button>
		{#if !closing.complete.allowed}
			<p class="text-xs text-muted-foreground">{closing.complete.reasons.join('; ')}</p>
		{/if}
	</div>

	<div class="flex flex-col gap-1">
		<Button
			type="button"
			size="sm"
			variant="outline"
			class="w-full min-w-0 justify-start"
			disabled={!closing.cancel.allowed}
			onclick={() => (cancelOpen = true)}
		>
			<CircleXIcon aria-hidden="true" />
			Отменить
		</Button>
		{#if !closing.cancel.allowed}
			<p class="text-xs text-muted-foreground">{closing.cancel.reasons.join('; ')}</p>
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
			<input type="hidden" name="revision" value={revision} />

			{#if closing.complete.requiresForce}
				<input type="hidden" name="force" value="true" />
			{/if}

			<div class="flex flex-col gap-1.5">
				<Label for="completeSummary">
					Итог{closing.complete.requiresForce ? '' : ' (необязательно)'}
				</Label>
				<Textarea
					id="completeSummary"
					name="summary"
					rows={3}
					required={closing.complete.requiresForce}
					placeholder="Чем кончилось взаимодействие"
				/>
			</div>

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
			<input type="hidden" name="revision" value={revision} />

			<div class="flex flex-col gap-1.5">
				<Label for="cancelReason">Причина</Label>
				<Textarea
					id="cancelReason"
					name="reason"
					rows={3}
					required
					placeholder="Почему работа прекращается"
				/>
			</div>

			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (cancelOpen = false)}>
					Не отменять
				</Button>
				<Button type="submit">Отменить взаимодействие</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
