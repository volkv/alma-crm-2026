<script lang="ts">
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { pluralize } from '$lib/format';

	/**
	 * Выбор файла.
	 *
	 * Надписи на нативном `<input type="file">` рисует браузер, и перевести их
	 * нельзя: в русском интерфейсе получается «Choose File · No file chosen».
	 * Поэтому сам инпут спрятан с экрана, но не выключен — он получает фокус с
	 * клавиатуры, проверяется браузером и уходит в форму как обычно, — а видимое
	 * собрано из подписи-кнопки и названия выбранного файла.
	 */
	let {
		id,
		name = id,
		label,
		description,
		accept,
		multiple = false,
		required = false,
		onchoose
	}: {
		/** Идентификатор контрола; он же имя поля формы, если имя не задано. */
		id: string;
		name?: string;
		label: string;
		/** Что за файл ждут: форматы, размер, назначение. */
		description?: string;
		/** Отбор в диалоге выбора: `.pdf,.docx` или `application/pdf`. */
		accept?: string;
		/** Несколько файлов за раз: вложения к переходу, а не один документ. */
		multiple?: boolean;
		required?: boolean;
		/**
		 * Что выбрано: имена файлов после каждого выбора. Нужно форме, которая
		 * считает выбранный файл несохранённым вводом и спрашивает о нём перед
		 * закрытием слоя.
		 */
		onchoose?: (names: readonly string[]) => void;
	} = $props();

	let chosen = $state<string[]>([]);

	/**
	 * Один файл виден по имени, несколько — числом: десять имён в строку не
	 * помещаются, а «сколько выбрано» это ровно то, что проверяют глазами перед
	 * отправкой.
	 */
	const summary = $derived(
		chosen.length === 0
			? 'Файл не выбран'
			: chosen.length === 1
				? chosen[0]
				: pluralize(chosen.length, ['файл', 'файла', 'файлов'])
	);

	function pick(event: Event & { currentTarget: HTMLInputElement }) {
		chosen = Array.from(event.currentTarget.files ?? [], (file) => file.name);
		onchoose?.(chosen);
	}
</script>

<div class="flex flex-col gap-1.5" data-slot="file-input">
	<Label id="{id}-label" for={id}>
		{label}
		{#if required}
			<span class="text-danger" aria-hidden="true">*</span>
			<span class="sr-only">обязательное поле</span>
		{/if}
	</Label>

	<div
		class="flex h-control items-center gap-2 rounded-md border border-input bg-background pr-2 pl-1 has-[input:focus-visible]:border-ring has-[input:focus-visible]:ring-3 has-[input:focus-visible]:ring-ring/50"
	>
		<!-- Подпись-кнопка и есть кнопка: `label for` открывает диалог выбора без
			единой строки скрипта, поэтому контрол работает и до гидратации. Имя
			инпуту даёт подпись поля, а не она, — отсюда `aria-labelledby`. -->
		<label for={id} class={buttonVariants({ variant: 'outline', size: 'sm' })}>
			<PaperclipIcon aria-hidden="true" />
			{multiple ? 'Выбрать файлы' : 'Выбрать файл'}
		</label>
		<input
			{id}
			{name}
			{accept}
			{multiple}
			{required}
			type="file"
			class="sr-only"
			aria-labelledby="{id}-label"
			aria-describedby={description ? `${id}-description` : undefined}
			onchange={pick}
		/>
		<span
			class="min-w-0 flex-1 truncate text-sm {chosen.length === 0 ? 'text-muted-foreground' : ''}"
			title={chosen.length === 0 ? undefined : chosen.join(', ')}
		>
			{summary}
		</span>
	</div>

	{#if description}
		<p id="{id}-description" class="text-xs text-muted-foreground">{description}</p>
	{/if}
</div>
