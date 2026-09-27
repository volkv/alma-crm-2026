<script lang="ts">
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import { resolve } from '$app/paths';
	import {
		SITE_APPLICATION_STATUS_LABELS,
		type SiteApplicationView
	} from '$lib/contracts/interactions';
	import { formatDateTime } from '$lib/format';
	import { headerFactsFor } from '$lib/platform/card-ui-registry';
	import { isCurrentState } from './stage-look';
	import type { CardModel } from './model';
	import QuietNote from './quiet-note.svelte';
	import StageList from './stage-list.svelte';
	import StageStrip from './stage-strip.svelte';
	import TimingBadge from './timing-badge.svelte';

	/**
	 * Верх карточки: три факта — с кем работаем, кто отвечает и на каких
	 * условиях, — и под ними процесс: где стоим, сколько осталось и куда дальше,
	 * названиями и полосой. Условия зависят от контрагента и подключённых
	 * модулей: вуз и юридическое лицо работают по договору, физическое лицо —
	 * по оплате. Все стадии
	 * раскрываются столбиком по требованию, пройденные в нём свёрнуты в строку.
	 * Если по записи давно тихо, это сказано здесь же словами.
	 *
	 * На телефоне из трёх фактов на виду только контрагент, остальные два —
	 * в раскрытии, следующую стадию называет кнопка перехода, а «тишину»
	 * страница ставит под действием: до главного действия в первом экране
	 * должны уместиться контрагент, стадия и срок.
	 */
	let {
		model,
		counterpartyId,
		siteApplication,
		moduleData = {}
	}: {
		model: CardModel;
		/** Заявка с сайта, из которой заведено дело; `null` — дело не с сайта. */
		siteApplication: SiteApplicationView | null;
		/** Данные действующих модулей по ключу модуля — факту шапки его модуля. */
		moduleData?: Readonly<Record<string, unknown>>;
		/**
		 * Основная сторона в справочнике — имя контрагента ведёт в её карточку;
		 * `null` — справочник человеку не открыт, и имя остаётся текстом.
		 */
		counterpartyId: string | null;
	} = $props();

	/**
	 * Следующая стадия — по порядку процесса, как её показывает полоса:
	 * первая из тех, что впереди текущей. Нет такой — дальше завершение.
	 */
	const next = $derived.by(() => {
		const here = model.stages.findIndex((stage) => isCurrentState(stage.state));

		if (here === -1) return null;

		return {
			stage: model.stages.slice(here + 1).find((stage) => stage.state === 'pending') ?? null
		};
	});

	/**
	 * Условия приносят действующие модули пространства: договор — у вуза и
	 * юридического лица, оплата — у физического. Модуль выключен — факта нет,
	 * в шапке остаётся ответственный.
	 */
	const facts = $derived(headerFactsFor(model.modules, model.shape));

	const DELIVERY_LABELS: Record<NonNullable<SiteApplicationView['delivery']>, string> = {
		delivered: 'доставлено',
		waiting: 'новый статус ждёт отправки',
		failed: 'ошибка доставки — повтор назначит администратор',
		dismissed: 'разобрано администратором вручную'
	};

	function siteStatus(application: SiteApplicationView): string {
		const sent =
			application.sent === null
				? 'статус на сайт ещё не отправлялся'
				: `статус на сайте: ${SITE_APPLICATION_STATUS_LABELS[application.sent.status]} (${formatDateTime(application.sent.at)})`;

		return application.delivery === null
			? sent
			: `${sent} · ${DELIVERY_LABELS[application.delivery]}`;
	}

	const secondaryLabel = $derived.by(() => {
		const names = [
			'Ответственный',
			...facts.map((fact) => fact.label.charAt(0).toLocaleLowerCase('ru') + fact.label.slice(1))
		];

		return names.length === 1
			? names[0]
			: `${names.slice(0, -1).join(', ')} и ${names[names.length - 1]}`;
	});
</script>

