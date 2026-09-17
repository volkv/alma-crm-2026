<script lang="ts">
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import FormField from './form-field.svelte';

	/** A multi-line field. Same contract as `FieldInput`. */
	let {
		name,
		label,
		description,
		errors,
		required = false,
		placeholder,
		rows = 3,
		form,
		value = $bindable('')
	}: {
		name: string;
		label: string;
		description?: string;
		errors?: string[];
		required?: boolean;
		placeholder?: string;
		rows?: number;
		/**
		 * Идентификатор формы, если поле стоит вне неё. Так бывает у полей во
		 * всплывающем слое: его разметка уезжает в конец `<body>`, а
		 * принадлежит поле по-прежнему форме страницы.
		 */
		form?: string;
		value?: string;
	} = $props();
</script>

<FormField {name} {label} {description} {errors} {required}>
	{#snippet control({ id, describedBy, invalid })}
		<Textarea
			{id}
			{name}
			{rows}
			{placeholder}
			{form}
			bind:value
			aria-invalid={invalid}
			aria-describedby={describedBy}
		/>
	{/snippet}
</FormField>
