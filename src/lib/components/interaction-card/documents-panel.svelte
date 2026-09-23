<script lang="ts">
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { DOCUMENT_STATUS_FACT_LABELS, documentKindLabel } from '$lib/contracts/documents';
	import type { InteractionDocumentView } from '$lib/contracts/interactions';
	import ContextSection from './context-section.svelte';
	import { mockAction } from './mock';

	/**
	 * Документы дела — какие есть сейчас и в каком они состоянии. Когда и кем
	 * документ добавлен или отмечен — это событие, и оно живёт в ленте; здесь
	 * только нынешнее положение: вид и последняя отметка.
	 */
	let { documents }: { documents: readonly InteractionDocumentView[] } = $props();

	/** Последняя отметка документа: введён в действие старше утверждения, оно — согласования. */
	function lastMark(document: InteractionDocumentView) {
		if (document.inEffectAt !== null) return DOCUMENT_STATUS_FACT_LABELS.in_effect;
		if (document.approvedAt !== null) return DOCUMENT_STATUS_FACT_LABELS.approved;
		if (document.agreedAt !== null) return DOCUMENT_STATUS_FACT_LABELS.agreed;

		return null;
	}
</script>

<ContextSection title="Документы">
	{#snippet action()}
		<Button size="xs" variant="outline" onclick={() => mockAction('Загрузить документ')}>
			<UploadIcon aria-hidden="true" />
			Загрузить
		</Button>
	{/snippet}

	{#if documents.length === 0}
		<p class="text-sm text-muted-foreground">Документов пока нет.</p>
	{:else}
		<ul class="flex flex-col gap-2">
			{#each documents as document (document.id)}
				{@const mark = lastMark(document)}
				<li class="flex items-start gap-2">
					<FileTextIcon class="mt-0.5 size-4 shrink-0 text-faint" aria-hidden="true" />
					<div class="min-w-0 flex-1">
						<p class="text-sm break-words">{document.title}</p>
						<div class="flex flex-wrap items-center gap-1.5">
							<span class="text-xs text-muted-foreground">{documentKindLabel(document.kind)}</span>
							{#if mark !== null}
								<StatusBadge tone="success">{mark}</StatusBadge>
							{/if}
						</div>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</ContextSection>
