<script lang="ts" module>
	/**
	 * Поле, в которое можно сопоставить колонку: значение, название и, если оно
	 * есть, допущение — то, что колонка будет означать после выбора.
	 */
	export type MappingFieldOption = { value: string; label: string; hint?: string };

	/** Предложение по колонке; `field: null` — предложить нечего. */
	export type MappingSuggestion = { column: string; field: string | null };
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import StatusBadge from '$lib/components/status-badge.svelte';

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
	 *
	 * Набор полей приходит снаружи: мастеров в продукте два — загрузка данных об
	 * обучении и импорт каталога, — и таблица у них одна и та же, разные у них
	 * только поля. Проверку набора держит вызывающий: он собирает список из
	 * своего перечисления, и колонка в базу уходит через схему, а не отсюда.
	 */
	let {
		headers,
		advice,
		mapping,
		sample,
		fields,
		noneValue,
		previewRows
	}: {
		headers: readonly string[];
		advice: readonly MappingSuggestion[];
		/** Сопоставление загрузки; пусто, пока шаг не проходили. */
		mapping: Record<string, string>;
		/** Первые строки файла: колонка → значение. */
		sample: readonly Record<string, string>[];
		fields: readonly MappingFieldOption[];
		/** Значение «колонку не берём»; разбирает его сервер тем же именем. */
		noneValue: string;
		previewRows: number;
	} = $props();

	const labels = $derived(new Map(fields.map((field) => [field.value, field.label])));
	const hints = $derived(
		new Map(
			fields
				.filter((field) => field.hint !== undefined)
				.map((field) => [field.value, field.hint as string])
		)
	);

	function advisedFor(column: string): string | null {
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
				headers.map((column) => [column, mapping[column] ?? advisedFor(column) ?? noneValue])
			)
		)
	);

	const preview = $derived(sample.slice(0, previewRows));

	function values(column: string): string {
		return preview
			.map((row) => row[column] ?? '')
			.filter((value) => value !== '')
			.join(' · ');
	}
</script>

<!-- `data-tour` — метка подсказок: таблицу показывают шаги обоих мастеров —
	загрузки данных и импорта каталога (`$lib/onboarding/screens`). -->
<div class="overflow-x-auto rounded-lg border border-border bg-surface" data-tour="mapping-columns">
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
									{chosen[column] === noneValue
										? 'Не сопоставлено'
										: (labels.get(chosen[column]) ?? 'Не сопоставлено')}
								</Select.Trigger>
								<Select.Content>
									<Select.Item value={noneValue} label="Не сопоставлено" />
									{#each fields as option (option.value)}
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
							<!-- Допущение выбранного поля: человек читает его до того, как
								нажмёт «дальше», а не после применения. -->
							{#if hints.has(chosen[column])}
								<p class="text-xs text-muted-foreground" data-slot="field-hint">
									{hints.get(chosen[column])}
								</p>
							{/if}
						</div>
					</Table.Cell>
				</Table.Row>
			{/each}
		</Table.Body>
	</Table.Root>
</div>
