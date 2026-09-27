<script lang="ts">
	import { resolve } from '$app/paths';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import UsersRoundIcon from '@lucide/svelte/icons/users-round';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import EmptyState from '$lib/components/empty-state.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { LEARNER_STATUS_LABELS } from '$lib/contracts/exchange';
	import { formatDate, formatNumber } from '$lib/format';
	import type { SectionPageProps } from '$lib/platform/sections';
	import type { StreamRow, StreamsPage } from '../server/streams';

	/**
	 * Потоки всех дел пространства: итоги сверху, ниже — дело строкой, а по
	 * нажатию его потоки и поимённые списки. Числа читаются так же, как в
	 * панели «Слушатели» карточки: «нет данных» — ни один поток числа не
	 * прислал, это не ноль.
	 */
	let { data, workspace }: SectionPageProps = $props();

	const page = $derived(data as StreamsPage);

	/** Раскрытые дела; по умолчанию все свёрнуты — страница про обзор. */
	let expanded = $state<Record<string, boolean>>({});

	function toggle(id: string) {
		expanded[id] = !expanded[id];
	}

	/** Даты словами; `null` — дат нет. */
	function period(startsOn: string | null, endsOn: string | null): string | null {
		const parts = [
			startsOn === null ? null : `с ${formatDate(startsOn)}`,
			endsOn === null ? null : `по ${formatDate(endsOn)}`
		].filter((part) => part !== null);

		return parts.length === 0 ? null : parts.join(' ');
	}

	const TRAINING = {
		completed: { label: 'Обучение завершено', tone: 'success' },
		in_progress: { label: 'Идёт обучение', tone: 'accent' },
		awaiting: { label: 'Ждём данных', tone: 'neutral' }
	} as const;

	const totals: { label: string; value: number | null }[] = $derived([
		{ label: 'Потоков', value: page.totals.streams },
		{ label: 'Заявлено мест', value: page.totals.plannedSeats },
		{ label: 'В поимённых списках', value: page.totals.listed },
		{ label: 'Зачислено', value: page.totals.enrolled },
		{ label: 'Окончили', value: page.totals.completed },
		{ label: 'Отчислено', value: page.totals.expelled }
	]);

	const NUMBER_COLUMNS = 'text-right tabular-nums';
</script>

