<script lang="ts">
	import { goto } from '$app/navigation';
	import FilterXIcon from '@lucide/svelte/icons/filter-x';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import DateField from '$lib/components/form/date-field.svelte';
	import { AUDIT_OUTCOMES, AUDIT_SOURCES } from '$lib/contracts/audit';
	import {
		AUDIT_EVENT_GROUPS,
		AUDIT_EVENT_LABELS,
		AUDIT_OUTCOME_LABELS,
		AUDIT_SOURCE_LABELS,
		subjectTypeLabel,
		SUBJECT_TYPES
	} from './labels';
	import { auditHref, clearedAuditHref, hasAuditFilter, type AuditFilterParam } from './filters';

	/**
	 * Панель фильтров журнала. Ничего не хранит: всё, что выбрано, стоит в
	 * адресе страницы — поэтому выборка остаётся ссылкой, переживает «назад» и
	 * той же ссылкой уезжает в выгрузку.
	 */
	let {
		url,
		actors
	}: {
		url: URL;
		/** Кого предлагать в фильтре по действующему лицу; пусто — выбора нет. */
		actors: readonly { id: string; fullName: string }[];
	} = $props();

	const selected = $derived({
		from: url.searchParams.get('from') ?? '',
		to: url.searchParams.get('to') ?? '',
		type: url.searchParams.getAll('type'),
		outcome: url.searchParams.getAll('outcome'),
		source: url.searchParams.getAll('source'),
		actor: url.searchParams.get('actor') ?? '',
		subjectType: url.searchParams.get('subjectType') ?? '',
		subject: url.searchParams.get('subject') ?? ''
	});

	function go(changes: Parameters<typeof auditHref>[1]) {
		return goto(auditHref(url, changes), { keepFocus: true, noScroll: true });
	}

	/** Флажок в множественном фильтре: был выбран — убираем, не был — добавляем. */
	function toggle(param: AuditFilterParam, value: string, checked: boolean) {
		const current = url.searchParams.getAll(param);
		const next = checked ? [...current, value] : current.filter((item) => item !== value);

		return go({ [param]: next });
	}

	/** «Событие» без выбора и «Событие: 3» с ним — число видно, не открывая меню. */
	function countLabel(label: string, values: readonly string[]): string {
		return values.length === 0 ? label : `${label}: ${values.length}`;
	}

	const actorName = $derived(actors.find((actor) => actor.id === selected.actor)?.fullName);
</script>

<div class="flex flex-wrap items-end gap-3">
	<div class="flex flex-col gap-1.5">
		<Label for="audit-from" class="text-xs text-muted-foreground">Период с</Label>
		<DateField
			id="audit-from"
			class="w-48"
			value={selected.from}
			max={selected.to || undefined}
			onchange={(from) => void go({ from })}
		/>
	</div>

	<div class="flex flex-col gap-1.5">
		<Label for="audit-to" class="text-xs text-muted-foreground">по</Label>
		<DateField
			id="audit-to"
			class="w-48"
			value={selected.to}
			min={selected.from || undefined}
			onchange={(to) => void go({ to })}
		/>
	</div>

	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button {...props} variant="outline" size="sm">
					{countLabel('Событие', selected.type)}
					<ChevronDownIcon aria-hidden="true" />
				</Button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="start" class="max-h-96 w-72 overflow-y-auto">
			{#each AUDIT_EVENT_GROUPS as group, index (group.prefix)}
				{#if index > 0}
					<DropdownMenu.Separator />
				{/if}
				<!-- Заголовок обязан стоять внутри группы: без неё bits-ui не находит
					контекст и всё содержимое меню не отрисовывается вовсе. -->
				<DropdownMenu.Group>
					<DropdownMenu.GroupHeading>{group.label}</DropdownMenu.GroupHeading>
					{#each group.types as type (type)}
						<DropdownMenu.CheckboxItem
							checked={selected.type.includes(type)}
							onCheckedChange={(checked) => toggle('type', type, checked)}
							closeOnSelect={false}
						>
							{AUDIT_EVENT_LABELS[type]}
						</DropdownMenu.CheckboxItem>
					{/each}
				</DropdownMenu.Group>
			{/each}
		</DropdownMenu.Content>
	</DropdownMenu.Root>

	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button {...props} variant="outline" size="sm">
					{countLabel('Результат', selected.outcome)}
					<ChevronDownIcon aria-hidden="true" />
				</Button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="start" class="w-44">
			{#each AUDIT_OUTCOMES as outcome (outcome)}
				<DropdownMenu.CheckboxItem
					checked={selected.outcome.includes(outcome)}
					onCheckedChange={(checked) => toggle('outcome', outcome, checked)}
					closeOnSelect={false}
				>
					{AUDIT_OUTCOME_LABELS[outcome]}
				</DropdownMenu.CheckboxItem>
			{/each}
		</DropdownMenu.Content>
	</DropdownMenu.Root>

	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button {...props} variant="outline" size="sm">
					{countLabel('Источник', selected.source)}
					<ChevronDownIcon aria-hidden="true" />
				</Button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="start" class="w-44">
			{#each AUDIT_SOURCES as source (source)}
				<DropdownMenu.CheckboxItem
					checked={selected.source.includes(source)}
					onCheckedChange={(checked) => toggle('source', source, checked)}
					closeOnSelect={false}
				>
					{AUDIT_SOURCE_LABELS[source]}
				</DropdownMenu.CheckboxItem>
			{/each}
		</DropdownMenu.Content>
	</DropdownMenu.Root>

	{#if actors.length > 0}
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="outline" size="sm" class="max-w-56">
						<span class="truncate">{actorName ?? 'Кто действовал'}</span>
						<ChevronDownIcon aria-hidden="true" />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="start" class="max-h-96 w-64 overflow-y-auto">
				<DropdownMenu.RadioGroup
					value={selected.actor}
					onValueChange={(value) => void go({ actor: value })}
				>
					<DropdownMenu.RadioItem value="">Кто угодно</DropdownMenu.RadioItem>
					<DropdownMenu.Separator />
					{#each actors as actor (actor.id)}
						<DropdownMenu.RadioItem value={actor.id}>{actor.fullName}</DropdownMenu.RadioItem>
					{/each}
				</DropdownMenu.RadioGroup>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	{/if}

	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button {...props} variant="outline" size="sm">
					{selected.subjectType === '' ? 'Над чем' : subjectTypeLabel(selected.subjectType)}
					<ChevronDownIcon aria-hidden="true" />
				</Button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="start" class="w-56">
			<DropdownMenu.RadioGroup
				value={selected.subjectType}
				onValueChange={(value) => void go({ subjectType: value })}
			>
				<DropdownMenu.RadioItem value="">Над чем угодно</DropdownMenu.RadioItem>
				<DropdownMenu.Separator />
				{#each SUBJECT_TYPES as type (type)}
					<DropdownMenu.RadioItem value={type}>{subjectTypeLabel(type)}</DropdownMenu.RadioItem>
				{/each}
			</DropdownMenu.RadioGroup>
		</DropdownMenu.Content>
	</DropdownMenu.Root>

	{#if selected.subject !== ''}
		<Button variant="outline" size="sm" onclick={() => go({ subject: null })}>
			Одна запись: {selected.subject.slice(0, 8)}
			<FilterXIcon aria-hidden="true" />
		</Button>
	{/if}

	{#if hasAuditFilter(url)}
		<Button variant="ghost" size="sm" href={clearedAuditHref(url)}>Сбросить фильтр</Button>
	{/if}
</div>
