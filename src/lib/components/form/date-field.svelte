<script lang="ts">
	import { untrack } from 'svelte';
	import { parseDate, type DateValue } from '@internationalized/date';
	import CalendarIcon from '@lucide/svelte/icons/calendar';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Calendar } from '$lib/components/ui/calendar/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Popover from '$lib/components/ui/popover/index.js';
	import { formatDate, parseRuDay } from '$lib/format';

	/**
	 * Календарная дата.
	 *
	 * Нативный `<input type="date">` рисует браузер: по-английски, порядком
	 * полей своей локали (`mm/dd/yyyy` на машине с американскими настройками) и
	 * со своим календарём, не похожим ни на один слой продукта. Дату здесь
	 * пишут и читают как `12.09.2026`, а календарь — тот же `Popover`, что и у
	 * остальных всплывающих слоёв.
	 *
	 * Наружу поле отдаёт `2026-09-12` — вид, в котором дату хранят схемы и база;
	 * форма получает его скрытым полем, поэтому отправка не зависит от того, что
	 * набрано в видимом поле. Недописанная дата значения не имеет: пока в поле
	 * не наберётся целый день, значение пустое, а не вчерашнее.
	 */
	let {
		id,
		name,
		value = $bindable(''),
		min,
		max,
		disabled = false,
		required = false,
		describedBy,
		invalid = false,
		class: className,
		onchange
	}: {
		/** Идентификатор видимого поля; на него указывает подпись. */
		id: string;
		/** Имя поля формы; без него поле ничего не отправляет. */
		name?: string;
		/** Дата как `2026-09-12`; пустая строка — даты нет. */
		value?: string;
		/** Границы выбора в том же виде, что и значение. */
		min?: string;
		max?: string;
		disabled?: boolean;
		required?: boolean;
		describedBy?: string;
		invalid?: boolean;
		class?: string;
		/** Вызывается, когда дата действительно изменилась. */
		onchange?: (value: string) => void;
	} = $props();

	/** То, что набрано в поле: `12.09.2026`, недописанная дата или пустота. */
	let text = $state(value === '' ? '' : formatDate(value));
	let open = $state(false);

	/**
	 * Значение меняется и снаружи — загрузкой страницы, сбросом формы, вторым
	 * полем периода. Пока человек печатает, снаружи приходит ровно то, что он
	 * набрал, и текст остаётся нетронутым.
	 */
	$effect(() => {
		const incoming = value;

		untrack(() => {
			if ((parseRuDay(text) ?? '') !== incoming) {
				text = incoming === '' ? '' : formatDate(incoming);
			}
		});
	});

	const selected = $derived<DateValue | undefined>(value === '' ? undefined : parseDate(value));
	const minValue = $derived<DateValue | undefined>(min ? parseDate(min) : undefined);
	const maxValue = $derived<DateValue | undefined>(max ? parseDate(max) : undefined);

	function commit(next: string) {
		if (next === value) {
			return;
		}

		value = next;
		onchange?.(next);
	}

	function type(event: Event & { currentTarget: HTMLInputElement }) {
		text = event.currentTarget.value;
		commit(parseRuDay(text) ?? '');
	}

	/** Уход из поля приводит написанное к значению: половина даты — не дата. */
	function normalize() {
		text = value === '' ? '' : formatDate(value);
	}

	function pick(next: DateValue | undefined) {
		if (next === undefined) {
			return;
		}

		commit(next.toString());
		open = false;
	}

	function clear() {
		commit('');
		text = '';
	}
</script>

<div class="flex items-center gap-1 {className ?? ''}" data-slot="date-field">
	<!-- `defaultValue` рядом со значением — не дубль: сброс формы (его делает
		`use:enhance` после успешного действия) возвращает полям то, что записано в
		атрибуте, а не то, что стоит в свойстве. Без него дата после сохранения
		пропала бы с экрана, оставшись в данных. -->
	{#if name}
		<input type="hidden" {name} {value} defaultValue={value} />
	{/if}

	<div class="relative min-w-0 flex-1">
		<Input
			{id}
			{disabled}
			{required}
			value={text}
			defaultValue={text}
			class={value === '' ? undefined : 'pr-8'}
			inputmode="numeric"
			maxlength={10}
			autocomplete="off"
			placeholder="дд.мм.гггг"
			aria-invalid={invalid}
			aria-describedby={describedBy}
			oninput={type}
			onblur={normalize}
		/>
		{#if value !== '' && !disabled}
			<Button
				variant="ghost"
				size="icon-xs"
				class="absolute top-1/2 right-1 -translate-y-1/2"
				aria-label="Очистить дату"
				onclick={clear}
			>
				<XIcon aria-hidden="true" />
			</Button>
		{/if}
	</div>

	<Popover.Root bind:open>
		<Popover.Trigger>
			{#snippet child({ props })}
				<Button {...props} variant="outline" size="icon" {disabled} aria-label="Открыть календарь">
					<CalendarIcon aria-hidden="true" />
				</Button>
			{/snippet}
		</Popover.Trigger>
		<Popover.Content class="w-auto p-0" align="start">
			<Calendar
				type="single"
				value={selected}
				{minValue}
				{maxValue}
				onValueChange={pick}
				weekdayFormat="short"
			/>
		</Popover.Content>
	</Popover.Root>
</div>
