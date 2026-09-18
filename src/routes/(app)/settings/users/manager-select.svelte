<script lang="ts">
	import { tick } from 'svelte';
	import * as Select from '$lib/components/ui/select/index.js';

	/**
	 * Руководитель сотрудника — выбором из списка, без кнопки «Сохранить».
	 *
	 * Выбор руководителя — одно действие, и отдельная кнопка рядом с каждой
	 * строкой только добавила бы шаг. Поэтому смена значения отправляет форму
	 * сама, как это делал нативный список до перехода на наш контрол.
	 *
	 * Значение уходит скрытым полем: список рисуем мы, а форме нужен обычный
	 * `input`, — и отправка ждёт `tick()`, иначе запрос уйдёт с прежним
	 * значением, которое Svelte ещё не успел записать в разметку.
	 */
	let {
		userId,
		fullName,
		managerUserId,
		options,
		disabled = false
	}: {
		userId: string;
		/** Имя сотрудника: из него собрана подпись списка. */
		fullName: string;
		managerUserId: string | null;
		options: readonly { id: string; fullName: string }[];
		disabled?: boolean;
	} = $props();

	/**
	 * Значение пункта «руководителя нет». Пустая строка тут не годится: для
	 * списка она означает «ничего не выбрано», и пункт стал бы неотличим от
	 * пустоты, — а в форму всё равно уходит пустая строка.
	 */
	const NONE = '__none';

	const PLACEHOLDER = '— не задан —';

	let form = $state<HTMLFormElement | null>(null);
	let value = $state(managerUserId ?? NONE);

	const label = $derived(options.find((option) => option.id === value)?.fullName ?? PLACEHOLDER);

	async function choose(next: string) {
		value = next;

		await tick();
		form?.requestSubmit();
	}
</script>

<form method="POST" action="?/manager" bind:this={form}>
	<input type="hidden" name="userId" value={userId} />
	<input type="hidden" name="managerUserId" value={value === NONE ? '' : value} />
	<Select.Root type="single" {value} {disabled} onValueChange={choose}>
		<Select.Trigger class="w-full" aria-label="Руководитель: {fullName}">{label}</Select.Trigger>
		<Select.Content>
			<Select.Item value={NONE} label={PLACEHOLDER} />
			{#each options as option (option.id)}
				<Select.Item value={option.id} label={option.fullName} />
			{/each}
		</Select.Content>
	</Select.Root>
</form>
