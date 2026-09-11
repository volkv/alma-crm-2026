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
		value = $bindable('')
	}: {
		name: string;
		label: string;
		description?: string;
		errors?: string[];
		required?: boolean;
		placeholder?: string;
		rows?: number;
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
			bind:value
			aria-invalid={invalid}
			aria-describedby={describedBy}
		/>
	{/snippet}
</FormField>
