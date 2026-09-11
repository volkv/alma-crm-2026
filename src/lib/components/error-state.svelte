<script lang="ts">
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import { Button } from '$lib/components/ui/button/index.js';
	import { cn } from '$lib/utils';

	/**
	 * What a section shows when it failed: what went wrong, the request id that
	 * ties the screen to the server log, and a way to try again. It never hides
	 * the failure behind an empty list — an empty result and a broken request
	 * mean different things to the person looking at them.
	 */
	let {
		title = 'Не удалось загрузить данные',
		description,
		requestId,
		onretry,
		class: className
	}: {
		title?: string;
		description?: string;
		/** `locals.requestId` of the failed request, shown so support can find it. */
		requestId?: string;
		/** Omit when there is nothing sensible to retry. */
		onretry?: () => void;
		class?: string;
	} = $props();
</script>

<div
	class={cn('flex flex-col items-center justify-center gap-3 px-6 py-12 text-center', className)}
	data-slot="error-state"
	role="alert"
>
	<span class="flex size-10 items-center justify-center rounded-full bg-danger-soft text-danger">
		<TriangleAlertIcon class="size-5" aria-hidden="true" />
	</span>
	<div class="space-y-1">
		<p class="text-sm font-medium">{title}</p>
		{#if description}
			<p class="mx-auto max-w-md text-sm text-muted-foreground">{description}</p>
		{/if}
		{#if requestId}
			<p class="text-xs text-faint">
				Код обращения: <span class="font-medium">{requestId}</span>
			</p>
		{/if}
	</div>
	{#if onretry}
		<Button variant="outline" onclick={onretry}>
			<RotateCcwIcon aria-hidden="true" />
			Повторить
		</Button>
	{/if}
</div>
