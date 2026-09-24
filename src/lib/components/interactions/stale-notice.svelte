<script lang="ts">
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { tick } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { Button } from '$lib/components/ui/button/index.js';
	import { inlineHintVariants } from '$lib/components/inline-hint.svelte';

	/**
	 * Отказ «запись изменил другой» внутри диалога: сообщение сервера и кнопка
	 * «Обновить карточку».
	 *
	 * Кнопка только перечитывает карточку и ничего не отправляет: введённое
	 * остаётся в форме, а решение сохранить поверх свежей записи человек
	 * принимает сам, ещё одним нажатием. Автоматический повтор затёр бы ровно ту
	 * правку, о которой отказ предупредил.
	 */
	let {
		message,
		onrefreshed
	}: {
		message: string;
		/** Карточка перечитана: форма переносит свою версию и нетронутые поля на свежую запись. */
		onrefreshed: () => void;
	} = $props();

	let refreshing = $state(false);

	async function refresh() {
		refreshing = true;

		try {
			await invalidateAll();
			await tick();
			onrefreshed();
		} finally {
			refreshing = false;
		}
	}
</script>

<div
	role="alert"
	class={inlineHintVariants({ tone: 'warning', class: 'flex-wrap items-center' })}
	data-testid="stale-notice"
>
	<TriangleAlertIcon class="size-3.5 shrink-0" aria-hidden="true" />
	<span class="min-w-0 flex-1 basis-48">{message}</span>
	<Button type="button" variant="outline" size="sm" disabled={refreshing} onclick={refresh}>
		Обновить карточку
	</Button>
</div>
