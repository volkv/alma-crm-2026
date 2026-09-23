<script lang="ts">
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import { Button } from '$lib/components/ui/button/index.js';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import type { OrganizationView } from '$lib/contracts/directory';
	import type { InteractionView, StageEntryView } from '$lib/contracts/interactions';
	import { formatDate } from '$lib/format';
	import ContactLine from './contact-line.svelte';
	import ContextSection from './context-section.svelte';

	/**
	 * Контекст обучения физического или юридического лица: кто учится, по какой
	 * программе, в какие сроки и оплачено ли. Имя контрагента стоит в шапке
	 * карточки — здесь реквизиты и контакт.
	 *
	 * Оплата — факт процесса, а не поле записи: её отмечают пунктом чек-листа
	 * стадии «Договор и оплата», и панель читает его оттуда. Стоимости в записи
	 * нет вовсе — строка говорит об этом, а не прячется.
	 */
	let {
		interaction,
		organization,
		entries,
		onEditPlan
	}: {
		interaction: InteractionView;
		organization: OrganizationView | null;
		/** Записи стадий, новые первыми: из них берётся отметка об оплате. */
		entries: readonly StageEntryView[];
		/** Открыть правку названия и сроков; `null` — права на правку нет. */
		onEditPlan: (() => void) | null;
	} = $props();

	const PAYMENT_STAGE = 'contract_payment';
	const PAYMENT_ITEM = 'payment_received';

	const learner = $derived(interaction.parties.find((party) => party.isPrimary) ?? null);
	const isPerson = $derived(organization?.kind === 'individual');

	const payment = $derived.by(() => {
		const entry = entries.find((candidate) => candidate.snapshot.key === PAYMENT_STAGE);

		if (entry === undefined) {
			return { tone: 'neutral', text: 'Впереди: договор ещё не заключён' } as const;
		}

		// Пока стадия открыта, отметка об оплате — условие перехода, и названа
		// она у главного действия; второй раз её здесь не показываем.
		if (entry.leftAt === null) {
			return { tone: 'neutral', text: 'Отмечается на текущей стадии' } as const;
		}

		return entry.checklistState[PAYMENT_ITEM] === true
			? ({ tone: 'success', text: 'Оплата получена' } as const)
			: ({ tone: 'warning', text: 'Ждём оплату' } as const);
	});

	const period = (start: string | null, end: string | null) =>
		start === null && end === null
			? null
			: `${start === null ? '…' : formatDate(start)} — ${end === null ? '…' : formatDate(end)}`;
	const agreement = $derived(
		period(interaction.agreementPeriodStart, interaction.agreementPeriodEnd)
	);
	const academic = $derived(period(interaction.academicPeriodStart, interaction.academicPeriodEnd));
</script>

<div class="flex flex-col gap-5" data-slot="learner-panel">
	<ContextSection title={isPerson ? 'Слушатель' : 'Компания'}>
		{#if organization !== null && !isPerson}
			<div class="flex flex-col gap-0.5 text-sm">
				<p class="break-words">{organization.legalName}</p>
				<p class="text-xs text-muted-foreground">
					{[organization.region, organization.inn ? `ИНН ${organization.inn}` : null]
						.filter((part) => part !== null)
						.join(' · ')}
				</p>
			</div>
		{/if}
		{#if learner !== null}
			<ContactLine party={learner} />
		{/if}
	</ContextSection>

	<ContextSection title="Программа">
		<ul class="flex flex-col gap-1 text-sm">
			{#each interaction.programs as program (program.programId)}
				<li class="break-words">
					<span class="text-muted-foreground tabular-nums">{program.code}</span>
					{program.name}
				</li>
			{/each}
		</ul>
		{#if interaction.products.length > 0}
			<p class="text-xs text-muted-foreground">
				Продукты: {interaction.products.map((product) => product.name).join(', ')}
			</p>
		{/if}
	</ContextSection>

	<ContextSection title="Стоимость и оплата">
		<dl class="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-sm">
			<dt class="text-muted-foreground">Стоимость</dt>
			<dd class="text-faint">в записи не указана</dd>
			<dt class="text-muted-foreground">Оплата</dt>
			<dd><StatusBadge tone={payment.tone} dot>{payment.text}</StatusBadge></dd>
		</dl>
	</ContextSection>

	<ContextSection title="Сроки">
		{#snippet action()}
			{#if onEditPlan !== null}
				<Button size="xs" variant="outline" onclick={onEditPlan}>
					<PencilIcon aria-hidden="true" />
					Изменить план
				</Button>
			{/if}
		{/snippet}
		<dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
			<dt class="text-muted-foreground">Договор</dt>
			<dd class="tabular-nums">{agreement ?? '—'}</dd>
			<dt class="text-muted-foreground">Обучение</dt>
			<dd class="tabular-nums">{academic ?? '—'}</dd>
		</dl>
	</ContextSection>
</div>
