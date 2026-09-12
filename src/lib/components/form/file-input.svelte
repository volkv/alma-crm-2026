<script lang="ts">
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';

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
		required = false
	}: {
		/** Идентификатор контрола; он же имя поля формы, если имя не задано. */
		id: string;
		name?: string;
		label: string;
		/** Что за файл ждут: форматы, размер, назначение. */
		description?: string;
		/** Отбор в диалоге выбора: `.pdf,.docx` или `application/pdf`. */
		accept?: string;
		required?: boolean;
	} = $props();

	let chosen = $state<string | null>(null);

	function pick(event: Event & { currentTarget: HTMLInputElement }) {
		chosen = event.currentTarget.files?.[0]?.name ?? null;
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
			Выбрать файл
		</label>
		<input
			{id}
			{name}
			{accept}
			{required}
			type="file"
			class="sr-only"
			aria-labelledby="{id}-label"
			aria-describedby={description ? `${id}-description` : undefined}
			onchange={pick}
		/>
		<span
			class="min-w-0 flex-1 truncate text-sm {chosen === null ? 'text-muted-foreground' : ''}"
			title={chosen ?? undefined}
		>
			{chosen ?? 'Файл не выбран'}
		</span>
	</div>

	{#if description}
		<p id="{id}-description" class="text-xs text-muted-foreground">{description}</p>
	{/if}
</div>