{#snippet number(value: number | null)}
	{#if value === null}
		<span class="text-faint">нет данных</span>
	{:else}
		{formatNumber(value)}
	{/if}
{/snippet}

{#snippet streamLine(stream: StreamRow)}
	<li class="flex flex-col gap-2 px-3 py-2">
		<div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
			<span class="font-medium">Поток {stream.streamNumber}</span>
			<StatusBadge tone={TRAINING[stream.trainingState].tone}>
				{TRAINING[stream.trainingState].label}
			</StatusBadge>
			<span class="text-muted-foreground">
				{[stream.program ?? 'программа не закреплена', period(stream.startsOn, stream.endsOn)]
					.filter((part) => part !== null)
					.join(' · ')}
			</span>
		</div>
		<dl class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
			<div class="flex gap-1">
				<dt>Мест:</dt>
				<dd class="tabular-nums">{@render number(stream.plannedSeats)}</dd>
			</div>
			<div class="flex gap-1">
				<dt>В списке:</dt>
				<dd class="tabular-nums">
					{@render number(stream.learnerCount === 0 ? null : stream.learnerCount)}
				</dd>
			</div>
			<div class="flex gap-1">
				<dt>Зачислено:</dt>
				<dd class="tabular-nums">{@render number(stream.enrolled)}</dd>
			</div>
			<div class="flex gap-1">
				<dt>Окончили:</dt>
				<dd class="tabular-nums">{@render number(stream.completed)}</dd>
			</div>
			<div class="flex gap-1">
				<dt>Отчислено:</dt>
				<dd class="tabular-nums">{@render number(stream.expelled)}</dd>
			</div>
		</dl>
		{#if stream.learners !== null}
			{#if stream.learners.length === 0}
				<p class="text-xs text-muted-foreground">Поимённого списка нет.</p>
			{:else}
				<ul class="flex flex-col divide-y rounded-md border border-border">
					{#each stream.learners as learner (learner.personId)}
						<li class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-sm">
							<span class="min-w-0 flex-1 break-words">
								{learner.fullName}
								<span class="block text-xs break-all text-muted-foreground">
									{[learner.email, learner.phone].filter((part) => part !== null).join(' · ')}
								</span>
							</span>
							<StatusBadge tone={learner.status === 'transferred' ? 'success' : 'warning'} dot>
								{LEARNER_STATUS_LABELS[learner.status]}
							</StatusBadge>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</li>
{/snippet}

<div class="flex flex-wrap gap-3">
	{#each totals as total (total.label)}
		<div class="flex min-w-36 flex-1 flex-col rounded-lg border border-border bg-surface px-3 py-2">
			<span class="text-xs text-muted-foreground">{total.label}</span>
			<span class="mt-0.5 text-2xl leading-tight font-semibold tabular-nums">
				{#if total.value === null}
					<span class="text-base font-normal text-faint">нет данных</span>
				{:else}
					{formatNumber(total.value)}
				{/if}
			</span>
		</div>
	{/each}
</div>

{#if page.truncated}
	<InlineHint tone="warning">
		Показаны {formatNumber(page.limit)} дел с самой свежей активностью; итоги — по ним. Остальные — в
		списке взаимодействий пространства.
	</InlineHint>
{/if}

{#if !page.canSeePeople}
	<InlineHint>
		Поимённые списки видны с правом «Просмотр людей и их ролей в организациях»; здесь — только
		числа.
	</InlineHint>
{/if}

{#if page.deals.length === 0}
	{@const path = page.firstStream}
	{@const workflow = path.workflow}
	<div class="rounded-lg border border-border bg-surface">
		{#if path.panelChosen}
			<EmptyState
				icon={UsersRoundIcon}
				title="Потоков пока нет"
				description="Первый поток заявляют в карточке взаимодействия: панель «Группа в системе обучения», кнопка «Заявить поток». Здесь видны дела, доступные вам."
			>
				{#snippet action()}
					<Button
						size="sm"
						href={resolve('/(app)/w/[workspace]/interactions', { workspace: workspace.key })}
					>
						Открыть взаимодействия
						<ArrowRightIcon aria-hidden="true" />
					</Button>
				{/snippet}
			</EmptyState>
		{:else if workflow !== null && path.canConfigure}
			<EmptyState
				icon={UsersRoundIcon}
				title="Потоков пока нет"
				description="Поток заявляют кнопкой «Заявить поток» в панели «Группа в системе обучения», а процесс «{workflow.name}» эту панель в карточку не выбрал. Добавьте её в составе карточки процесса — кнопка появится в карточках пространства."
			>
				{#snippet action()}
					<Button
						size="sm"
						href="{resolve('/(app)/settings/workflows/[key]', { key: workflow.key })}#card"
					>
						Настроить состав карточки
						<ArrowRightIcon aria-hidden="true" />
					</Button>
				{/snippet}
			</EmptyState>
		{:else}
			<EmptyState
				icon={UsersRoundIcon}
				title="Потоков пока нет"
				description="Поток заявляют кнопкой «Заявить поток» в панели «Группа в системе обучения», а процесс пространства эту панель в карточку не выбрал. Добавить её может администратор с правом «Настройка маршрутов и стадий»."
			/>
		{/if}
	</div>
{:else}
	<div class="overflow-x-auto rounded-lg border border-border bg-surface">
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head class="w-10"><span class="sr-only">Раскрыть</span></Table.Head>
					<Table.Head>Взаимодействие</Table.Head>
					<Table.Head>Программа</Table.Head>
					<Table.Head>Даты</Table.Head>
					<Table.Head class={NUMBER_COLUMNS}>Потоков</Table.Head>
					<Table.Head class={NUMBER_COLUMNS}>Мест</Table.Head>
					<Table.Head class={NUMBER_COLUMNS}>В списках</Table.Head>
					<Table.Head class={NUMBER_COLUMNS}>Зачислено</Table.Head>
					<Table.Head class={NUMBER_COLUMNS}>Окончили</Table.Head>
					<Table.Head class={NUMBER_COLUMNS}>Отчислено</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each page.deals as deal (deal.id)}
					{@const open = expanded[deal.id] === true}
					<Table.Row>
						<Table.Cell>
							<Button
								size="icon-xs"
								variant="ghost"
								aria-expanded={open}
								aria-controls={open ? `streams-${deal.id}` : undefined}
								aria-label="{open ? 'Свернуть' : 'Раскрыть'} потоки: {deal.title}"
								onclick={() => toggle(deal.id)}
							>
								{#if open}
									<ChevronDownIcon aria-hidden="true" />
								{:else}
									<ChevronRightIcon aria-hidden="true" />
								{/if}
							</Button>
						</Table.Cell>
						<Table.Cell class="max-w-80 whitespace-normal">
							<a
								class="font-medium hover:underline"
								href={resolve('/(app)/w/[workspace]/interactions/[id=uuid]', {
									workspace: workspace.key,
									id: deal.id
								})}
							>
								{deal.title}
							</a>
						</Table.Cell>
						<Table.Cell class="max-w-72 whitespace-normal text-muted-foreground">
							{deal.programs.length === 0 ? '—' : deal.programs.join(', ')}
						</Table.Cell>
						<Table.Cell class="text-muted-foreground"
							>{period(deal.startsOn, deal.endsOn) ?? '—'}</Table.Cell
						>
						<Table.Cell class={NUMBER_COLUMNS}>{formatNumber(deal.streams.length)}</Table.Cell>
						<Table.Cell class={NUMBER_COLUMNS}
							>{@render number(deal.totals.plannedSeats)}</Table.Cell
						>
						<Table.Cell class={NUMBER_COLUMNS}>{@render number(deal.totals.listed)}</Table.Cell>
						<Table.Cell class={NUMBER_COLUMNS}>{@render number(deal.totals.enrolled)}</Table.Cell>
						<Table.Cell class={NUMBER_COLUMNS}>{@render number(deal.totals.completed)}</Table.Cell>
						<Table.Cell class={NUMBER_COLUMNS}>{@render number(deal.totals.expelled)}</Table.Cell>
					</Table.Row>
					{#if open}
						<Table.Row id="streams-{deal.id}" class="hover:bg-transparent">
							<Table.Cell colspan={10} class="bg-surface-muted p-3 whitespace-normal">
								<ul class="flex flex-col divide-y rounded-md border border-border bg-surface">
									{#each deal.streams as stream (stream.id)}
										{@render streamLine(stream)}
									{/each}
								</ul>
							</Table.Cell>
						</Table.Row>
					{/if}
				{/each}
			</Table.Body>
		</Table.Root>
	</div>
{/if}
