<script lang="ts">
	import DownloadIcon from '@lucide/svelte/icons/download';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import { DOCUMENT_KIND_LABELS } from '$lib/contracts/documents';
	import type { InteractionDocumentView } from '$lib/contracts/interactions';
	import { formatDate } from '$lib/format';
	import { getCardCommands } from './commands.svelte';
	import ContextSection from './context-section.svelte';

	/**
	 * Документ об обучении — итог дела с лицом. Отдельного поля у записи нет:
	 * это документ дела вида «Документ об обучении», и панель показывает такие
	 * документы, если они приложены.
	 */
	let {
		documents,
		canUpload
	}: {
		documents: readonly InteractionDocumentView[];
		canUpload: boolean;
	} = $props();

	const TRAINING_DOCUMENT_KIND = 'certificate';

	const commands = getCardCommands();
	const issued = $derived(documents.filter((document) => document.kind === TRAINING_DOCUMENT_KIND));
</script>

<ContextSection title="Документ об обучении">
	{#snippet action()}
		{#if canUpload && issued.length === 0}
			<Button size="xs" variant="outline" onclick={() => commands.open({ kind: 'upload' })}>
				<UploadIcon aria-hidden="true" />
				Приложить
			</Button>
		{/if}
	{/snippet}
	{#if issued.length === 0}
		<p class="text-sm text-muted-foreground">
			Не приложен: загрузите его с видом «{DOCUMENT_KIND_LABELS.certificate}».
		</p>
	{:else}
		<ul class="flex flex-col gap-1.5">
			{#each issued as document (document.id)}
				<li class="flex items-center justify-between gap-2">
					<span class="min-w-0">
						<a
							class="rounded-sm text-sm break-words underline-offset-4 focus-ring hover:underline"
							href={resolve('/(app)/documents/[id=uuid]', { id: document.id })}
						>
							{document.title}
						</a>
						<span class="block text-xs text-muted-foreground tabular-nums">
							{formatDate(document.createdAt)}
						</span>
					</span>
					<Button
						variant="ghost"
						size="icon-sm"
						href={resolve('/(app)/documents/[id=uuid]/download', { id: document.id })}
						data-sveltekit-reload
						aria-label="Скачать «{document.title}»"
						title="Скачать"
					>
						<DownloadIcon aria-hidden="true" />
					</Button>
				</li>
			{/each}
		</ul>
	{/if}
</ContextSection>