{#snippet secondaryFacts(hide: string)}
	<div class="min-w-0 {hide}">
		<dt class="text-xs text-muted-foreground">Ответственный</dt>
		<dd class="mt-0.5 text-sm font-medium break-words">
			{model.responsible ?? 'не назначен'}
			{#if model.waitingFor !== null}
				<span class="block text-xs font-normal text-muted-foreground">
					ход за стороной: {model.waitingFor}
				</span>
			{/if}
		</dd>
	</div>
	{#each facts as fact (`${fact.module}:${fact.key}`)}
		<fact.component {model} label={fact.label} {hide} data={moduleData[fact.module]} />
	{/each}
{/snippet}

<!-- `data-tour` — метка подсказок: по ней тур находит факты и процесс. -->
<section
	class="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-surface p-4"
	aria-label="Ключевые факты"
	data-tour="interaction-timeline"
>
	<dl class="grid gap-x-6 gap-y-3 sm:grid-cols-3">
		<div class="min-w-0">
			<dt class="text-xs text-muted-foreground">Контрагент</dt>
			<dd class="mt-0.5 text-sm font-medium break-words">
				{#if counterpartyId === null}
					{model.counterparty.name}
				{:else}
					<a
						class="rounded-sm text-link focus-ring hover:text-link-hover hover:underline"
						href={resolve('/(app)/organizations/[id=uuid]', { id: counterpartyId })}
						>{model.counterparty.name}</a
					>
				{/if}
				{#if model.counterparty.kindLabel}
					<span class="block text-xs font-normal text-faint">{model.counterparty.kindLabel}</span>
				{/if}
				{#if siteApplication !== null}
					<!-- Что видит заявитель на сайте: последний ушедший статус и дошёл
						ли он. Журнал обмена открыт администратору, КАМу — эта строка. -->
					<span
						class="block text-xs font-normal text-muted-foreground"
						data-slot="site-application"
					>
						Заявка с сайта <span class="font-mono">{siteApplication.key}</span> · {siteStatus(
							siteApplication
						)}
					</span>
				{/if}
			</dd>
		</div>
		{@render secondaryFacts('max-sm:hidden')}
	</dl>

	{#if model.stages.length > 0}
		<div class="flex flex-col gap-2 border-t border-border pt-4" data-slot="card-process">
			{#if model.stage !== null}
				<dl class="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
					<div class="min-w-0">
						<dt class="text-xs text-muted-foreground">
							Стадия <span class="tabular-nums">{model.stage.position} из {model.stage.total}</span>
						</dt>
						<dd class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
							<span class="font-medium break-words">{model.stage.name}</span>
							{#if model.timing !== null}
								<TimingBadge timing={model.timing} />
							{/if}
						</dd>
					</div>
					<!-- На телефоне следующую стадию называет кнопка перехода в «Следующем
						шаге», повтор здесь отодвигал бы её под док. -->
					{#if next !== null}
						<div class="min-w-0 max-sm:hidden sm:text-right">
							<dt class="text-xs text-muted-foreground">Дальше</dt>
							<dd class="mt-0.5 text-sm break-words">
								{#if next.stage !== null}
									<span class="tabular-nums">{next.stage.position}.</span>
									{next.stage.name}
								{:else}
									Завершение взаимодействия
								{/if}
							</dd>
						</div>
					{/if}
				</dl>
			{/if}
			<!-- Шкала — стадии действующего процесса: удалённая из него пройденная
				стадия дала бы лишний отрезок рядом с «Стадия N из M». -->
			<StageStrip stages={model.stages.filter((stage) => !stage.removed)} />
			<details class="group">
				<summary
					class="flex w-fit list-none items-center gap-1 rounded-sm text-xs text-link focus-ring hover:text-link-hover hover:underline [&::-webkit-details-marker]:hidden"
				>
					<ChevronRightIcon
						class="size-3.5 transition-transform group-open:rotate-90"
						aria-hidden="true"
					/>
					Все стадии процесса
				</summary>
				<div class="mt-2">
					<StageList stages={model.stages} />
				</div>
			</details>
		</div>
	{/if}

	<!-- На телефоне ответственный и условия — по нажатию: до «Следующего шага»
		в первом экране остаются контрагент, стадия и срок, а раскрытие стоит
		последним, под процессом. -->
	<details class="group sm:hidden" data-slot="card-facts-more">
		<summary
			class="flex w-fit list-none items-center gap-1 rounded-sm text-xs text-link focus-ring hover:text-link-hover hover:underline [&::-webkit-details-marker]:hidden"
		>
			<ChevronRightIcon
				class="size-3.5 transition-transform group-open:rotate-90"
				aria-hidden="true"
			/>
			{secondaryLabel}
		</summary>
		<dl class="mt-2 grid gap-y-3">
			{@render secondaryFacts('')}
		</dl>
	</details>

	<!-- На телефоне «тишина» стоит под «Следующим шагом» (страница карточки):
		совет не должен отодвигать само действие из первого экрана. -->
	{#if model.quiet !== null}
		<div class="max-sm:hidden">
			<QuietNote quiet={model.quiet} />
		</div>
	{/if}
</section>
