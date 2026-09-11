<script lang="ts">
	import LoaderIcon from '@lucide/svelte/icons/loader-2';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';

	/**
	 * The last stop before something irreversible. Bind `open`, say in the title
	 * what will happen and in `confirmLabel` name the act ("Удалить документ"),
	 * never "OK". The dialog stays open while `onconfirm` runs and closes only
	 * once it resolves, so a slow request cannot be fired twice; a rejected
	 * promise leaves the dialog open with the buttons live again.
	 */
	let {
		open = $bindable(false),
		title,
		description,
		confirmLabel = 'Подтвердить',
		cancelLabel = 'Отмена',
		tone = 'default',
		onconfirm
	}: {
		open?: boolean;
		title: string;
		description?: string;
		confirmLabel?: string;
		cancelLabel?: string;
		/** `danger` for anything that destroys data. */
		tone?: 'default' | 'danger';
		onconfirm: () => void | Promise<void>;
	} = $props();

	let pending = $state(false);

	async function confirm() {
		pending = true;
		try {
			await onconfirm();
			open = false;
		} finally {
			pending = false;
		}
	}
</script>

<AlertDialog.Root bind:open>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{title}</AlertDialog.Title>
			{#if description}
				<AlertDialog.Description>{description}</AlertDialog.Description>
			{/if}
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={pending}>{cancelLabel}</AlertDialog.Cancel>
			<Button
				variant={tone === 'danger' ? 'destructive' : 'default'}
				disabled={pending}
				onclick={confirm}
			>
				{#if pending}
					<LoaderIcon class="animate-spin" aria-hidden="true" />
				{/if}
				{confirmLabel}
			</Button>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
