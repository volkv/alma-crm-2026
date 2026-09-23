<script lang="ts">
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import CircleCheckBigIcon from '@lucide/svelte/icons/circle-check-big';
	import CircleIcon from '@lucide/svelte/icons/circle';
	import CirclePauseIcon from '@lucide/svelte/icons/circle-pause';
	import FlagIcon from '@lucide/svelte/icons/flag';
	import OctagonAlertIcon from '@lucide/svelte/icons/octagon-alert';
	import PlayIcon from '@lucide/svelte/icons/play';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { blockerReasonLabel } from '$lib/contracts/interactions';
	import { formatDate, pluralize } from '$lib/format';
	import { mockAction } from './mock';
	import type { CardAction, Requirement, SecondaryAction } from './model';

	/**
	 * Главное действие карточки и всё, что ему мешает, — в одном месте.
	 *
	 * Кнопка одна и выглядит кнопкой: доступна — заливкой, недоступна — контуром
	 * и сразу под ней список того, что осталось сделать. Этот список и есть
	 * чек-лист стадии: пункт отмечают прямо здесь, а не ищут на другой вкладке,
	 * и нигде больше на карточке он не повторяется. Остальные команды — в меню
	 * «Ещё»: они нужны реже, и ряд из шести кнопок равного веса не говорил, какая
	 * из них главная.
	 */
	let {
		action,
		secondary,
		id = 'card-action'
	}: {
		action: CardAction;
		secondary: readonly SecondaryAction[];
		/** Корень для идентификаторов: на странице бывает по макету каждого вида. */
		id?: string;
	} = $props();

	const open = $derived(
		action.kind === 'forward' || action.kind === 'complete' || action.kind === 'resume'
			? action
			: null
	);
	const missing = $derived(open?.requirements.filter((item) => item.required && !item.done) ?? []);
	const optional = $derived(
		open?.requirements.filter((item) => !item.required && !item.done) ?? []
	);
	const done = $derived(open?.requirements.filter((item) => item.done) ?? []);
	const leftCount = $derived(missing.length + (open?.blockers.length ?? 0));
</script>

