<script lang="ts">
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import DateField from '$lib/components/form/date-field.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import {
		EXCHANGE_STATE_LABELS,
		LEARNING_PURPOSE_LABELS,
		LEARNING_PURPOSES,
		lmsEvidenceSchema,
		type LearningGroupView,
		type LearningPurpose
	} from '$lib/contracts/exchange';
	import type { StageEntryView } from '$lib/contracts/interactions';
	import { formatDate, formatDateTime } from '$lib/format';
	import { actionEnhance } from './action-enhance';

	/**
	 * Система обучения на карточке: потоки взаимодействия, что о них известно и
	 * заявка на новый поток.
	 *
	 * Здесь различаются две вещи, которые сотрудник легко спутать: «данные
	 * получены» — система обучения прислала числа, обучение идёт, — и «обучение
	 * завершено» — пришёл итог (завершившие и дата окончания) или сотрудник
	 * отметил завершение с объяснением. Стадию подтверждает только второе.
	 */
	let { entry, canWork }: { entry: StageEntryView; canWork: boolean } = $props();

	type Offering = { id: string; code: string; name: string };

	/**
	 * Обмен приезжает загрузчиком карточки. Панель читает его из данных
	 * страницы, а не из свойства: потоки и факты обучения нужны только здесь, и
	 * тащить их через всю карточку незачем.
	 */
	const exchange = $derived(
		page.data.exchange as
			| {
					groups: LearningGroupView[];
					nextStreamNumber: number;
					programs: Offering[];
					products: Offering[];
					canSend: boolean;
					canComplete: boolean;
					issue: string | null;
			  }
			| undefined
	);

	/** Факт, которым стадия подтверждена; `null` — обучение ещё не завершено. */
	const evidence = $derived(lmsEvidenceSchema.safeParse(entry.lmsEvidence).data ?? null);

	/** Есть ли по засчитываемым группам хоть какие-то данные из системы обучения. */
	const dataReceived = $derived(
		exchange?.groups.some((group) => group.countsForStage && group.trainingState !== 'awaiting') ??
			false
	);

	const offeringLabel = (offering: Offering) => `${offering.code} — ${offering.name}`;

	let streamNumber = $state<number | null>(null);
	let plannedSeats = $state(30);
	let startsOn = $state('');
	let endsOn = $state('');
	let programId = $state('');
	let purpose = $state('');
	let chosenProducts = $state<string[]>([]);

	/**
	 * Программа, которую форма отправит: единственная подставляется сама,
	 * из нескольких выбирает сотрудник — первая попавшаяся вместо выбора учила
	 * бы не тому, о чём договаривались.
	 */
	const programs = $derived(exchange?.programs ?? []);
	const products = $derived(exchange?.products ?? []);
	const effectiveProgramId = $derived(programs.length === 1 ? programs[0].id : programId);
	const effectiveProducts = $derived(products.length === 1 ? [products[0].id] : chosenProducts);

	const programTitle = $derived(programs.find((program) => program.id === programId) ?? null);

	function toggleProduct(id: string, checked: boolean) {
		chosenProducts = checked
			? [...chosenProducts.filter((item) => item !== id), id]
			: chosenProducts.filter((item) => item !== id);
	}

	/**
	 * Отказ по заявке — у самой формы, а не тостом: тост всплывает в углу поверх
	 * полей и гаснет вместе с причиной, закрывая ровно то, что надо исправить.
	 */
	let sendRefusal = $state<{ message: string; description?: string } | null>(null);
	/** Поток, для которого открыта форма отметки «обучение завершено». */
	let completing = $state<string | null>(null);

	/** Что известно об обучении потока — коротко, для значка. */
	const TRAINING_LABELS = {
		completed: 'Обучение завершено',
		in_progress: 'Данные получены, обучение идёт',
		awaiting: 'Результатов пока нет'
	} as const;

	/** Судьба заявки словами: пока результатов нет, важна именно она. */
	const requestLabel = (group: LearningGroupView) =>
		group.messageState === null
			? 'заявка не отправлялась'
			: `заявка: ${EXCHANGE_STATE_LABELS[group.messageState].toLowerCase()}`;
</script>

