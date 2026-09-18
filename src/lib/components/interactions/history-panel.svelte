<script lang="ts">
	import PencilIcon from '@lucide/svelte/icons/pencil-line';
	import * as Card from '$lib/components/ui/card/index.js';
	import EmptyState from '$lib/components/empty-state.svelte';
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
		skipped: 'пропуск вперёд',
		migrated: 'перенос при изменении процесса'
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

	/**
	 * Значение правки на экран. У ссылочных полей — ответственного, сторон,
	 * программ и продуктов — это подпись с именами, которую собрал сервер:
	 * идентификатор в истории ничего не объясняет и никуда не ведёт, поэтому
	 * рядом с подписью он не показывается вовсе.
	 */
	function describe(label: string | null, value: unknown): string {
		if (label !== null) {
			return label;
		}

		if (value === null || value === undefined) {
			return '—';
		}

		return typeof value === 'string' ? value : JSON.stringify(value);
	}
</script>

<div class="grid items-start gap-4 lg:grid-cols-2">
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

					{#if entry.outcome === 'migrated'}
						<p class="text-xs text-warning-soft-foreground">
							Запись закрыта переносом при изменении процесса, а не работой на стадии.
						</p>
					{/if}

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

					{#if entry.documents.length > 0}
						<!-- Файлы стоят у той записи, к которой их приложили: «чем
							подтверждена передача материалов» — вопрос к стадии, а не ко
							всему взаимодействию. -->
						<p class="text-xs">
							Вложения: {entry.documents.map((document) => document.title).join(', ')}
						</p>
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
				<EmptyState
					icon={PencilIcon}
					class="px-0 py-6"
					title="Изменений плана не было"
					description="Здесь появятся правки сроков, названия и ответственного — вместе с причиной, которую укажет автор правки."
				/>
			{/if}

			{#each changes as change (change.id)}
				<div class="flex flex-col gap-0.5 border-b border-border pb-2 last:border-0 last:pb-0">
					<p class="text-sm">
						{FIELD_LABELS[change.field] ?? change.field}: {describe(
							change.oldLabel,
							change.oldValue
						)} → {describe(change.newLabel, change.newValue)}
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