{#snippet requirementRow(item: Requirement)}
	<li class="flex flex-wrap items-start gap-x-3 gap-y-1.5 py-2">
		<div class="flex min-w-0 flex-1 items-start gap-2.5">
			{#if item.close === 'check'}
				<Checkbox
					id="{id}-{item.key}"
					class="mt-0.5"
					onCheckedChange={() => mockAction(item.label)}
				/>
				<label for="{id}-{item.key}" class="min-w-0 text-sm">{item.label}</label>
			{:else}
				<CircleIcon class="mt-0.5 size-4 shrink-0 text-faint" aria-hidden="true" />
				<div class="min-w-0">
					<p class="text-sm">{item.label}</p>
					{#if item.hint}
						<p class="text-xs text-muted-foreground">{item.hint}</p>
					{/if}
				</div>
			{/if}
		</div>
		{#if item.cta}
			<Button size="sm" variant="outline" onclick={() => mockAction(item.cta ?? item.label)}>
				{item.cta}
			</Button>
		{/if}
	</li>
{/snippet}

<section class="flex flex-col gap-3" aria-labelledby="{id}-title" data-slot="card-action">
	<h2 id="{id}-title" class="sr-only">Что сделать дальше</h2>

	{#if action.kind === 'closed'}
		<div class="flex items-start gap-2">
			<FlagIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
			<div class="min-w-0">
				<p class="text-sm font-medium">
					{action.label}{action.at ? ` ${formatDate(action.at)}` : ''}
				</p>
				{#if action.outcome}
					<p class="text-sm text-muted-foreground">Итог: {action.outcome}</p>
				{/if}
			</div>
		</div>
	{:else if action.kind === 'none'}
		<p class="text-sm text-muted-foreground">{action.label}</p>
	{:else}
		{#if action.pause}
			<div class="flex items-start gap-2 rounded-lg bg-surface-muted px-3 py-2">
				<CirclePauseIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				<div class="min-w-0 text-sm">
					<p>
						<span class="font-medium">На паузе с {formatDate(action.pause.since)}</span>
						— {action.pause.reason.toLowerCase()}: {action.pause.note}
					</p>
					{#if action.pause.nextAction}
						<p class="text-muted-foreground">Потом: {action.pause.nextAction}</p>
					{/if}
				</div>
			</div>
		{/if}

		<div class="flex flex-wrap items-center gap-2">
			<!-- Первичная заливка — только у того, что можно нажать
				(`docs/development.md`, «Действие, которого сейчас нельзя»). -->
			<Button
				size="lg"
				variant={action.allowed ? 'default' : 'outline'}
				disabled={!action.allowed}
				aria-describedby={action.allowed ? undefined : `${id}-why`}
				class="h-auto min-h-9 max-w-full py-1.5 text-left whitespace-normal"
				onclick={() => mockAction(action.label)}
			>
				{#if action.kind === 'resume'}
					<PlayIcon aria-hidden="true" />
				{:else if action.kind === 'complete'}
					<CircleCheckBigIcon aria-hidden="true" />
				{:else}
					<ArrowRightIcon aria-hidden="true" />
				{/if}
				{action.label}
			</Button>

			{#if secondary.length > 0}
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button {...props} size="lg" variant="outline">
								Ещё
								<ChevronDownIcon aria-hidden="true" />
							</Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="start" class="w-72">
						{#each secondary as item (item.key)}
							<DropdownMenu.Item
								disabled={!item.allowed}
								onSelect={() => mockAction(item.label)}
								class="flex-col items-start gap-0.5 {item.tone === 'danger'
									? 'text-destructive'
									: ''}"
							>
								<span>{item.label}</span>
								{#if item.reason}
									<span class="text-xs whitespace-normal text-muted-foreground">{item.reason}</span>
								{/if}
							</DropdownMenu.Item>
						{/each}
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			{/if}
		</div>

		{#if !action.allowed}
			<p id="{id}-why" class="text-sm font-medium">
				{#if leftCount > 0}
					Чтобы {action.kind === 'complete' ? 'завершить' : 'перейти'}, осталось {pluralize(
						leftCount,
						['условие', 'условия', 'условий']
					)}:
				{:else}
					Сейчас нельзя:
				{/if}
			</p>
		{:else if missing.length === 0 && done.length > 0}
			<p class="flex items-center gap-1.5 text-sm text-success-soft-foreground">
				<CheckIcon class="size-4" aria-hidden="true" />
				Условия стадии выполнены
			</p>
		{/if}

		{#if action.blockers.length > 0 || missing.length > 0 || action.otherReasons.length > 0}
			<ul class="flex flex-col divide-y divide-border rounded-lg border border-border px-3">
				{#each action.blockers as blocker (blocker.id)}
					<li class="flex flex-wrap items-start gap-x-3 gap-y-1.5 py-2">
						<div class="flex min-w-0 flex-1 items-start gap-2.5">
							<OctagonAlertIcon class="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
							<div class="min-w-0 text-sm">
								<p>
									<span class="font-medium text-danger-soft-foreground">
										Помеха: {blockerReasonLabel(blocker.reasonCode).toLowerCase()}
									</span>
								</p>
								<p class="text-muted-foreground">{blocker.description}</p>
							</div>
						</div>
						<Button size="sm" variant="outline" onclick={() => mockAction('Снять помеху')}>
							Снять помеху
						</Button>
					</li>
				{/each}
				{#each missing as item (item.key)}
					{@render requirementRow(item)}
				{/each}
				{#each action.otherReasons as reason (reason)}
					<li class="py-2 text-sm text-muted-foreground">{reason}</li>
				{/each}
			</ul>
		{/if}

		{#if optional.length > 0 || action.softBlockers.length > 0}
			<div class="flex flex-col gap-0.5">
				<p class="text-xs text-muted-foreground">Переходу не мешает, но не сделано:</p>
				<ul class="flex flex-col divide-y divide-border">
					{#each optional as item (item.key)}
						{@render requirementRow(item)}
					{/each}
					{#each action.softBlockers as blocker (blocker.id)}
						<li class="py-2 text-sm">
							{blockerReasonLabel(blocker.reasonCode)}: {blocker.description}
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if done.length > 0}
			<details class="group text-sm">
				<summary
					class="w-fit cursor-pointer rounded-sm text-xs text-muted-foreground focus-ring hover:text-foreground"
				>
					Сделано на стадии: {done.length}
				</summary>
				<ul class="mt-1 flex flex-col gap-1">
					{#each done as item (item.key)}
						<li class="flex items-start gap-2 text-muted-foreground">
							<CheckIcon class="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
							<span>{item.label}</span>
						</li>
					{/each}
				</ul>
			</details>
		{/if}
	{/if}
</section>