<Card.Root size="sm" class="lg:col-span-2" data-testid="learning-groups">
	<Card.Header>
		<Card.Title>Система обучения</Card.Title>
		<Card.Description>
			Поток заводится заявкой в систему обучения и закрепляет программу, продукты и то, для кого
			обучение. Стадию подтверждает итог потока: завершившие и дата окончания. Промежуточные данные
			видны здесь, но стадию не закрывают; переход дальше — решение сотрудника.
		</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-4">
		{#if entry.snapshot.requiresLmsData}
			{#if evidence === null}
				<InlineHint tone="warning">
					{dataReceived
						? 'Данные из системы обучения получены, но обучение ещё не завершено: стадию подтвердит итоговый результат потока (завершившие и дата окончания) или отметка «Обучение завершено».'
						: 'Стадии нужен итог обучения из системы обучения — его ещё не получали.'}
				</InlineHint>
			{:else if evidence.kind === 'result'}
				<InlineHint tone="info">
					Обучение завершено: группа {evidence.groupExternalId}, зачислено {evidence.enrolled},
					завершили
					{evidence.completed}, отчислены {evidence.expelled}{evidence.finishedOn === null
						? ''
						: `, окончание ${formatDate(new Date(evidence.finishedOn))}`}. Итог от {formatDateTime(
						new Date(evidence.occurredAt)
					)}.
				</InlineHint>
			{:else}
				<InlineHint tone="info">
					Обучение завершено отметкой сотрудника по потоку {evidence.streamNumber}
					{formatDateTime(new Date(evidence.markedAt))}: «{evidence.comment}».
				</InlineHint>
			{/if}
		{/if}

		{#if exchange !== undefined && exchange.groups.length > 0}
			<ul class="flex flex-col gap-2 text-sm">
				{#each exchange.groups as group (group.id)}
					<li
						class="flex flex-col gap-1 rounded-md border border-border p-3"
						data-testid="learning-group"
					>
						<p class="flex flex-wrap items-center gap-2 font-medium">
							<span>
								Поток {group.streamNumber}
								{#if group.groupExternalId !== null}
									· группа <span class="font-mono">{group.groupExternalId}</span>
								{/if}
							</span>
							<StatusBadge
								tone={group.trainingState === 'completed'
									? 'success'
									: group.trainingState === 'in_progress'
										? 'info'
										: 'neutral'}
								dot
							>
								{TRAINING_LABELS[group.trainingState]}
							</StatusBadge>
						</p>
						<p class="text-xs text-muted-foreground">
							{group.program === null
								? 'Программа не закреплена'
								: `Программа ${offeringLabel(group.program)}`}
							{#if group.products.length > 0}
								· продукты: {group.products.map((product) => product.code).join(', ')}
							{/if}
							· {group.purpose === null
								? 'назначение не указано'
								: LEARNING_PURPOSE_LABELS[group.purpose].toLowerCase()}
							{#if group.plannedSeats !== null}
								· мест {group.plannedSeats}
							{/if}
							· {requestLabel(group)}
						</p>
						<!-- Три числа, а не два: «отчислены» теряется ровно там, где его и
							ищут — рядом с зачисленными и завершившими. -->
						{#if group.enrolled !== null && group.completed !== null && group.expelled !== null}
							<p class="text-xs text-muted-foreground">
								Зачислено {group.enrolled}, завершили {group.completed}, отчислены {group.expelled}
								{#if group.finishedOn !== null}
									· окончание {formatDate(new Date(group.finishedOn))}
								{/if}
								{#if group.lastResultAt !== null}
									· данные от {formatDateTime(group.lastResultAt)}
								{/if}
							</p>
						{/if}
						{#if group.completionMark !== null}
							<p class="text-xs text-muted-foreground">
								Отметил {group.completionMark.byName ?? 'сотрудник'}
								{formatDateTime(group.completionMark.at)}: «{group.completionMark.comment}»
							</p>
						{/if}
						{#if !group.countsForStage}
							<p class="text-xs text-warning-soft-foreground">
								{group.program === null
									? 'Программа группы не закреплена — стадию эта группа не подтверждает.'
									: 'Программа группы больше не входит во взаимодействие — стадию эта группа не подтверждает.'}
							</p>
						{/if}
						{#if group.lastError !== null}
							<p class="text-xs text-danger-soft-foreground">{group.lastError}</p>
						{/if}

						{#if exchange.canComplete && canWork && group.trainingState !== 'completed'}
							{#if completing === group.id}
								<form
									method="POST"
									action="?/completeGroup"
									use:enhance={actionEnhance({ onsuccess: () => (completing = null) })}
									class="mt-2 flex flex-col gap-2"
								>
									<input type="hidden" name="learningGroupId" value={group.id} />
									<Label for="completion-{group.id}">Почему обучение завершено без итога</Label>
									<Textarea
										id="completion-{group.id}"
										name="comment"
										rows={2}
										placeholder="Например: итоговая ведомость получена бумагой, 24 из 25 завершили"
									/>
									<div class="flex justify-end gap-2">
										<Button
											type="button"
											size="sm"
											variant="ghost"
											onclick={() => (completing = null)}
										>
											Отмена
										</Button>
										<Button type="submit" size="sm">Отметить обучение завершённым</Button>
									</div>
								</form>
							{:else}
								<div class="flex justify-end">
									<Button
										type="button"
										size="sm"
										variant="outline"
										onclick={() => (completing = group.id)}
									>
										Обучение завершено…
									</Button>
								</div>
							{/if}
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		{#if exchange !== undefined}
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
				method="POST"
				action="?/sendGroup"
				onsubmit={() => (sendRefusal = null)}
				use:enhance={actionEnhance({
					onfailure: (refusal) => (sendRefusal = refusal),
					onsuccess: () => (sendRefusal = null)
				})}
				class="grid items-end gap-3 sm:grid-cols-4"
			>
				<div class="flex flex-col gap-1.5 sm:col-span-2">
					<Label for="programId">Программа</Label>
					{#if programs.length === 1}
						<p id="programId" class="text-sm">{offeringLabel(programs[0])}</p>
					{:else if programs.length === 0}
						<p id="programId" class="text-sm text-muted-foreground">
							У взаимодействия нет программ
						</p>
					{:else}
						<Select.Root type="single" bind:value={programId}>
							<Select.Trigger id="programId" class="w-full">
								{programTitle === null ? 'Выберите программу' : offeringLabel(programTitle)}
							</Select.Trigger>
							<Select.Content>
								{#each programs as program (program.id)}
									<Select.Item value={program.id} label={offeringLabel(program)} />
								{/each}
							</Select.Content>
						</Select.Root>
					{/if}
					<input type="hidden" name="programId" value={effectiveProgramId} />
				</div>
				<div class="flex flex-col gap-1.5 sm:col-span-2">
					<Label for="purpose">Для кого обучение</Label>
					<Select.Root type="single" bind:value={purpose}>
						<Select.Trigger id="purpose" class="w-full">
							{purpose === '' ? 'Выберите' : LEARNING_PURPOSE_LABELS[purpose as LearningPurpose]}
						</Select.Trigger>
						<Select.Content>
							{#each LEARNING_PURPOSES as value (value)}
								<Select.Item {value} label={LEARNING_PURPOSE_LABELS[value]} />
							{/each}
						</Select.Content>
					</Select.Root>
					<input type="hidden" name="purpose" value={purpose} />
				</div>
				{#if products.length > 0}
					<fieldset class="flex flex-col gap-1.5 sm:col-span-4">
						<legend class="mb-1.5 text-sm font-medium">Продукты</legend>
						{#if products.length === 1}
							<p class="text-sm">{offeringLabel(products[0])}</p>
						{:else}
							<div class="flex flex-wrap gap-x-4 gap-y-2">
								{#each products as product (product.id)}
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
					<Label for="streamNumber">Поток</Label>
					<Input
						id="streamNumber"
						name="streamNumber"
						type="number"
						min="1"
						value={streamNumber ?? exchange.nextStreamNumber}
						oninput={(event) =>
							(streamNumber = Number((event.currentTarget as HTMLInputElement).value))}
					/>
				</div>
				<div class="flex flex-col gap-1.5">
					<Label for="plannedSeats">Мест в потоке</Label>
					<Input
						id="plannedSeats"
						name="plannedSeats"
						type="number"
						min="1"
						bind:value={plannedSeats}
					/>
				</div>
				<div class="flex flex-col gap-1.5">
					<Label for="startsOn">Начало занятий</Label>
					<DateField id="startsOn" name="startsOn" max={endsOn} bind:value={startsOn} />
				</div>
				<div class="flex flex-col gap-1.5">
					<Label for="endsOn">Окончание</Label>
					<DateField id="endsOn" name="endsOn" min={startsOn} bind:value={endsOn} />
				</div>
				<div class="flex justify-end sm:col-span-4">
					<Button type="submit" size="sm" disabled={!exchange.canSend || exchange.issue !== null}>
						Отправить в LMS
					</Button>
				</div>
			</form>
		{/if}
	</Card.Content>
</Card.Root>
