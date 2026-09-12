<script lang="ts">
	import type { HTMLInputTypeAttribute } from 'svelte/elements';
	import { Input } from '$lib/components/ui/input/index.js';
	import FormField from './form-field.svelte';

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
		/**
		 * `file` and `date` are not supported here: the browser draws both of
		 * them itself, in its own language, so each has its own component —
		 * `FileInput` and `FieldDate`.
		 */
		type?: Exclude<HTMLInputTypeAttribute, 'file' | 'date'>;
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
