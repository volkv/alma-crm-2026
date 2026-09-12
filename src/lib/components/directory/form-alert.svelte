<script lang="ts">
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import type { DirectoryMessage } from './messages';

	/**
	 * Отказ, с которым форма вернулась с сервера. Ошибки отдельных полей
	 * показывает сам `FormField`; сюда попадает то, что относится к форме
	 * целиком, — занятый ИНН, отсутствующее право, изменившееся состояние.
	 */
	let { message }: { message: DirectoryMessage | undefined } = $props();
</script>

{#if message}
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
