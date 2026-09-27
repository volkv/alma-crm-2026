<script lang="ts">
	import DownloadIcon from '@lucide/svelte/icons/download';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import XIcon from '@lucide/svelte/icons/x';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { untrack } from 'svelte';
	import { applyAction, enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import DateField from '$lib/components/form/date-field.svelte';
	import FileInput from '$lib/components/form/file-input.svelte';
	import FormDialog from '$lib/components/form-dialog.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import StatusBadge, { type StatusTone } from '$lib/components/status-badge.svelte';
	import {
		actionEnhance,
		describeActionFailure
	} from '$lib/components/interactions/action-enhance';
	import {
		LEARNER_STATUS_LABELS,
		LEARNING_PURPOSE_LABELS,
		LEARNING_PURPOSES,
		ROSTER_FILE_FORMATS_HINT,
		ROSTER_ROW_ACTION_LABELS,
		ROSTER_ROW_ACTIONS,
		type LearningPurpose,
		type RosterRowAction,
		type RosterView
	} from '$lib/contracts/exchange';
	import type { OrganizationKind } from '$lib/contracts/directory';
	import type { InteractionView } from '$lib/contracts/interactions';
	import { pluralForm, pluralize } from '$lib/format';
	import { getCardCommands } from './commands.svelte';
	import { purposeCountingStages, type CardExchange, type CardOffering } from './model';

	/**
	 * Диалоги системы обучения: заявка на поток и отметка «обучение завершено».
	 *
	 * Заявку подаёт сотрудник, а не переход по стадии: число мест и даты
	 * подтверждает человек, и ошибочный переход не должен превращаться в группу
	 * в чужой системе. Отметка нужна там, где итога из системы обучения нет, а
	 * обучение закончилось, — поэтому без объяснения её не поставить.
	 *
	 * Форма заявки подставляет то, что дело уже знает: даты занятий — учебный
	 * период из «Сроков», а физическому лицу одно место — он учится сам.
	 */
	let {
		exchange,
		interaction,
		counterpartyKind
	}: {
		exchange: CardExchange;
		interaction: InteractionView;
		counterpartyKind: OrganizationKind;
	} = $props();

	/** Физическое лицо учится само: одно место, и слушатель — он же. */
	const individual = $derived(counterpartyKind === 'individual');
	const counterpartyName = $derived(
		interaction.parties.find((party) => party.isPrimary)?.organizationName ?? null
	);

	const commands = getCardCommands();

	const opened = (kind: Parameters<typeof commands.is>[0]) => ({
		get: () => commands.is(kind),
		set: (next: boolean) => {
			if (!next) commands.close();
		}
	});

	const sendOpen = opened('send-group');
	const completeOpen = opened('complete-group');
	const rosterOpen = opened('roster');

	const offeringLabel = (offering: CardOffering) => `${offering.code} — ${offering.name}`;

	/**
	 * Назначения потока и стадии, которые засчитают его итог. Выбрать можно
	 * любое: поток преподавателей в процессе работы с вузом законен, даже если
	 * стадию с данными обучения подтверждает только поток студентов. Но
	 * засчитываемые помечены, а единственное засчитываемое подставлено сразу —
	 * иначе поток легко завести так, что стадию он не подтвердит никогда.
	 */
	const purposeOptions = $derived(
		LEARNING_PURPOSES.map((value) => {
			const stages = purposeCountingStages(exchange.learningStages, value);
			const mark =
				stages === null || stages.length === 0
					? ''
					: ` — засчитывает ${stages.length === 1 ? 'стадия' : 'стадии'} ${stages.map((name) => `«${name}»`).join(', ')}`;

			return {
				value,
				label: `${LEARNING_PURPOSE_LABELS[value]}${mark}`,
				counts: stages === null || stages.length > 0
			};
		})
	);
	/** Назначение, которое форма подставляет сама; `''` — выбирает сотрудник. */
	const defaultPurpose = $derived.by(() => {
		const counted = purposeOptions.filter((option) => option.counts);

		return counted.length === 1 ? counted[0].value : '';
	});
	const purposeCounts = $derived(
		purposeOptions.find((option) => option.value === purpose)?.counts ?? true
	);

	/** Потоки, которые ещё можно отметить завершёнными. */
	const unfinished = $derived(
		exchange.groups.filter((group) => group.trainingState !== 'completed')
	);

	let streamNumber = $state(0);
	let plannedSeats = $state(30);
	let startsOn = $state('');
	let endsOn = $state('');
	let programId = $state('');
	let purpose = $state('');
	let chosenProducts = $state<string[]>([]);
	let completeGroupId = $state('');
	let completeComment = $state('');
	/**
	 * Отказ по заявке — у самой формы, а не тостом: тост всплывает в углу поверх
	 * полей и гаснет вместе с причиной, закрывая ровно то, что надо исправить.
	 */
	let sendRefusal = $state<{ message: string; description?: string } | null>(null);
	/** Предпросмотр или итог загрузки списка; `null` — файл ещё не проверяли. */
	let roster = $state<RosterView | null>(null);
	/** Показанный `roster` — итог загрузки, а не предпросмотр: загружать нечего. */
	let rosterLoaded = $state(false);
	let rosterRefusal = $state<{ message: string; description?: string } | null>(null);

	$effect(() => {
		const current = commands.current;

		untrack(() => {
			if (current === null) return;

			streamNumber = exchange.nextStreamNumber;
			plannedSeats = individual ? 1 : 30;
			startsOn = interaction.academicPeriodStart ?? '';
			endsOn = interaction.academicPeriodEnd ?? '';
			programId = '';
			purpose = defaultPurpose;
			chosenProducts = [];
			sendRefusal = null;
			roster = null;
			rosterLoaded = false;
			rosterRefusal = null;
			completeComment = '';
			completeGroupId =
				current.kind === 'complete-group'
					? (current.groupId ?? (unfinished.length === 1 ? unfinished[0].id : ''))
					: '';
		});
	});

	/**
	 * Программа, которую форма отправит: единственная подставляется сама, из
	 * нескольких выбирает сотрудник — первая попавшаяся вместо выбора учила бы
	 * не тому, о чём договаривались.
	 */
	const effectiveProgramId = $derived(
		exchange.programs.length === 1 ? exchange.programs[0].id : programId
	);
	const effectiveProducts = $derived(
		exchange.products.length === 1 ? [exchange.products[0].id] : chosenProducts
	);
	const programTitle = $derived(
		exchange.programs.find((program) => program.id === programId) ?? null
	);
	const completing = $derived(
		exchange.groups.find((group) => group.id === completeGroupId) ?? null
	);

	/** Поток, чей список открыт. */
	const rosterGroup = $derived.by(() => {
		const current = commands.current;

		return current?.kind === 'roster'
			? (exchange.groups.find((group) => group.id === current.groupId) ?? null)
			: null;
	});
	const rosterLearners = $derived(
		exchange.learners === null || rosterGroup === null
			? null
			: exchange.learners.filter((learner) => learner.learningGroupId === rosterGroup.id)
	);
	/**
	 * Книга потока по шаблону загрузки пользователей LMS. Адрес — от страницы
	 * карточки, на которой диалог и живёт, как у живой карточки (`live.svelte.ts`).
	 */
	const rosterExportHref = $derived.by(() => {
		const { workspace, id } = page.params;

		if (workspace === undefined || id === undefined || rosterGroup === null) {
			return null;
		}

		const path = resolve('/(app)/w/[workspace]/interactions/[id=uuid]/files/[module]/[file]', {
			workspace,
			id,
			module: 'learning',
			file: 'roster.xlsx'
		});

		return `${path}?group=${encodeURIComponent(rosterGroup.id)}`;
	});
	/** Сколько слушателей потока не попадут в выгрузку: отозвали согласие. */
	const rosterWithdrawn = $derived(
		rosterGroup === null ? 0 : (exchange.withdrawnLearners[rosterGroup.id] ?? 0)
	);
	/** Сколько строк файла загрузка возьмёт: новые люди и найденные в справочнике. */
	const rosterLoadable = $derived(roster === null ? 0 : roster.counts.create + roster.counts.link);

	const ROW_TONES: Record<RosterRowAction, StatusTone> = {
		create: 'accent',
		link: 'info',
		present: 'neutral',
		error: 'danger'
	};

	/**
	 * Проверка и загрузка файла — одна форма с двумя кнопками: подтверждение
	 * присылает тот же файл ещё раз, и сервер разбирает его тем же разбором, что
	 * и предпросмотр. Поэтому форма после ответа не очищается: файл нужен
	 * второй кнопке.
	 */
	const rosterEnhance: SubmitFunction = ({ action }) => {
		const loading = action.search.includes('rosterImport');

		rosterRefusal = null;

		return async ({ result, update }) => {
			if (result.type === 'failure') {
				rosterRefusal = describeActionFailure(result.data);

				return;
			}

			if (result.type === 'success') {
				roster = (result.data?.roster as RosterView | undefined) ?? null;
				rosterLoaded = loading;

				if (loading) {
					await update({ reset: false });
				}

				return;
			}

			await applyAction(result);
		};
	};

	function toggleProduct(id: string, checked: boolean) {
		chosenProducts = checked
			? [...chosenProducts.filter((item) => item !== id), id]
			: chosenProducts.filter((item) => item !== id);
	}
</script>

<FormDialog
	bind:open={sendOpen.get, sendOpen.set}
	title="Заявить поток в систему обучения"
	description="Поток закрепляет программу, продукты и то, для кого обучение. Стадию подтвердит его итог: завершившие и дата окончания."
	dirty={purpose !== defaultPurpose ||
		startsOn !== (interaction.academicPeriodStart ?? '') ||
		endsOn !== (interaction.academicPeriodEnd ?? '')}
	width="lg"
>
	<div class="flex flex-col gap-3">
		{#if exchange.issue !== null}
			<InlineHint tone="warning">{exchange.issue}</InlineHint>
		{/if}

		{#if sendRefusal !== null}
			<Alert.Root variant="destructive">
				<TriangleAlertIcon aria-hidden="true" />
				<Alert.Title>{sendRefusal.message}</Alert.Title>
				{#if sendRefusal.description}
					<Alert.Description>{sendRefusal.description}</Alert.Description>
				{/if}
			</Alert.Root>
		{/if}

		<form
			id="card-send-group-form"
			method="POST"
			action="?/sendGroup"
			onsubmit={() => (sendRefusal = null)}
			use:enhance={actionEnhance({
				onfailure: (refusal) => (sendRefusal = refusal),
				onsuccess: () => commands.close()
			})}
			class="grid items-end gap-3 sm:grid-cols-2"
		>
			<div class="flex flex-col gap-1.5">
				<Label for="card-program">Программа</Label>
				{#if exchange.programs.length === 1}
					<p id="card-program" class="text-sm">{offeringLabel(exchange.programs[0])}</p>
				{:else if exchange.programs.length === 0}
					<p id="card-program" class="text-sm text-muted-foreground">
						У взаимодействия нет программ
					</p>
				{:else}
					<Select.Root type="single" bind:value={programId}>
						<Select.Trigger id="card-program" class="w-full">
							<span class="truncate">
								{programTitle === null ? 'Выберите программу' : offeringLabel(programTitle)}
							</span>
						</Select.Trigger>
						<Select.Content>
							{#each exchange.programs as program (program.id)}
								<Select.Item value={program.id} label={offeringLabel(program)} />
							{/each}
						</Select.Content>
					</Select.Root>
				{/if}
				<input type="hidden" name="programId" value={effectiveProgramId} />
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="card-purpose">Для кого обучение</Label>
				<Select.Root type="single" bind:value={purpose}>
					<Select.Trigger id="card-purpose" class="w-full">
						{purpose === '' ? 'Выберите' : LEARNING_PURPOSE_LABELS[purpose as LearningPurpose]}
					</Select.Trigger>
					<Select.Content>
						{#each purposeOptions as option (option.value)}
							<Select.Item value={option.value} label={option.label} />
						{/each}
					</Select.Content>
				</Select.Root>
				<input type="hidden" name="purpose" value={purpose} />
				{#if !purposeCounts}
					<InlineHint tone="warning">
						Стадию такой поток не подтвердит: итог засчитывается только у назначений с пометкой.
					</InlineHint>
				{/if}
			</div>
			{#if exchange.products.length > 0}
				<fieldset class="flex flex-col gap-1.5 sm:col-span-2">
					<legend class="mb-1.5 text-sm font-medium">Продукты</legend>
					{#if exchange.products.length === 1}
						<p class="text-sm">{offeringLabel(exchange.products[0])}</p>
					{:else}
						<div class="flex flex-wrap gap-x-4 gap-y-2">
							{#each exchange.products as product (product.id)}
								<Label class="flex items-center gap-2 font-normal">
									<Checkbox
										checked={chosenProducts.includes(product.id)}
										onCheckedChange={(checked) => toggleProduct(product.id, checked === true)}
									/>
									{offeringLabel(product)}
								</Label>
							{/each}
						</div>
					{/if}
					{#each effectiveProducts as id (id)}
						<input type="hidden" name="productIds" value={id} />
					{/each}
				</fieldset>
			{/if}
			<div class="flex flex-col gap-1.5">
				<Label for="card-stream-number">Поток</Label>
				<Input
					id="card-stream-number"
					name="streamNumber"
					type="number"
					min="1"
					bind:value={streamNumber}
				/>
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="card-planned-seats">Мест в потоке</Label>
				<Input
					id="card-planned-seats"
					name="plannedSeats"
					type="number"
					min="1"
					bind:value={plannedSeats}
				/>
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="card-starts-on">Начало занятий</Label>
				<DateField id="card-starts-on" name="startsOn" max={endsOn} bind:value={startsOn} />
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="card-ends-on">Окончание</Label>
				<DateField id="card-ends-on" name="endsOn" min={startsOn} bind:value={endsOn} />
			</div>
			{#if interaction.academicPeriodStart !== null || interaction.academicPeriodEnd !== null}
				<p class="text-xs text-muted-foreground sm:col-span-2">
					Даты подставлены из учебного периода в «Сроках» дела — поправьте, если поток идёт иначе.
				</p>
			{/if}
		</form>
	</div>

	{#snippet footer({ close })}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="outline" onclick={close}>Отмена</Button>
			<Button
				type="submit"
				form="card-send-group-form"
				disabled={!exchange.canSend || exchange.issue !== null}
			>
				Отправить в LMS
			</Button>
		</div>
	{/snippet}
</FormDialog>

<FormDialog
	bind:open={completeOpen.get, completeOpen.set}
	title="Обучение завершено"
	description="Итога из системы обучения нет, а обучение закончилось. Объяснение обязательно: оно останется на потоке и в ленте."
	dirty={completeComment.trim() !== ''}
>
	<form
		id="card-complete-group-form"
		method="POST"
		action="?/completeGroup"
		use:enhance={actionEnhance({ onsuccess: () => commands.close() })}
		class="flex flex-col gap-3"
	>
		<div class="flex flex-col gap-1.5">
			<Label for="card-complete-group">Поток</Label>
			<Select.Root type="single" bind:value={completeGroupId}>
				<Select.Trigger id="card-complete-group" class="w-full">
					{completing === null
						? 'Выберите поток'
						: `Поток ${completing.streamNumber}${completing.groupExternalId ? ` · группа ${completing.groupExternalId}` : ''}`}
				</Select.Trigger>
				<Select.Content>
					{#each unfinished as group (group.id)}
						<Select.Item
							value={group.id}
							label={`Поток ${group.streamNumber}${group.groupExternalId ? ` · группа ${group.groupExternalId}` : ''}`}
						/>
					{/each}
				</Select.Content>
			</Select.Root>
			<input type="hidden" name="learningGroupId" value={completeGroupId} />
		</div>
		<div class="flex flex-col gap-1.5">
			<Label for="card-complete-comment">Почему обучение завершено без итога</Label>
			<Textarea
				id="card-complete-comment"
				name="comment"
				rows={3}
				placeholder="Например: итоговая ведомость получена бумагой, 24 из 25 завершили"
				bind:value={completeComment}
			/>
		</div>
	</form>

	{#snippet footer({ close })}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="outline" onclick={close}>Отмена</Button>
			<Button type="submit" form="card-complete-group-form" disabled={completing === null}>
				Отметить обучение завершённым
			</Button>
		</div>
	{/snippet}
</FormDialog>

<FormDialog
	bind:open={rosterOpen.get, rosterOpen.set}
	title={rosterGroup === null ? 'Слушатели потока' : `Слушатели потока ${rosterGroup.streamNumber}`}
	description="Поимённый список группы: загружается файлом, передаётся в систему обучения кнопкой. Люди узнаются по почте — второй записи об одном человеке загрузка не заводит."
	width="xl"
>
	<div class="flex flex-col gap-4">
		{#if rosterRefusal !== null}
			<Alert.Root variant="destructive">
				<TriangleAlertIcon aria-hidden="true" />
				<Alert.Title>{rosterRefusal.message}</Alert.Title>
				{#if rosterRefusal.description}
					<Alert.Description>{rosterRefusal.description}</Alert.Description>
				{/if}
			</Alert.Root>
		{/if}

		<section class="flex flex-col gap-2" aria-labelledby="card-roster-list-title">
			<h3 id="card-roster-list-title" class="text-sm font-medium">
				В списке: {rosterGroup?.learnerCount ?? 0}, передано в LMS: {rosterGroup?.transferredCount ??
					0}
			</h3>
			{#if rosterLearners === null}
				<p class="text-sm text-muted-foreground">
					Имена слушателей видны тем, кому открыт справочник людей.
				</p>
			{:else if rosterLearners.length === 0}
				<p class="text-sm text-muted-foreground">
					{individual
						? 'Список пуст: слушатель — сам контрагент, добавьте его кнопкой.'
						: 'Список пуст: загрузите файл ниже.'}
				</p>
			{:else}
				{#if exchange.canExportRoster && rosterExportHref !== null}
					<div class="flex flex-col gap-2">
						<div>
							<Button
								variant="outline"
								size="sm"
								href={rosterExportHref}
								download
								data-sveltekit-reload
							>
								<DownloadIcon aria-hidden="true" />
								Выгрузить для LMS (xlsx)
							</Button>
						</div>
						<InlineHint>
							Заполнены фамилия, имя, отчество, телефон и email. СНИЛС, паспорт, пол, дата рождения,
							адрес, ФИО в дательном падеже, образование и диплом CRM не собирает (минимизация
							персональных данных) — дозаполните перед загрузкой в LMS. Заголовки совпадают с
							шаблоном LMS.
						</InlineHint>
						{#if rosterWithdrawn > 0}
							<InlineHint tone="warning">
								{pluralize(rosterWithdrawn, ['человек', 'человека', 'человек'])}
								{pluralForm(rosterWithdrawn, ['не выгружен', 'не выгружены', 'не выгружены'])}:
								отозвано согласие.
							</InlineHint>
						{/if}
					</div>
				{/if}
				<ul class="flex max-h-64 flex-col divide-y overflow-y-auto rounded-md border">
					{#each rosterLearners as learner (learner.personId)}
						<li class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
							<span class="min-w-0 flex-1 break-words">
								{learner.fullName}
								<span class="block text-xs break-all text-muted-foreground">
									{[learner.email, learner.phone].filter((part) => part !== null).join(' · ')}
								</span>
							</span>
							<StatusBadge tone={learner.status === 'transferred' ? 'success' : 'warning'} dot>
								{LEARNER_STATUS_LABELS[learner.status]}
							</StatusBadge>
							{#if exchange.canManageRoster}
								<form
									method="POST"
									action="?/rosterRemove"
									use:enhance={actionEnhance()}
									class="contents"
								>
									<input type="hidden" name="learningGroupId" value={learner.learningGroupId} />
									<input type="hidden" name="personId" value={learner.personId} />
									<Button
										type="submit"
										size="icon-xs"
										variant="ghost"
										aria-label="Убрать {learner.fullName} из списка"
										title="Убрать из списка"
									>
										<XIcon aria-hidden="true" />
									</Button>
								</form>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		{#if exchange.canManageRoster && rosterGroup !== null && individual && rosterGroup.learnerCount === 0}
			<form
				method="POST"
				action="?/rosterAddCounterparty"
				use:enhance={actionEnhance({ onfailure: (refusal) => (rosterRefusal = refusal) })}
			>
				<input type="hidden" name="learningGroupId" value={rosterGroup.id} />
				<Button type="submit" variant="outline" size="sm">
					Добавить слушателем{counterpartyName === null ? ' контрагента' : `: ${counterpartyName}`}
				</Button>
			</form>
		{/if}

		{#if exchange.canManageRoster && rosterGroup !== null}
			<form
				id="card-roster-form"
				method="POST"
				action="?/rosterPreview"
				enctype="multipart/form-data"
				use:enhance={rosterEnhance}
				class="flex flex-col gap-3"
			>
				<input type="hidden" name="learningGroupId" value={rosterGroup.id} />
				<FileInput
					id="card-roster-file"
					name="file"
					label="Файл списка"
					description="{ROSTER_FILE_FORMATS_HINT}; вместо «ФИО» подойдут отдельные «Фамилия», «Имя», «Отчество». Телефон — по желанию, первая строка — названия колонок. Книга, выгруженная кнопкой «Выгрузить для LMS», загружается обратно как есть."
					accept=".xls,.xlsx,.csv,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
					required
					onchoose={() => {
						roster = null;
						rosterLoaded = false;
					}}
				/>
				<div class="flex flex-wrap gap-2">
					<Button type="submit" variant="outline">Проверить файл</Button>
					{#if roster !== null && !rosterLoaded && rosterLoadable > 0}
						<Button type="submit" formaction="?/rosterImport">
							Загрузить строк: {rosterLoadable}
						</Button>
					{/if}
				</div>
			</form>

			{#if roster !== null}
				<section class="flex flex-col gap-2" aria-labelledby="card-roster-preview-title">
					<h3 id="card-roster-preview-title" class="text-sm font-medium">
						{rosterLoaded ? 'Список загружен' : 'Что станет со строками файла'}
					</h3>
					{#each roster.fileIssues as issue (issue)}
						<InlineHint tone="warning">{issue}</InlineHint>
					{/each}
					<p class="text-xs text-muted-foreground">
						{ROSTER_ROW_ACTIONS.map(
							(action) => `${ROSTER_ROW_ACTION_LABELS[action]}: ${roster?.counts[action] ?? 0}`
						).join(' · ')}
					</p>
					{#if roster.rows.length > 0}
						<ul class="flex max-h-72 flex-col divide-y overflow-y-auto rounded-md border">
							{#each roster.rows as row (row.rowNo)}
								<li class="flex flex-col gap-0.5 px-3 py-2 text-sm">
									<div class="flex flex-wrap items-center gap-2">
										<span class="text-xs text-muted-foreground tabular-nums"
											>строка {row.rowNo}</span
										>
										<span class="min-w-0 flex-1 break-words">{row.fullName || '—'}</span>
										<StatusBadge tone={ROW_TONES[row.action]}>
											{ROSTER_ROW_ACTION_LABELS[row.action]}
										</StatusBadge>
									</div>
									<span class="text-xs break-all text-muted-foreground">
										{[row.email, row.phone].filter((part) => part !== null).join(' · ')}
									</span>
									{#each row.issues as issue (issue)}
										<span class="text-xs text-danger-soft-foreground">{issue}</span>
									{/each}
								</li>
							{/each}
						</ul>
					{/if}
				</section>
			{/if}
		{/if}
	</div>

	{#snippet footer({ close })}
		<div class="flex flex-wrap justify-end gap-2">
			<Button type="button" variant="outline" onclick={close}>Закрыть</Button>
			{#if rosterGroup !== null}
				<form
					method="POST"
					action="?/rosterSend"
					use:enhance={actionEnhance({ onfailure: (refusal) => (rosterRefusal = refusal) })}
				>
					<input type="hidden" name="learningGroupId" value={rosterGroup.id} />
					<Button
						type="submit"
						disabled={!exchange.canSend}
						title={exchange.canSend ? undefined : 'Нет права на отправку в систему обучения'}
					>
						Передать список в LMS
					</Button>
				</form>
			{/if}
		</div>
	{/snippet}
</FormDialog>
