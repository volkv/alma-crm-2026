<script lang="ts">
	import LoaderIcon from '@lucide/svelte/icons/loader-2';
	import { Button } from '$lib/components/ui/button/index.js';

	/**
	 * The bar that closes a form. It keeps the submit button in one place across
	 * the product and blocks a second submit while the first is in flight — the
	 * commonest way to create a duplicate record.
	 */
	let {
		submitting = false,
		submitLabel = 'Сохранить',
		cancelLabel = 'Отмена',
		oncancel
	}: {
		/** `$submitting` from superforms. */
		submitting?: boolean;
		/** Name the act: "Создать организацию" beats "Сохранить". */
		submitLabel?: string;
		cancelLabel?: string;
		/** Omit when there is nowhere to cancel to. */
		oncancel?: () => void;
	} = $props();
</script>

<div
	class="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4"
	data-slot="form-actions"
>
	{#if oncancel}
		<Button type="button" variant="outline" disabled={submitting} onclick={oncancel}>
			{cancelLabel}
		</Button>
	{/if}
	<Button type="submit" disabled={submitting}>
		{#if submitting}
			<LoaderIcon class="animate-spin" aria-hidden="true" />
		{/if}
		{submitLabel}
	</Button>
</div>
