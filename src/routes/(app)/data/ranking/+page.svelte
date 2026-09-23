<script lang="ts">
	import { untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { toast } from 'svelte-sonner';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import FormField from '$lib/components/form/form-field.svelte';
	import Header from '$lib/components/header.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import Section from '$lib/components/home/section.svelte';
	import PeriodSelect from '$lib/components/stats/period-select.svelte';
	import RankingList from '$lib/components/stats/ranking-list.svelte';
	import SectionTabs from '$lib/components/stats/section-tabs.svelte';
	import {
		describeFormula,
		RANKING_FACT_HINTS,
		RANKING_FACT_LABELS,
		RANKING_FACTS,
		RANKING_PRIORITY_LEVELS,
		rankingWeightsSchema,
		type RankingWeights
	} from '$lib/contracts/ranking';
	import { formatDate, pluralize } from '$lib/format';
	import type { PageProps } from './$types';

	let { data, form: actionResult }: PageProps = $props();

	const ranking = $derived(data.ranking);

	/** Отказ по правам приходит обычным `fail`, мимо формы весов. */
	const refusal = $derived(
		actionResult !== null && actionResult !== undefined && 'message' in actionResult
			? actionResult.message
			: null
	);

	const WEIGHT_FIELDS: { name: keyof RankingWeights; label: string; description: string }[] = [
		...RANKING_FACTS.map((fact) => ({
			name: fact,
			label: RANKING_FACT_LABELS[fact],
			description: `Баллов за единицу: ${RANKING_FACT_HINTS[fact]}`
		})),
		{
			name: 'priorityStep',
			label: 'Шаг ручного приоритета',
			description: `Приоритет 1 даёт ${RANKING_PRIORITY_LEVELS} шагов, приоритет ${RANKING_PRIORITY_LEVELS} — один, ниже — ничего`
		}
	];

	const {
		form: weightsData,
		errors: weightsErrors,
		enhance: weightsEnhance,
		submitting: weightsSubmitting
	} = superForm(
		untrack(() => data.weightsForm),
		{
			validators: zod4Client(rankingWeightsSchema),
			// Рейтинг под формой пересчитывается загрузкой страницы: веса
			// применяются к фактам после кэша, и правку видно сразу.
			invalidateAll: true,
			onUpdated: ({ form }) => {
				if (typeof form.message === 'string') {
					toast.success(form.message);
				}
			}
		}
	);

	/** Что именно посчитано в каждом слагаемом — одной фразой под формулой. */
	const FACTS_TEXT = `${RANKING_FACTS.map((fact) => `${RANKING_FACT_LABELS[fact]} — ${RANKING_FACT_HINTS[fact]}`).join('; ')}.`;

	const periodLabel = $derived(
		`${formatDate(ranking.period.start)} — ${formatDate(ranking.period.end)}`
	);

	const outsideNotes = $derived(
		[
			ranking.outside.groupsWithoutProgram > 0
				? `${pluralize(ranking.outside.groupsWithoutProgram, ['учебная группа', 'учебные группы', 'учебных групп'])} без программы — заведены до того, как группа стала её закреплять, и ни в одну строку не вошли`
				: null,
			ranking.outside.applicationsWithoutProgram > 0
				? `${pluralize(ranking.outside.applicationsWithoutProgram, ['заявка', 'заявки', 'заявок'])} с сайта без программы — отнести их не к чему`
				: null,
			ranking.outside.programsWithoutDirection > 0
				? `${pluralize(ranking.outside.programsWithoutDirection, ['программа', 'программы', 'программ'])} без направления — они есть в рейтинге программ, но не в рейтинге направлений`
				: null
		].filter((note): note is string => note !== null)
	);
</script>

<svelte:head><title>Рейтинг программ — LCT CRM</title></svelte:head>

<Header
	title="Рейтинг программ и направлений"
	description="Считается по фактам системы за период: заявки с сайта, потоки, обучающиеся и завершившие — в той части работы, которую вы видите."
/>

<Breadcrumbs
	items={[{ label: 'Данные об обучении', href: resolve('/(app)/data') }, { label: 'Рейтинг' }]}
/>

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	<SectionTabs />

	<div class="flex flex-wrap items-center gap-3" data-tour="data-ranking-period">
		<PeriodSelect periods={data.periods} />
	</div>

	<div data-tour="data-ranking-formula">
		<InlineHint tone="info">
			<span class="flex flex-col gap-1">
				<span>
					<strong>Гипотеза команды, а не формула заказчика; веса настраиваются.</strong>
					{describeFormula(ranking.weights)}.
				</span>
				<span>
					{FACTS_TEXT}
					У группы учитывается один результат — последний, поэтому промежуточный и итоговый не складываются.
				</span>
			</span>
		</InlineHint>
	</div>

	<div class="grid gap-4 xl:grid-cols-2">
		<Section
			title="Программы"
			description="Период {periodLabel}. Под названием — из чего сложился балл и почему у программы это место."
			data-tour="data-ranking-programs"
		>
			<RankingList
				entries={ranking.programs}
				hrefOf={(id) => resolve('/(app)/programs/[id=uuid]', { id })}
				emptyTitle="Ранжировать нечего"
				emptyDescription="За период в вашей области нет ни заявок с сайта, ни учебных групп с программой."
			/>
		</Section>

		<Section
			title="Направления"
			description="Те же факты, сложенные по направлениям программ. Заявка с двумя программами одного направления считается ему один раз; ручного приоритета у направления нет."
			data-tour="data-ranking-directions"
		>
			<RankingList
				entries={ranking.directions}
				hrefOf={(id) => resolve('/(app)/directions/[id=uuid]', { id })}
				emptyTitle="Ранжировать нечего"
				emptyDescription="За период нет фактов по программам, у которых указано направление."
			/>
		</Section>
	</div>

	{#if outsideNotes.length > 0}
		<InlineHint>
			<span class="flex flex-col gap-0.5">
				<span>Не вошло в рейтинг:</span>
				{#each outsideNotes as note (note)}
					<span>— {note}.</span>
				{/each}
			</span>
		</InlineHint>
	{/if}

	{#if data.canConfigure}
		<Card.Root data-tour="data-ranking-weights">
			<Card.Header>
				<Card.Title>Веса формулы</Card.Title>
				<Card.Description>
					Правка меняет рейтинг всем сразу — здесь, на дашборде, в выгрузке и на карточках программ.
					Ноль выключает слагаемое, не убирая его из объяснения.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				{#if refusal}
					<Alert.Root variant="destructive" class="mb-4">
						<Alert.Title>Веса не сохранены</Alert.Title>
						<Alert.Description>{refusal}</Alert.Description>
					</Alert.Root>
				{/if}
				{#if $weightsErrors._errors}
					<Alert.Root variant="destructive" class="mb-4">
						<Alert.Description>
							<ul class="list-inside list-disc">
								{#each $weightsErrors._errors as issue (issue)}
									<li>{issue}</li>
								{/each}
							</ul>
						</Alert.Description>
					</Alert.Root>
				{/if}
				<!-- novalidate: проверяет схема и говорит по-русски, а не браузер на своём языке. -->
				<form
					method="POST"
					action="?/weights"
					use:weightsEnhance
					novalidate
					class="flex flex-col gap-4"
				>
					<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
						{#each WEIGHT_FIELDS as field (field.name)}
							<FormField
								name={field.name}
								label={field.label}
								description={field.description}
								errors={$weightsErrors[field.name]}
								required
							>
								{#snippet control({ id, describedBy, invalid })}
									<!-- Пустое поле даёт NaN, и схема скажет об этом словами:
										ноль здесь — настоящий вес, подменять им пустоту нельзя. -->
									<Input
										{id}
										name={field.name}
										type="number"
										inputmode="numeric"
										value={$weightsData[field.name]}
										aria-invalid={invalid}
										aria-describedby={describedBy}
										oninput={(event) =>
											($weightsData[field.name] = event.currentTarget.valueAsNumber)}
									/>
								{/snippet}
							</FormField>
						{/each}
					</div>
					<FormActions submitting={$weightsSubmitting} submitLabel="Сохранить веса" />
				</form>
			</Card.Content>
		</Card.Root>
	{/if}
</div>
