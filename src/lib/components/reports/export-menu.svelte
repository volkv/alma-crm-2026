<script lang="ts">
	import { page } from '$app/state';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import {
		REPORT_FORMATS,
		REPORT_FORMAT_LABELS,
		REPORT_PDF_FULL_MAX_ROWS,
		REPORT_PDF_LAYOUTS,
		REPORT_PDF_LAYOUT_LABELS,
		REPORT_PDF_ROWS,
		type ReportPdfLayout
	} from '$lib/contracts/reports';
	import { formatNumber, pluralize } from '$lib/format';
	import { exportHref } from './query';

	/**
	 * Выгрузка отчёта одной кнопкой.
	 *
	 * Форматы равноправны только для машины: человек выбирает один, и пять
	 * соседних кнопок в шапке отнимали место у результата. Меню держит каждый
	 * формат отдельным пунктом-ссылкой — адрес тот же, что у фильтров экрана, —
	 * а у PDF два пункта: сводка и полный отчёт.
	 */
	let { rowCount }: { rowCount: number } = $props();

	/** Выше потолка полного PDF сервер ответил бы отказом: вся таблица — в XLSX. */
	const fullPdfTooLarge = $derived(rowCount > REPORT_PDF_FULL_MAX_ROWS);

	/**
	 * Выборка не длиннее сводки: оба вида PDF печатают всю таблицу, и меню
	 * говорит это до скачивания, а не оставляет искать разницу в двух файлах.
	 */
	const pdfSame = $derived(rowCount <= REPORT_PDF_ROWS);

	const pdfHints: Record<ReportPdfLayout, string> = $derived(
		pdfSame
			? {
					summary: `Итоги, числа диаграмм и вся таблица — ${pluralize(rowCount, ['строка', 'строки', 'строк'])}`,
					full: `Совпадает со сводкой: в выборке не больше ${REPORT_PDF_ROWS} строк`
				}
			: {
					summary: `Итоги, числа диаграмм и первые ${REPORT_PDF_ROWS} строк таблицы`,
					full: `Итоги, числа диаграмм и вся таблица выборки — до ${formatNumber(REPORT_PDF_FULL_MAX_ROWS)} строк`
				}
	);

	const formatHints: Record<Exclude<(typeof REPORT_FORMATS)[number], 'pdf'>, string> = {
		xlsx: 'Книга: таблица, фильтры и числа диаграмм',
		xls: 'Те же листы в старом формате — до 65 536 строк',
		json: 'Строки, фильтры и правило подсчёта — для других систем'
	};

	/**
	 * Пункты меню по порядку форматов; PDF разворачивается в два вида.
	 * `testId` сохраняет прежние имена: `report-export-pdf` — сводка.
	 */
	const items = $derived(
		REPORT_FORMATS.flatMap((format) =>
			format === 'pdf'
				? REPORT_PDF_LAYOUTS.map((layout) => ({
						key: `pdf-${layout}`,
						label: `PDF · ${REPORT_PDF_LAYOUT_LABELS[layout].toLowerCase()}`,
						hint:
							layout === 'full' && fullPdfTooLarge
								? `В выборке больше ${formatNumber(REPORT_PDF_FULL_MAX_ROWS)} строк: вся таблица — в XLSX`
								: pdfHints[layout],
						href: exportHref(page.url, 'pdf', layout),
						disabled: layout === 'full' && fullPdfTooLarge,
						testId: layout === 'summary' ? 'report-export-pdf' : 'report-export-pdf-full'
					}))
				: [
						{
							key: format,
							label: REPORT_FORMAT_LABELS[format],
							hint: formatHints[format],
							href: exportHref(page.url, format),
							disabled: false,
							testId: `report-export-${format}`
						}
					]
		)
	);
</script>

<!-- `data-tour` — метка подсказок (`$lib/onboarding/screens`): подсказка
	показывает на выгрузку целиком. -->
<div data-tour="reports-export">
	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button {...props} variant="outline" size="sm" data-testid="report-export">
					<DownloadIcon aria-hidden="true" />
					Выгрузить
					<ChevronDownIcon aria-hidden="true" />
				</Button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="end" class="w-80">
			<DropdownMenu.Group>
				<DropdownMenu.GroupHeading>Выгрузить отчёт с этим отбором</DropdownMenu.GroupHeading>
				{#each items as item (item.key)}
					<DropdownMenu.Item disabled={item.disabled}>
						{#snippet child({ props })}
							<a
								{...props}
								href={item.disabled ? undefined : item.href}
								data-sveltekit-reload
								data-testid={item.testId}
								class="{props.class} flex-col items-start gap-0"
							>
								<span class="font-medium">{item.label}</span>
								<span class="text-xs text-muted-foreground">{item.hint}</span>
							</a>
						{/snippet}
					</DropdownMenu.Item>
				{/each}
			</DropdownMenu.Group>
		</DropdownMenu.Content>
	</DropdownMenu.Root>
</div>
