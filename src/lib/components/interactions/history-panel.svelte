<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import type {
		InteractionChangeView,
		StageEntryView,
		StageOutcome
	} from '$lib/contracts/interactions';
	import { formatDateTime, pluralize } from '$lib/format';

	/**
	 * История взаимодействия: сколько простояли на каждой стадии, чем она
	 * кончилась и что правили в плане. Длительность показывается вместе с
	 * паузой — «две недели, из них неделю ждали вуз» и «две недели тишины» это
	 * разные истории.
	 */
	let {
		entries,
		changes
	}: {
		/** Записи стадий, новые сверху; открытая тоже здесь. */
		entries: readonly StageEntryView[];
		changes: readonly InteractionChangeView[];
	} = $props();

	const OUTCOME_LABELS: Record<StageOutcome, string> = {
		completed: 'пройдена',
		returned: 'возврат',
		skipped: 'пропуск вперёд'
	};

	const FIELD_LABELS: Record<string, string> = {
		title: 'Название',
		agreementPeriodStart: 'Соглашение: начало',
		agreementPeriodEnd: 'Соглашение: окончание',
		academicPeriodStart: 'Учебный период: начало',
		academicPeriodEnd: 'Учебный период: окончание',
		ownerUserId: 'Ответственный',
		parties: 'Участники',
		programs: 'Программы',
		products: 'Продукты'
	};

	const HOUR = 60 * 60;

	/** Часы в словах: до суток — часами, дальше — днями. */
	function duration(seconds: number): string {
		const rounded = Math.max(0, Math.round(seconds));

		if (rounded < HOUR) {
			return 'меньше часа';
		}

		if (rounded < 24 * HOUR) {
			return pluralize(Math.round(rounded / HOUR), ['час', 'часа', 'часов']);
		}

		return pluralize(Math.round(rounded / (24 * HOUR)), ['день', 'дня', 'дней']);
	}

	function describe(value: unknown): string {
		if (value === null || value === undefined) {
			return '—';
		}

		return typeof value === 'string' ? value : JSON.stringify(value);
	}
</script>

<div class="grid gap-4 lg:grid-cols-2">
	<Card.Root size="sm">
		<Card.Header>
			<Card.Title>Стадии</Card.Title>
		</Card.Header>
		<Card.Content class="flex flex-col gap-3">
			{#each entries as entry (entry.id)}
				<div class="flex flex-col gap-1 border-b border-border pb-3 last:border-0 last:pb-0">
					<div class="flex flex-wrap items-center gap-2">
						<span class="text-sm font-medium">
							{entry.snapshot.position}. {entry.snapshot.name}
						</span>
						{#if entry.outcome === null}
							<StatusBadge tone="accent" dot>текущая</StatusBadge>
						{:else}
							<StatusBadge tone={entry.outcome === 'completed' ? 'success' : 'warning'}>
								{OUTCOME_LABELS[entry.outcome]}
							</StatusBadge>
						{/if}
					</div>

					<p class="text-xs text-muted-foreground">
						с {formatDateTime(entry.enteredAt)}
						{entry.leftAt ? `по ${formatDateTime(entry.leftAt)}` : ''} · в работе {duration(
							entry.activeSeconds
						)}{entry.pausedSeconds > 0 ? `, на паузе ${duration(entry.pausedSeconds)}` : ''}
					</p>

					{#if entry.outcomeReason}
						<p class="text-xs">Причина: {entry.outcomeReason}</p>
					{/if}

					{#if entry.resultText}
						<p class="text-xs">Результат: {entry.resultText}</p>
					{/if}

					{#each entry.pauses as pause (pause.id)}
						<p class="text-xs text-faint">
							Пауза: {pause.note} ({formatDateTime(pause.startedAt)}{pause.endedAt
								? ` — ${formatDateTime(pause.endedAt)}`
								: ' — идёт'})
						</p>
					{/each}
				</div>
			{/each}
		</Card.Content>
	</Card.Root>

	<Card.Root size="sm">
		<Card.Header>
			<Card.Title>Правки плана</Card.Title>
		</Card.Header>
		<Card.Content class="flex flex-col gap-3">
			{#if changes.length === 0}
				<p class="text-sm text-muted-foreground">План не менялся.</p>
			{/if}

			{#each changes as change (change.id)}
				<div class="flex flex-col gap-0.5 border-b border-border pb-2 last:border-0 last:pb-0">
					<p class="text-sm">
						{FIELD_LABELS[change.field] ?? change.field}: {describe(change.oldValue)} → {describe(
							change.newValue
						)}
					</p>
					<p class="text-xs text-muted-foreground">
						{change.authorName} · {formatDateTime(change.changedAt)}
						{change.reason ? `· ${change.reason}` : ''}
					</p>
				</div>
			{/each}
		</Card.Content>
	</Card.Root>
</div>
