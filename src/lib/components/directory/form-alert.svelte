<script lang="ts">
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { DirectoryMessage } from './messages';

	/**
	 * Отказ, с которым форма вернулась с сервера. Ошибки отдельных полей
	 * показывает сам `FormField`; сюда попадает то, что относится к форме
	 * целиком, — занятый ИНН, отсутствующее право, изменившееся состояние.
	 */
	let {
		message,
		confirmLabel
	}: {
		message: DirectoryMessage | undefined;
		/** Кнопка «сделать всё равно» при похожих записях: форма уходит с подтверждением. */
		confirmLabel?: string;
	} = $props();
</script>

{#if message?.duplicates}
	<Alert.Root>
		<TriangleAlertIcon aria-hidden="true" />
		<Alert.Title>{message.text}</Alert.Title>
		<Alert.Description>
			<ul class="flex flex-col gap-1">
				{#each message.duplicates as duplicate (duplicate.href)}
					<li>
						<a class="underline underline-offset-2 focus-ring" href={duplicate.href}
							>{duplicate.label}</a
						>
						— {duplicate.reason}
					</li>
				{/each}
			</ul>
			{#if confirmLabel}
				<Button
					type="submit"
					variant="outline"
					size="sm"
					class="mt-2"
					name="confirmDuplicate"
					value="yes"
				>
					{confirmLabel}
				</Button>
			{/if}
		</Alert.Description>
	</Alert.Root>
{:else if message}
	<Alert.Root variant="destructive">
		<TriangleAlertIcon aria-hidden="true" />
		<Alert.Title>{message.text}</Alert.Title>
		{#if message.conflictsWith && message.conflictHref}
			<Alert.Description>
				<a class="underline underline-offset-2 focus-ring" href={message.conflictHref}>
					Открыть «{message.conflictsWith.label}»
				</a>
			</Alert.Description>
		{/if}
	</Alert.Root>
{/if}
