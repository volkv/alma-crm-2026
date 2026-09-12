<script lang="ts">
	import { untrack } from 'svelte';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import {
		STAT_FIELDS,
		STAT_FIELD_LABELS,
		STAT_FIELD_NONE,
		STAT_PREVIEW_ROWS,
		type MappingAdvice,
		type StatField,
		type StatMapping
	} from '$lib/contracts/stats';

	/**
	 * Сопоставление колонок файла с полями строки.
	 *
	 * Подсказка помечена значком и остаётся видимой ровно до тех пор, пока
	 * человек её не поменял: предложение, которое нельзя отличить от решения
	 * человека, — это не подсказка, а подделка его подписи.
	 *
	 * Значения полей уходят в форму парами скрытых полей `column` и `field`:
	 * названия колонок приходят из файла, то есть это произвольный текст, и
	 * собирать из него имена полей формы нельзя.
	 */
	let {
		headers,
		advice,
		mapping,
		sample
	}: {
		headers: readonly string[];
		advice: readonly MappingAdvice[];
		/** Сопоставление снимка; пусто, пока шаг не проходили. */
		mapping: StatMapping;
		/** Первые строки файла: колонка → значение. */
		sample: readonly Record<string, string>[];
	} = $props();

	const FIELD_OPTIONS = STAT_FIELDS.map((field) => ({
		value: field,
		label: STAT_FIELD_LABELS[field]
	}));

	/** Значение «колонку не берём»; разбирает его сервер тем же именем. */
	const NONE = STAT_FIELD_NONE;

	function advisedFor(column: string): StatField | null {
		return advice.find((item) => item.column === column)?.field ?? null;
	}

	/**
	 * Что стоит в списке с самого начала: уже применённое сопоставление, а если
	 * его нет — подсказка. Правка человека сильнее подсказки всегда.
	 */
	// `untrack`: это стартовое значение, а не связь. Дальше списком распоряжается
	// человек, и перерисовка страницы не должна возвращать его правку назад.
	let chosen = $state<Record<string, string>>(
		untrack(() =>
			Object.fromEntries(
				headers.map((column) => [column, mapping[column] ?? advisedFor(column) ?? NONE])
			)
		)
	);

	const preview = $derived(sample.slice(0, STAT_PREVIEW_ROWS));

	function values(column: string): string {
		return preview
			.map((row) => row[column] ?? '')
			.filter((value) => value !== '')
			.join(' · ');
	}
</script>

<div class="overflow-x-auto rounded-lg border border-border bg-surface">
	<Table.Root>
		<Table.Header>
			<Table.Row>
				<Table.Head class="w-1/3">Колонка файла</Table.Head>
				<Table.Head>Первые значения</Table.Head>
				<Table.Head class="w-80">Поле</Table.Head>
			</Table.Row>
		</Table.Header>
		<Table.Body>
			{#each headers as column (column)}
				{@const advised = advisedFor(column)}
				<Table.Row>
					<Table.Cell class="align-top font-medium">
						{column}
						<input type="hidden" name="column" value={column} />
					</Table.Cell>
					<Table.Cell class="align-top text-muted-foreground">
						{values(column) || '—'}
					</Table.Cell>
					<Table.Cell class="align-top">
						<div class="flex flex-col gap-1">
							<Select.Root type="single" name="field" bind:value={chosen[column]}>
								<Select.Trigger class="w-full" aria-label="Поле для колонки «{column}»">
									{chosen[column] === NONE
										? 'Не сопоставлено'
										: STAT_FIELD_LABELS[chosen[column] as StatField]}
								</Select.Trigger>
								<Select.Content>
									<Select.Item value={NONE} label="Не сопоставлено" />
									{#each FIELD_OPTIONS as option (option.value)}
										<Select.Item value={option.value} label={option.label} />
									{/each}
								</Select.Content>
							</Select.Root>
							{#if advised !== null && chosen[column] === advised}
								<StatusBadge tone="accent" class="gap-1">
									<SparklesIcon class="size-3" aria-hidden="true" />
									Предложено
								</StatusBadge>
							{/if}
						</div>
					</Table.Cell>
				</Table.Row>
			{/each}
		</Table.Body>
	</Table.Root>
</div>
