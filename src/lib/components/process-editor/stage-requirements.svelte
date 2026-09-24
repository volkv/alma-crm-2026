<script lang="ts">
	import BellIcon from '@lucide/svelte/icons/bell';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { DOCUMENT_STATUS_FACT_LABELS, DOCUMENT_TEMPLATE_LABELS } from '$lib/contracts/documents';
	import { LEARNING_PURPOSE_LABELS } from '$lib/contracts/exchange';
	import { STAGE_ENTER_NOTIFY_LABELS, type StageView } from '$lib/contracts/interactions';

	/**
	 * Что стадия требует на шаге вперёд и что делает при входе — пометками в
	 * строку. Уточнения требования («на каком документе», «итог каких групп»)
	 * стоят в той же пометке, что и само требование: отдельной строкой они
	 * читались как ещё одно условие.
	 */
	let { stage }: { stage: StageView } = $props();

	const lower = (text: string) => text.toLowerCase();

	/** Назначения групп, чей итог засчитывается; `null` — любого назначения. */
	const purposes = $derived(
		stage.lmsGroupPurposes === null
			? null
			: stage.lmsGroupPurposes.map((purpose) => lower(LEARNING_PURPOSE_LABELS[purpose])).join(', ')
	);

	const empty = $derived(
		!stage.requiresResult &&
			!stage.requiresConfirmation &&
			!stage.requiresLmsData &&
			stage.requiresDocumentMark === null &&
			stage.onEnterNotify === null
	);
</script>

<span class="flex flex-wrap gap-1">
	{#if stage.requiresResult}
		<StatusBadge tone="info">Результат</StatusBadge>
	{/if}
	{#if stage.requiresConfirmation}
		<StatusBadge tone="info">Подтверждение</StatusBadge>
	{/if}
	{#if stage.requiresLmsData}
		<StatusBadge
			tone="info"
			class="h-auto min-h-5 py-0.5 whitespace-normal"
			title={purposes === null
				? 'Засчитывается группа любого назначения'
				: `Засчитываются группы: ${purposes}`}
		>
			Данные обучения{purposes === null ? '' : `: ${purposes}`}
		</StatusBadge>
	{/if}
	{#if stage.requiresDocumentMark !== null}
		<StatusBadge tone="info" class="h-auto min-h-5 py-0.5 whitespace-normal">
			Отметка «{DOCUMENT_STATUS_FACT_LABELS[
				stage.requiresDocumentMark
			]}»{stage.requiresDocumentTemplate === null
				? ''
				: ` на документе: ${lower(DOCUMENT_TEMPLATE_LABELS[stage.requiresDocumentTemplate])}`}
		</StatusBadge>
	{/if}
	{#if stage.onEnterNotify !== null}
		<StatusBadge tone="neutral" title="Письмо при входе дела на стадию">
			<BellIcon class="size-3" aria-hidden="true" />
			Уведомит {lower(STAGE_ENTER_NOTIFY_LABELS[stage.onEnterNotify])}
		</StatusBadge>
	{/if}
	{#if empty}
		<span class="text-faint">—</span>
	{/if}
</span>
