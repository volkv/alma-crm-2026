<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import ShieldIcon from '@lucide/svelte/icons/shield-check';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import ConfirmDialog from '$lib/components/confirm-dialog.svelte';
	import DateField from '$lib/components/form/date-field.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { CONSENT_BASIS_LABELS } from './labels';
	import { CONSENT_BASES, type ConsentView, type PersonView } from '$lib/contracts/directory';
	import { formatDate, formatDateTime } from '$lib/format';

	/**
	 * Персональные данные человека: на каком основании они у нас лежат, до
	 * какого дня хранятся и как их уничтожить.
	 *
	 * Панель показывается только тому, у кого есть право на учёт согласий:
	 * это не часть карточки контакта, а работа с основаниями обработки.
	 * Уничтожение внутри неё живёт по своему праву: вести основания и стирать
	 * данные — разные полномочия, и второе необратимо.
	 *
	 * Формы отправляются через `use:enhance`: действие кончается переходом на ту
	 * же карточку, и переход этот должен остаться внутри приложения — иначе
	 * страница перезагружается целиком, а вместе с ней пропадает и тост об
	 * успехе, и состояние остальных панелей.
	 */
	let {
		person,
		consents,
		today,
		anonymize
	}: {
		person: PersonView;
		consents: readonly ConsentView[];
		/** Сегодняшний день по Москве: по нему видно, что срок прошёл. */
		today: string;
		/** Можно ли уничтожить данные и почему нельзя, если нельзя. Решает сервер. */
		anonymize: { allowed: boolean; reason: string | null };
	} = $props();

	const anonymized = $derived(person.anonymizedAt !== null);
	const expired = $derived(
		!anonymized && person.retentionUntil !== null && person.retentionUntil <= today
	);
	const active = $derived(consents.filter((consent) => consent.withdrawnAt === null));

	// Начальные значения полей формы: дальше ими распоряжается человек, поэтому
	// они снимаются один раз и за свойствами не следят.
	let basis = $state<string>('consent');
	let givenAt = $state(untrack(() => today));
	let retentionUntil = $state(untrack(() => person.retentionUntil ?? ''));

	let anonymizeForm = $state<HTMLFormElement | null>(null);
	let anonymizeOpen = $state(false);
	let withdrawForm = $state<HTMLFormElement | null>(null);
	let withdrawing = $state<ConsentView | null>(null);
	let withdrawOpen = $state(false);

	function askWithdraw(consent: ConsentView) {
		withdrawing = consent;
		withdrawOpen = true;
	}
</script>

<!-- `data-tour` — метка подсказок: по ней тур находит панель оснований
	обработки на карточке человека (`$lib/onboarding/screens`). -->
