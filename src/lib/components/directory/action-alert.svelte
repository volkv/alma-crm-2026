<script lang="ts">
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { page } from '$app/state';
	import * as Alert from '$lib/components/ui/alert/index.js';

	/**
	 * Отказ действия, у которого нет формы: архивирование, закрытие полномочий.
	 * Такое действие отвечает через `toActionFailure`, то есть кладёт в
	 * `page.form` фразу и список претензий — их и показываем на карточке.
	 */
	const result = $derived(page.form as { message?: string; issues?: string[] } | null | undefined);
</script>

{#if result?.message}
	<Alert.Root variant="destructive">
		<TriangleAlertIcon aria-hidden="true" />
		<Alert.Title>{result.message}</Alert.Title>
		{#if result.issues && result.issues.length > 0}
			<Alert.Description>
				<ul class="list-inside list-disc">
					{#each result.issues as issue (issue)}
						<li>{issue}</li>
					{/each}
				</ul>
			</Alert.Description>
		{/if}
	</Alert.Root>
{/if}
