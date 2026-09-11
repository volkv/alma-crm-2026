<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Label } from '$lib/components/ui/label/index.js';

	/**
	 * The frame around one form control: its label, the explanation under it, and
	 * the error the server or the schema produced. It owns the wiring a control
	 * needs to be accessible — the id the label points at, `aria-describedby`
	 * covering both description and error, and `aria-invalid` — and hands it to
	 * the control through the `control` snippet, so no field can forget it.
	 *
	 * Use `FieldInput`, `FieldTextarea` or `FieldSelect` for the ordinary cases;
	 * reach for this directly only when the control is something else.
	 */
	let {
		name,
		label,
		description,
		errors,
		required = false,
		control
	}: {
		/** The field name in the form; also the id of the control. */
		name: string;
		label: string;
		/** What the field means, when the label alone is not enough. */
		description?: string;
		/** Messages for this field, in Russian, as superforms reports them. */
		errors?: string[];
		required?: boolean;
		control: Snippet<[{ id: string; describedBy: string | undefined; invalid: boolean }]>;
	} = $props();

	const invalid = $derived((errors?.length ?? 0) > 0);
	const describedBy = $derived(
		[description ? `${name}-description` : null, invalid ? `${name}-error` : null]
			.filter((id) => id !== null)
			.join(' ') || undefined
	);
</script>

<div class="flex flex-col gap-1.5" data-slot="form-field">
	<Label for={name}>
		{label}
		{#if required}
			<span class="text-danger" aria-hidden="true">*</span>
			<span class="sr-only">обязательное поле</span>
		{/if}
	</Label>

	{@render control({ id: name, describedBy, invalid })}

	{#if description}
		<p id="{name}-description" class="text-xs text-muted-foreground">{description}</p>
	{/if}

	{#if errors}
		{#each errors as message (message)}
			<p id="{name}-error" class="text-xs text-danger-soft-foreground">{message}</p>
		{/each}
	{/if}
</div>
