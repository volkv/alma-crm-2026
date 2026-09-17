<script lang="ts">
	import OctagonAlertIcon from '@lucide/svelte/icons/octagon-alert';
	import { enhance } from '$app/forms';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import EmptyState from '$lib/components/empty-state.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import {
		blockerReasonLabel,
		BLOCKER_REASONS,
		BLOCKER_REASON_LABELS,
		type BlockerView
	} from '$lib/contracts/interactions';
	import { formatDateTime } from '$lib/format';
	import { actionEnhance } from './action-enhance';

	/**
	 * Помехи: что мешает двигаться дальше и кто это снял. Блокирующая помеха
	 * запрещает переход по процессу — не «не советует», а именно запрещает, и
	 * снять её можно только объяснив, как проблема решена.
	 */
	let { blockers, canWrite }: { blockers: readonly BlockerView[]; canWrite: boolean } = $props();

	const open = $derived(blockers.filter((blocker) => blocker.resolvedAt === null));
	const resolved = $derived(blockers.filter((blocker) => blocker.resolvedAt !== null));

	/** Причина выбирается из справочника: по ней потом считают, на чём встаём. */
	let reasonCode = $state('');
</script>

<div class="grid items-start gap-4 lg:grid-cols-2">
	<Card.Root size="sm">
		<Card.Header>
			<Card.Title>Открытые помехи</Card.Title>
		</Card.Header>
		<Card.Content class="flex flex-col gap-3">
			{#if open.length === 0}
				<!-- «Помех нет» — это только про помехи: требования самой стадии
					(чек-лист, результат, подтверждение) живут во вкладке «Стадия», и
					обещать здесь, что дорога открыта, панель не вправе — она о них
					ничего не знает. -->
				<EmptyState
					icon={OctagonAlertIcon}
					title="Помех нет"
					description="О помехах никто не сообщал. Что требует сама стадия — во вкладке «Стадия» и в блоке «Что мешает»."
				/>
			{/if}

			{#each open as blocker (blocker.id)}
				<div class="flex flex-col gap-2 rounded-md border border-border p-3">
					<div class="flex flex-wrap items-center gap-2">
						<StatusBadge tone={blocker.blocksTransition ? 'danger' : 'warning'} dot>
							{blocker.blocksTransition ? 'запрещает переход' : 'не запрещает переход'}
						</StatusBadge>
						<span class="text-xs text-muted-foreground">
							{blockerReasonLabel(blocker.reasonCode)} · {blocker.raisedByName} · {formatDateTime(
								blocker.raisedAt
							)}
						</span>
					</div>
					<p class="text-sm">{blocker.description}</p>

					{#if canWrite}
						<form
							method="POST"
							action="?/resolveBlocker"
							use:enhance={actionEnhance()}
							class="flex flex-wrap items-end gap-2"
						>
							<input type="hidden" name="blockerId" value={blocker.id} />
							<div class="min-w-40 flex-1">
								<Label for="resolution-{blocker.id}" class="text-xs">Как решено</Label>
								<Input id="resolution-{blocker.id}" name="resolution" required />
							</div>
							<Button type="submit" size="sm" variant="outline">Снять помеху</Button>
						</form>
					{/if}
				</div>
			{/each}
		</Card.Content>
	</Card.Root>

	<div class="flex flex-col gap-4">
		{#if canWrite}
			<Card.Root size="sm">
				<Card.Header>
					<Card.Title>Сообщить о помехе</Card.Title>
				</Card.Header>
				<Card.Content>
					<form
						method="POST"
						action="?/raiseBlocker"
						use:enhance={actionEnhance({ onsuccess: () => (reasonCode = '') })}
						class="flex flex-col gap-3"
					>
						<div class="flex flex-col gap-1.5">
							<Label for="reasonCode">Причина</Label>
							<Select.Root type="single" name="reasonCode" bind:value={reasonCode}>
								<Select.Trigger id="reasonCode" class="w-full">
									{reasonCode === '' ? 'Выберите причину' : blockerReasonLabel(reasonCode)}
								</Select.Trigger>
								<Select.Content>
									{#each BLOCKER_REASONS as reason (reason)}
										<Select.Item value={reason} label={BLOCKER_REASON_LABELS[reason]} />
									{/each}
								</Select.Content>
							</Select.Root>
						</div>
						<div class="flex flex-col gap-1.5">
							<Label for="blockerDescription">Что мешает</Label>
							<Textarea id="blockerDescription" name="description" rows={3} required />
						</div>
						<Label class="flex items-center gap-2 font-normal">
							<Checkbox name="blocksTransition" value="true" checked />
							Запрещает переход на следующую стадию
						</Label>
						<div class="flex justify-end">
							<Button type="submit" size="sm" disabled={reasonCode === ''}>Сообщить</Button>
						</div>
					</form>
				</Card.Content>
			</Card.Root>
		{/if}

		{#if resolved.length > 0}
			<Card.Root size="sm">
				<Card.Header>
					<Card.Title>Снятые помехи</Card.Title>
				</Card.Header>
				<Card.Content class="flex flex-col gap-2">
					{#each resolved as blocker (blocker.id)}
						<div class="flex flex-col gap-0.5 border-b border-border pb-2 last:border-0">
							<p class="text-sm">{blocker.description}</p>
							<p class="text-xs text-muted-foreground">
								{blocker.resolution} · {blocker.resolvedAt
									? formatDateTime(blocker.resolvedAt)
									: ''}
							</p>
						</div>
					{/each}
				</Card.Content>
			</Card.Root>
		{/if}
	</div>
</div>
