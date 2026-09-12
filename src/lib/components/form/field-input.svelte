<script lang="ts">
	import { Input } from '$lib/components/ui/input/index.js';
	import FormField from './form-field.svelte';

	/**
	 * Виды ввода, которые браузер рисует одинаковой однострочной клеткой и
	 * отличает только клавиатурой и проверкой: их и принимает поле.
	 *
	 * Перечисление здесь закрытое, а не `Exclude<HTMLInputTypeAttribute, …>`:
	 * тип атрибута из `svelte/elements` заканчивается на `(string & {})` ради
	 * подсказок редактора, и вычитание из него ничего не запрещает — `date`,
	 * `file`, `checkbox` и `range` проезжали в него как обычные строки. У даты,
	 * файла и выбора свои контролы (`FieldDate`, `FileInput`, `FieldSelect`):
	 * нативные браузер рисует сам, своими надписями по-английски.
	 */
	type FieldInputType = 'text' | 'email' | 'tel' | 'url' | 'search' | 'number' | 'password';

	/**
	 * A single-line field: label, control, description, error. Bind it straight
	 * to the superforms store — `bind:value={$form.name} errors={$errors.name}`.
	 */
	let {
		name,
		label,
		description,
		errors,
		required = false,
		type = 'text',
		placeholder,
		value = $bindable('')
	}: {
		name: string;
		label: string;
		description?: string;
		errors?: string[];
		required?: boolean;
		type?: FieldInputType;
		placeholder?: string;
		value?: string;
	} = $props();
</script>

<FormField {name} {label} {description} {errors} {required}>
	{#snippet control({ id, describedBy, invalid })}
		<Input
			{id}
			{name}
			{type}
			{placeholder}
			bind:value
			aria-invalid={invalid}
			aria-describedby={describedBy}
		/>
	{/snippet}
</FormField>
