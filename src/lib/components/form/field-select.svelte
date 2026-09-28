<script lang="ts" module>
	/** One option of a select. `value` is what the form posts. */
	export type FieldOption = { value: string; label: string };
</script>

<script lang="ts">
	import * as Select from '$lib/components/ui/select/index.js';
	import FormField from './form-field.svelte';

	/**
	 * A field with a fixed list of options. The select posts its value through a
	 * hidden input, so the form works the same with and without JavaScript.
	 */
	let {
		name,
		label,
		description,
		errors,
		required = false,
		options,
		placeholder = 'Не выбрано',
		value = $bindable('')
	}: {
		name: string;
		label: string;
		description?: string;
		errors?: string[];
		required?: boolean;
		options: readonly FieldOption[];
		placeholder?: string;
		value?: string;
	} = $props();

	const selected = $derived(options.find((option) => option.value === value));
</script>

<FormField {name} {label} {description} {errors} {required}>
	{#snippet control({ id, describedBy, invalid })}
		<Select.Root type="single" {name} bind:value>
			<!-- Длинная подпись обрезается многоточием, а целиком видна в подсказке:
				без обрезки текст вылезает из поля поверх соседнего. -->
			<Select.Trigger
				{id}
				class="w-full min-w-0"
				title={selected?.label}
				aria-invalid={invalid}
				aria-describedby={describedBy}
			>
				<span class="min-w-0 truncate">{selected?.label ?? placeholder}</span>
			</Select.Trigger>
			<Select.Content>
				{#each options as option (option.value)}
					<Select.Item value={option.value} label={option.label} />
				{/each}
			</Select.Content>
		</Select.Root>
	{/snippet}
</FormField>
