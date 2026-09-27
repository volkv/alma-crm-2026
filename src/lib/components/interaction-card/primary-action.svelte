<script lang="ts">
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import CircleCheckBigIcon from '@lucide/svelte/icons/circle-check-big';
	import CircleIcon from '@lucide/svelte/icons/circle';
	import CirclePauseIcon from '@lucide/svelte/icons/circle-pause';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import FlagIcon from '@lucide/svelte/icons/flag';
	import LockIcon from '@lucide/svelte/icons/lock';
	import OctagonAlertIcon from '@lucide/svelte/icons/octagon-alert';
	import PlayIcon from '@lucide/svelte/icons/play';
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { actionEnhance } from '$lib/components/interactions/action-enhance';
	import { blockerReasonLabel, type BlockerView } from '$lib/contracts/interactions';
	import { formatDate, pluralize } from '$lib/format';
	import { getCardCommands } from './commands.svelte';
	import type { CardAction, CardCommand, Requirement, SecondaryAction } from './model';

	type OpenAction = Extract<CardAction, { kind: 'forward' | 'complete' | 'resume' }>;

	/**
	 * Главное действие карточки и всё, что ему мешает, — в одном месте.
	 *
	 * Блок читается сверху вниз: «Следующий шаг», сколько осталось, сами
	 * условия и только потом кнопка. Доступная кнопка залита главным цветом и
	 * стоит сразу под заголовком; недоступная — сплошная, в виде «отключено», и
	 * рядом словами сказано, что её держит. Список условий и есть чек-лист
	 * стадии: пункт отмечают прямо здесь, и нигде больше на карточке он не
	 * повторяется. Остальные команды — в меню «Ещё»: они нужны реже, и ряд из
	 * шести кнопок равного веса не говорил, какая из них главная.
	 *
	 * Отметка пункта отвечает сразу, не дожидаясь сервера: это самое частое
	 * действие на стадии. Если сервер откажет, страница перечитает настоящее
	 * состояние.
	 *
	 * У пункта видно, что значит его сделать (пояснение процесса), и кнопка,
	 * которая открывает нужную форму. Пункт-факт галочки не имеет: его
	 * закрывают данные дела, и рядом сказано, чем он закрыт или чего не хватает.
	 * Записанный результат стадии стоит под заголовком сразу после записи.
	 */
	let {
		action,
		primary,
		secondary,
		canCheck,
		canResolve
	}: {
		action: CardAction;
		/** Что начинает главная кнопка; у снятия паузы команды нет — это форма. */
		primary: CardCommand | null;
		secondary: readonly SecondaryAction[];
		/** Есть ли право отмечать пункты чек-листа. */
		canCheck: boolean;
		/** Есть ли право снимать помехи. */
		canResolve: boolean;
	} = $props();

	const commands = getCardCommands();
	const id = 'card-action';

	const open = $derived<OpenAction | null>(
		action.kind === 'forward' || action.kind === 'complete' || action.kind === 'resume'
			? action
			: null
	);

	// Отметки чек-листа приезжают с сервера; своя копия нужна только на те доли
	// секунды, пока ответ в пути, и заменяется новым ответом сама.
	let checked = $derived<Record<string, boolean>>(
		Object.fromEntries(
			(open?.requirements ?? [])
				.filter((item) => item.checklistKey !== null)
				.map((item) => [item.key, item.done])
		)
	);
	let forms = $state<Record<string, HTMLFormElement | null>>({});

	// Списки собираются по ответу сервера, а не по отметке в пути: пункт
	// переезжает в «сделано», когда отметку приняли, и форма, которую сейчас
	// отправляют, не пропадает из разметки на полпути.
	const missing = $derived(open?.requirements.filter((item) => item.required && !item.done) ?? []);
	const optional = $derived(
		open?.requirements.filter((item) => !item.required && !item.done) ?? []
	);
	const done = $derived(open?.requirements.filter((item) => item.done) ?? []);

	/**
	 * Что держит главную кнопку — одной строкой над условиями. Снятие паузы
	 * условиями стадии не держится: их показывают, но не считают.
	 */
	const left = $derived.by(() => {
		if (open === null || open.allowed || open.kind === 'resume') return null;

		const parts = [
			open.blockers.length > 0
				? `снять ${pluralize(open.blockers.length, ['помеху', 'помехи', 'помех'])}`
				: null,
			missing.length > 0
				? `выполнить ${pluralize(missing.length, ['условие', 'условия', 'условий'])}`
				: null
		].filter((part) => part !== null);

		return parts.length > 0
			? `Осталось ${parts.join(' и ')}`
			: open.kind === 'complete'
				? 'Завершить пока нельзя'
				: 'Перейти пока нельзя';
	});
	/** Почему кнопка отключена — короткой строкой рядом с ней. */
	const why = $derived.by(() => {
		if (open === null || open.allowed) return null;
		if (open.kind === 'resume') return 'Недоступно — причина выше';
		if (open.blockers.length > 0) return 'Недоступно, пока не снята помеха';
		if (missing.length > 0) return 'Недоступно, пока не выполнены условия выше';

		return 'Недоступно — причина выше';
	});
	/**
	 * Доступную кнопку и снятие паузы ставят сразу под заголовок: их не держат
	 * условия. Недоступный переход — после условий, которые его держат.
	 */
	const buttonFirst = $derived(open !== null && (open.allowed || open.kind === 'resume'));

	async function toggle(item: Requirement, next: boolean) {
		checked = { ...checked, [item.key]: next };
		await tick();
		forms[item.key]?.requestSubmit();
	}

	let resumeForm = $state<HTMLFormElement | null>(null);

	function runPrimary() {
		if (primary !== null) {
			commands.open(primary);
		} else if (action.kind === 'resume') {
			resumeForm?.requestSubmit();
		}
	}

	/**
	 * Показать сторону дела в «Контексте»: контакт, подразделение и канал связи
	 * правятся там. На узком экране «Контекст» свёрнут — его раскрывают той же
	 * кнопкой, что и человек, и только потом прокручивают к стороне.
	 */
	async function revealParty() {
		const panel = document.querySelector<HTMLElement>(
			'[data-slot="institution-panel"], [data-slot="learner-panel"]'
		);

		if (panel === null) return;

		if (panel.offsetParent === null) {
			document
				.querySelector<HTMLButtonElement>('[aria-controls="card-context"][aria-expanded="false"]')
				?.click();
			await tick();
		}

		panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	function runCommand(command: CardCommand) {
		if (command.kind === 'reveal') {
			void revealParty();
		} else {
			commands.open(command);
		}
	}

	function resolve(blocker: BlockerView) {
		commands.open({
			kind: 'resolve-blocker',
			blockerId: blocker.id,
			description: blocker.description
		});
	}
</script>

{#snippet checkbox(item: Requirement)}
	<form
		method="POST"
		action="?/checklist"
		use:enhance={actionEnhance()}
		bind:this={forms[item.key]}
		class="contents"
	>
		<input type="hidden" name="stageEntryId" value={open?.stageEntryId} />
		<input type="hidden" name="key" value={item.checklistKey} />
		<input type="hidden" name="done" value={String(checked[item.key] === true)} />
		<Checkbox
			id="{id}-{item.key}"
			class="mt-0.5"
			checked={checked[item.key] === true}
			disabled={!canCheck}
			onCheckedChange={(next) => void toggle(item, next === true)}
		/>
	</form>
{/snippet}

{#snippet explanation(item: Requirement)}
	{#if item.hint}
		<p class="text-xs text-muted-foreground">{item.hint}</p>
	{/if}
	{#if item.note}
		<p class="text-xs break-words text-foreground">{item.note}</p>
	{/if}
{/snippet}

{#snippet requirementRow(item: Requirement)}
	<li class="flex flex-wrap items-start gap-x-3 gap-y-1.5 py-2">
		<div class="flex min-w-0 flex-1 basis-56 items-start gap-2.5">
			{#if item.close === 'check'}
				{@render checkbox(item)}
				<div class="min-w-0">
					<label for="{id}-{item.key}" class="text-sm">{item.label}</label>
					{@render explanation(item)}
				</div>
			{:else}
				{#if item.close === 'fact'}
					<DatabaseIcon class="mt-0.5 size-4 shrink-0 text-faint" aria-hidden="true" />
				{:else}
					<CircleIcon class="mt-0.5 size-4 shrink-0 text-faint" aria-hidden="true" />
				{/if}
				<div class="min-w-0">
					<p class="text-sm">
						{item.label}
						{#if item.close === 'fact'}
							<span class="text-xs text-muted-foreground">— закроется данными дела</span>
						{/if}
					</p>
					{@render explanation(item)}
				</div>
			{/if}
		</div>
		{#if item.cta && item.command}
			{@const command = item.command}
			<Button size="sm" variant="outline" onclick={() => runCommand(command)}>
				{item.cta}
			</Button>
		{/if}
	</li>
{/snippet}

{#snippet blockerRow(blocker: BlockerView, hard: boolean)}
	<li class="flex flex-wrap items-start gap-x-3 gap-y-1.5 py-2">
		<div class="flex min-w-0 flex-1 basis-56 items-start gap-2.5">
			<OctagonAlertIcon
				class="mt-0.5 size-4 shrink-0 {hard ? 'text-danger' : 'text-warning'}"
				aria-hidden="true"
			/>
			<div class="min-w-0 text-sm">
				<p
					class="font-medium {hard
						? 'text-danger-soft-foreground'
						: 'text-warning-soft-foreground'}"
				>
					Помеха: {blockerReasonLabel(blocker.reasonCode).toLowerCase()}
				</p>
				<p class="break-words text-muted-foreground">{blocker.description}</p>
				<p class="text-xs text-faint">{blocker.raisedByName} · {formatDate(blocker.raisedAt)}</p>
			</div>
		</div>
		{#if canResolve}
			<Button size="sm" variant="outline" onclick={() => resolve(blocker)}>Снять помеху</Button>
		{/if}
	</li>
{/snippet}

{#snippet actionRow(item: OpenAction)}
	<div class="flex flex-col gap-1.5">
		<div class="flex flex-wrap items-center gap-2">
			<Button
				size="lg"
				disabled={!item.allowed}
				aria-describedby={item.allowed ? undefined : `${id}-why`}
				class="h-auto min-h-9 max-w-full py-1.5 text-left whitespace-normal"
				onclick={runPrimary}
			>
				{#if item.kind === 'resume'}
					<PlayIcon aria-hidden="true" />
				{:else if item.kind === 'complete'}
					<CircleCheckBigIcon aria-hidden="true" />
				{:else}
					<ArrowRightIcon aria-hidden="true" />
				{/if}
				{item.label}
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
					<DropdownMenu.Content align="start" class="w-72 max-w-[calc(100vw-2rem)]">
						{#each secondary as entry (entry.key)}
							<DropdownMenu.Item
								disabled={!entry.allowed}
								onSelect={() => commands.open(entry.command)}
								class="flex-col items-start gap-0.5 {entry.tone === 'danger'
									? 'text-destructive'
									: ''}"
							>
								<span>{entry.label}</span>
								{#if entry.reason}
									<span class="text-xs whitespace-normal text-muted-foreground">{entry.reason}</span
									>
								{/if}
							</DropdownMenu.Item>
						{/each}
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			{/if}
		</div>
		{#if why !== null}
			<p id="{id}-why" class="flex items-center gap-1.5 text-xs text-muted-foreground">
				<LockIcon class="size-3.5 shrink-0" aria-hidden="true" />
				{why}
			</p>
		{/if}
	</div>
{/snippet}

<!-- `data-tour` — метка подсказок: по ней тур находит главное действие
	(`$lib/onboarding/screens`). -->
<section
	class="flex flex-col gap-3"
	aria-labelledby="{id}-title"
	data-slot="card-action"
	data-tour="interaction-actions"
>
	<h2 id="{id}-title" class="section-title">Следующий шаг</h2>

	{#if action.kind === 'closed'}
		<div class="flex items-start gap-2">
			<FlagIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
			<div class="min-w-0">
				<p class="text-sm font-medium">
					{action.label}{action.at ? ` ${formatDate(action.at)}` : ''}
				</p>
				{#if action.outcome}
					<p class="text-sm break-words text-muted-foreground">Итог: {action.outcome}</p>
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
					<p class="break-words">
						<span class="font-medium">На паузе с {formatDate(action.pause.since)}</span>
						— {action.pause.reason.toLowerCase()}: {action.pause.note}
					</p>
					{#if action.pause.nextAction}
						<p class="break-words text-muted-foreground">Потом: {action.pause.nextAction}</p>
					{/if}
				</div>
			</div>
		{/if}

		<form
			method="POST"
			action="?/resume"
			use:enhance={actionEnhance()}
			bind:this={resumeForm}
			class="hidden"
		>
			<input type="hidden" name="stageEntryId" value={action.stageEntryId} />
		</form>

		{#if action.result !== null}
			<div
				class="flex items-start gap-2 rounded-lg bg-surface-muted px-3 py-2"
				data-slot="card-result"
			>
				<div class="min-w-0 flex-1 text-sm">
					<p class="text-xs text-muted-foreground">Результат стадии</p>
					<p class="break-words whitespace-pre-line">{action.result}</p>
				</div>
				<Button size="sm" variant="ghost" onclick={() => commands.open({ kind: 'result' })}>
					Изменить
				</Button>
			</div>
		{/if}

		{#if action.allowed && action.kind !== 'resume' && missing.length === 0 && done.length > 0}
			<p class="flex items-center gap-1.5 text-sm text-success-soft-foreground">
				<CheckIcon class="size-4" aria-hidden="true" />
				Условия стадии выполнены
			</p>
		{/if}

		{#if buttonFirst}
			{@render actionRow(action)}
		{/if}

		{#if left !== null}
			<p class="text-sm font-medium" data-slot="card-action-left">{left}</p>
		{/if}

		{#if action.blockers.length > 0 || missing.length > 0 || action.otherReasons.length > 0}
			<ul class="flex flex-col divide-y divide-border rounded-lg border border-border px-3">
				{#each action.blockers as blocker (blocker.id)}
					{@render blockerRow(blocker, true)}
				{/each}
				{#each missing as item (item.key)}
					{@render requirementRow(item)}
				{/each}
				{#each action.otherReasons as reason (reason)}
					<li class="py-2 text-sm text-muted-foreground">{reason}</li>
				{/each}
			</ul>
		{/if}

		{#if !buttonFirst}
			{@render actionRow(action)}
		{/if}

		{#if optional.length > 0 || action.softBlockers.length > 0}
			<div class="flex flex-col gap-0.5">
				<p class="text-xs text-muted-foreground">Переходу не мешает, но не сделано:</p>
				<ul class="flex flex-col divide-y divide-border">
					{#each action.softBlockers as blocker (blocker.id)}
						{@render blockerRow(blocker, false)}
					{/each}
					{#each optional as item (item.key)}
						{@render requirementRow(item)}
					{/each}
				</ul>
			</div>
		{/if}

		{#if done.length > 0}
			<details class="group text-sm" data-slot="card-action-done">
				<summary
					class="w-fit cursor-pointer rounded-sm text-xs text-muted-foreground focus-ring hover:text-foreground"
				>
					Сделано на стадии: {done.length}
				</summary>
				<ul class="mt-1 flex flex-col gap-1">
					{#each done as item (item.key)}
						<li class="flex items-start gap-2">
							{#if item.close === 'check'}
								{@render checkbox(item)}
								<div class="min-w-0">
									<label for="{id}-{item.key}" class="text-muted-foreground">
										{item.label}
									</label>
									{#if item.note}
										<p class="text-xs break-words text-muted-foreground">{item.note}</p>
									{/if}
								</div>
							{:else}
								<CheckIcon class="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
								<div class="min-w-0">
									<p class="text-muted-foreground">{item.label}</p>
									{#if item.doneNote}
										<p class="text-xs break-words whitespace-pre-line text-muted-foreground">
											{item.doneNote}
										</p>
									{/if}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			</details>
		{/if}
	{/if}
</section>
