<script lang="ts">
	import DateField from './date-field.svelte';
	import FormField from './form-field.svelte';

	/**
	 * Поле даты в форме: подпись, календарь, описание, ошибка. Привязывается
	 * прямо к стору superforms — `bind:value={$form.validFrom}`, — а отправляет
	 * `2026-09-12`, как и ждёт схема.
	 */
	let {
		name,
		label,
		description,
		errors,
		required = false,
		min,
		max,
		value = $bindable('')
	}: {
		name: string;
		label: string;
		description?: string;
		errors?: string[];
		required?: boolean;
		/** Границы выбора в том же виде, что и значение: `2026-09-12`. */
		min?: string;
		max?: string;
		value?: string;
	} = $props();
</script>

<FormField {name} {label} {description} {errors} {required}>
	{#snippet control({ id, describedBy, invalid })}
		<DateField {id} {name} {min} {max} {required} {describedBy} {invalid} bind:value />
	{/snippet}
</FormField>
