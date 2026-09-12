<script lang="ts">
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Sheet from '$lib/components/ui/sheet/index.js';
	import KeyValue from '$lib/components/key-value.svelte';
	import KeyValueRow from '$lib/components/key-value-row.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { formatDateTime } from '$lib/format';
	import type { AuditEventView } from '$lib/contracts/audit';
	import {
		AUDIT_EVENT_LABELS,
		AUDIT_OUTCOME_LABELS,
		AUDIT_OUTCOME_TONES,
		AUDIT_SOURCE_LABELS,
		detailLabel,
		subjectHref,
		subjectTypeLabel
	} from './labels';
	import { auditHref } from './filters';

	/**
	 * Одно событие целиком: то, что не поместилось в строку таблицы, — адрес,
	 * клиент, идентификатор запроса и подробности. Подробности показываются как
	 * есть: в них по правилу живут только ссылки на записи и имена изменённых
	 * полей, поэтому расшифровывать там нечего.
	 */
	let {
		event,
		url,
		open = $bindable(false)
	}: {
		/** `null`, пока ни одна строка не открыта. */
		event: AuditEventView | null;
		/** Адрес страницы: из него собираются ссылки «показать только это». */
		url: URL;
		open?: boolean;
	} = $props();

	const details = $derived(Object.entries(event?.details ?? {}));
	const link = $derived(
		event?.subjectType && event.subjectId ? subjectHref(event.subjectType, event.subjectId) : null
	);

	/** Значение подробности в том виде, в каком его можно прочитать. */
	function detailValue(value: unknown): string {
		if (Array.isArray(value)) {
			return value.join(', ');
		}

		if (typeof value === 'boolean') {
			return value ? 'да' : 'нет';
		}

		return String(value);
	}
</script>

<Sheet.Root bind:open>
	<Sheet.Content side="right" class="w-full gap-0 overflow-y-auto sm:max-w-md">
		{#if event}
			<Sheet.Header class="border-b border-border">
				<Sheet.Title>{AUDIT_EVENT_LABELS[event.eventType]}</Sheet.Title>
				<Sheet.Description>
					{formatDateTime(event.occurredAt)} · {AUDIT_SOURCE_LABELS[event.source]}
				</Sheet.Description>
			</Sheet.Header>

			<div class="flex flex-col gap-5 p-4">
				<KeyValue columns={2}>
					<KeyValueRow label="Результат">
						<StatusBadge tone={AUDIT_OUTCOME_TONES[event.outcome]}>
							{AUDIT_OUTCOME_LABELS[event.outcome]}
						</StatusBadge>
					</KeyValueRow>
					<KeyValueRow label="Код события" value={event.eventType} />
					<KeyValueRow label="Кто действовал" value={event.actorLabel} />
					<KeyValueRow label="Адрес" value={event.ip} />
					<KeyValueRow label="Идентификатор запроса" value={event.requestId} />
					<KeyValueRow label="Ключ доступа" value={event.apiKeyId} />
					<KeyValueRow label="Клиент" value={event.userAgent} />
					<KeyValueRow label="Над чем">
						{#if event.subjectType === null}
							<span class="text-faint">—</span>
						{:else}
							<span>{subjectTypeLabel(event.subjectType)}</span>
							{#if link}
								<a class="ml-1 inline-flex items-center gap-1 text-primary focus-ring" href={link}>
									Открыть карточку
									<ExternalLinkIcon class="size-3" aria-hidden="true" />
								</a>
							{/if}
						{/if}
					</KeyValueRow>
				</KeyValue>

				<section class="flex flex-col gap-2">
					<h3 class="text-xs font-medium text-muted-foreground">Подробности</h3>
					{#if details.length === 0}
						<p class="text-sm text-faint">Событие записано без подробностей</p>
					{:else}
						<KeyValue columns={1}>
							{#each details as [key, value] (key)}
								<KeyValueRow label={detailLabel(key)} value={detailValue(value)} />
							{/each}
						</KeyValue>
					{/if}
				</section>

				<div class="flex flex-wrap gap-2 border-t border-border pt-4">
					<Button
						variant="outline"
						size="sm"
						href={auditHref(url, { type: [event.eventType] })}
						onclick={() => (open = false)}
					>
						Только такие события
					</Button>
					{#if event.actorUserId !== null}
						<Button
							variant="outline"
							size="sm"
							href={auditHref(url, { actor: event.actorUserId })}
							onclick={() => (open = false)}
						>
							Только этот человек
						</Button>
					{/if}
					{#if event.subjectType !== null && event.subjectId !== null}
						<Button
							variant="outline"
							size="sm"
							href={auditHref(url, { subjectType: event.subjectType, subject: event.subjectId })}
							onclick={() => (open = false)}
						>
							Только эта запись
						</Button>
					{/if}
				</div>
			</div>
		{/if}
	</Sheet.Content>
</Sheet.Root>