<section class="rounded-lg border border-border bg-surface" data-tour="person-personal-data">
	<header
		class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3"
	>
		<h2 class="flex items-center gap-2 section-title">
			<ShieldIcon class="size-4 text-muted-foreground" aria-hidden="true" />
			Персональные данные
		</h2>
		{#if anonymized}
			<StatusBadge tone="neutral" dot>
				Обезличены {formatDateTime(person.anonymizedAt ?? new Date())}
			</StatusBadge>
		{:else if expired}
			<StatusBadge tone="warning" dot>Срок хранения истёк</StatusBadge>
		{/if}
	</header>

	<div class="flex flex-col gap-form-section p-4 sm:p-6">
		{#if anonymized}
			<InlineHint tone="info">
				Данные этого человека уничтожены: фамилия, имя и контакты стёрты, а запись оставлена ради
				ролей и взаимодействий, где он был контактом. Обратного хода у обезличивания нет.
			</InlineHint>
		{:else}
			<div class="flex flex-col gap-3">
				<h3 class="text-xs text-muted-foreground">Срок хранения</h3>
				<form
					method="POST"
					action="?/setRetention"
					use:enhance
					class="flex flex-wrap items-end gap-3"
				>
					<div class="flex flex-col gap-field">
						<Label for="retentionUntil">Хранить до</Label>
						<DateField id="retentionUntil" name="retentionUntil" bind:value={retentionUntil} />
					</div>
					<Button type="submit" variant="outline" size="sm">Сохранить срок</Button>
					<p class="w-full text-xs text-muted-foreground">
						Пустое поле означает, что срок ещё не назначен. Когда назначенный день пройдёт, запись
						попадёт в список «срок истёк» и данные можно будет уничтожить.
					</p>
				</form>
			</div>

			<div class="flex flex-col gap-3">
				<h3 class="text-xs text-muted-foreground">Согласия на обработку</h3>

				{#if consents.length === 0}
					<p class="text-sm text-muted-foreground">
						Согласий не зафиксировано: основание обработки данных не записано.
					</p>
				{:else}
					<Table.Root>
						<Table.Header>
							<Table.Row class="hover:bg-transparent">
								<Table.Head>Основание</Table.Head>
								<Table.Head>Версия текста</Table.Head>
								<Table.Head>Получено</Table.Head>
								<Table.Head>Отозвано</Table.Head>
								<Table.Head class="w-28"></Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each consents as consent (consent.id)}
								<Table.Row class="h-row">
									<Table.Cell class="font-medium">
										{CONSENT_BASIS_LABELS[consent.basis]}
									</Table.Cell>
									<Table.Cell>{consent.textVersion}</Table.Cell>
									<Table.Cell>
										{formatDate(consent.givenAt)}
										{#if consent.recordedByName}
											<span class="text-xs text-muted-foreground">· {consent.recordedByName}</span>
										{/if}
									</Table.Cell>
									<Table.Cell>
										{#if consent.withdrawnAt === null}
											<StatusBadge tone="success" dot>Действует</StatusBadge>
										{:else}
											{formatDate(consent.withdrawnAt)}
											{#if consent.withdrawnByName}
												<span class="text-xs text-muted-foreground"
													>· {consent.withdrawnByName}</span
												>
											{/if}
										{/if}
									</Table.Cell>
									<Table.Cell class="text-right">
										{#if consent.withdrawnAt === null}
											<Button variant="ghost" size="sm" onclick={() => askWithdraw(consent)}>
												Отозвать
											</Button>
										{/if}
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				{/if}

				{#if active.length === 0 && consents.length > 0}
					<InlineHint tone="warning">
						Действующих согласий нет: обработка данных этого человека сейчас ничем не обоснована.
					</InlineHint>
				{/if}

				<form
					method="POST"
					action="?/recordConsent"
					use:enhance
					class="flex flex-wrap items-end gap-3"
				>
					<div class="flex min-w-52 flex-col gap-field">
						<Label for="consentBasis">Основание</Label>
						<Select.Root type="single" name="basis" bind:value={basis}>
							<Select.Trigger id="consentBasis" class="w-full">
								{CONSENT_BASIS_LABELS[basis as ConsentView['basis']]}
							</Select.Trigger>
							<Select.Content>
								{#each CONSENT_BASES as value (value)}
									<Select.Item {value} label={CONSENT_BASIS_LABELS[value]} />
								{/each}
							</Select.Content>
						</Select.Root>
					</div>
					<div class="flex flex-col gap-field">
						<Label for="textVersion">Версия текста</Label>
						<Input id="textVersion" name="textVersion" placeholder="2026-09-01" />
					</div>
					<div class="flex flex-col gap-field">
						<Label for="givenAt">Получено</Label>
						<DateField id="givenAt" name="givenAt" bind:value={givenAt} />
					</div>
					<Button type="submit" size="sm">Зафиксировать согласие</Button>
				</form>
			</div>

			<div class="flex flex-col gap-3 border-t border-border pt-4">
				<h3 class="text-xs text-muted-foreground">Уничтожение данных</h3>
				<p class="text-sm text-muted-foreground">
					Обезличивание стирает фамилию, имя, отчество, контакты и заметки. Запись остаётся: на неё
					ссылаются роли в организациях и взаимодействия, где человек был контактом. Отменить это
					нельзя.
				</p>
				<!-- Недоступную команду не прячем: кнопка с причиной рядом объясняет
				     правило, отсутствие кнопки не объясняет ничего. Заливка при этом
				     остаётся только у того, что действительно можно нажать. -->
				<div class="flex flex-col gap-1">
					<div>
						<Button
							variant={anonymize.allowed ? 'destructive' : 'outline'}
							size="sm"
							disabled={!anonymize.allowed}
							onclick={() => (anonymizeOpen = true)}
						>
							Обезличить данные
						</Button>
					</div>
					{#if anonymize.reason}
						<p class="text-xs text-muted-foreground">{anonymize.reason}</p>
					{/if}
				</div>
			</div>
		{/if}
	</div>
</section>

{#if !anonymized}
	<!-- Формы уничтожения нет у того, кому оно не разрешено: отправить её мимо
	     выключенной кнопки было бы ровно тем, от чего право и защищает. Сервер
	     откажет и так, но и разметке незачем предлагать отказ. -->
	{#if anonymize.allowed}
		<form method="POST" action="?/anonymize" use:enhance bind:this={anonymizeForm} hidden></form>

		<ConfirmDialog
			bind:open={anonymizeOpen}
			title="Обезличить данные человека?"
			description="Фамилия, имя, отчество, контакты и заметки будут стёрты безвозвратно. Роли и история взаимодействий останутся."
			confirmLabel="Обезличить"
			tone="danger"
			onconfirm={() => anonymizeForm?.requestSubmit()}
		/>
	{/if}

	<form method="POST" action="?/withdrawConsent" use:enhance bind:this={withdrawForm} hidden>
		<input type="hidden" name="id" value={withdrawing?.id ?? ''} />
		<input type="hidden" name="withdrawnAt" value={today} />
	</form>

	<ConfirmDialog
		bind:open={withdrawOpen}
		title="Отозвать согласие?"
		description="Согласие останется в карточке с датой отзыва: оно объясняет, на каком основании данные лежали до него."
		confirmLabel="Отозвать согласие"
		onconfirm={() => withdrawForm?.requestSubmit()}
	/>
{/if}
