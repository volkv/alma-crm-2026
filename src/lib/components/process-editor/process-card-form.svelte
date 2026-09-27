<script lang="ts">
	import { untrack } from 'svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import {
		DOCUMENT_TEMPLATE_KEYS,
		DOCUMENT_TEMPLATE_LABELS,
		type DocumentTemplateKey
	} from '$lib/contracts/documents';
	import {
		CARD_PANELS,
		CARD_PANEL_HINTS,
		CARD_PANEL_LABELS,
		type CardPanel
	} from '$lib/contracts/process-card';
	import { moduleByKey, PANEL_CATALOG, templateOwner } from '$lib/platform/registry';

	/**
	 * Состав карточки процесса: панели и шаблоны документов. Правится без
	 * черновика — стадий он не касается, — и сохраняется сразу для всех
	 * пространств процесса.
	 */
	let {
		card,
		action
	}: {
		/** Что записано сейчас. */
		card: { panels: CardPanel[]; templates: DocumentTemplateKey[] };
		/** Адрес действия сохранения. */
		action: string;
	} = $props();

	/**
	 * Состав в форме — до сохранения. Предпросмотр читает его же: администратор
	 * видит карточку такой, какой она станет, а не какой была.
	 */
	let panels = $state<CardPanel[]>(untrack(() => [...card.panels]));
	let templates = $state<DocumentTemplateKey[]>(untrack(() => [...card.templates]));

	// После сохранения форма показывает то, что записано, а не то, что набрали.
	$effect(() => {
		const saved = card;

		untrack(() => {
			panels = [...saved.panels];
			templates = [...saved.templates];
		});
	});

	const dirty = $derived(
		JSON.stringify(CARD_PANELS.filter((panel) => panels.includes(panel))) !==
			JSON.stringify(card.panels) ||
			JSON.stringify(DOCUMENT_TEMPLATE_KEYS.filter((key) => templates.includes(key))) !==
				JSON.stringify(card.templates)
	);

	/**
	 * Панели по владельцам: ядро и каждый модуль отдельной группой. Группы
	 * встают в порядке первой своей панели в каталоге, панели внутри — в порядке
	 * каталога. Панель модуля процесс выбирает всегда, а видна она только там,
	 * где модуль действует, — об этом подсказка под группой модуля.
	 */
	const panelGroups = (() => {
		const groups: { module: string | null; label: string | null; panels: CardPanel[] }[] = [];

		for (const entry of PANEL_CATALOG) {
			const group = groups.find((candidate) => candidate.module === entry.module);

			if (group === undefined) {
				groups.push({ module: entry.module, label: entry.moduleLabel, panels: [entry.key] });
			} else {
				group.panels.push(entry.key);
			}
		}

		return groups;
	})();

	/**
	 * Название модуля, которому принадлежит шаблон, или `null` — шаблон ядра.
	 * Как и панель модуля, такой шаблон процесс выбирает всегда, а собирается
	 * он только там, где модуль действует.
	 */
	function templateOwnerLabel(template: DocumentTemplateKey): string | null {
		const owner = templateOwner(template);

		return owner === null ? null : (moduleByKey(owner)?.label ?? owner);
	}

	function toggle<T>(list: T[], item: T, on: boolean): T[] {
		return on
			? [...list.filter((value) => value !== item), item]
			: list.filter((value) => value !== item);
	}
</script>

<form method="POST" {action} class="grid gap-6 md:grid-cols-[minmax(0,1fr)_16rem]">
	<div class="flex flex-col gap-4">
		<fieldset class="flex flex-col gap-4">
			<legend class="mb-2 text-sm font-medium">Панели</legend>
			{#each panelGroups as group (group.module ?? '')}
				<div
					role="group"
					aria-labelledby="panel-group-{group.module ?? 'core'}"
					class="flex flex-col gap-2"
				>
					<div class="flex flex-col">
						<p id="panel-group-{group.module ?? 'core'}" class="section-overline">
							{group.module === null ? 'Ядро' : `Модуль «${group.label}»`}
						</p>
						{#if group.module !== null}
							<p class="text-xs text-muted-foreground">
								{group.panels.length === 1 ? 'Видна' : 'Видны'} в пространствах, где модуль подключён.
							</p>
						{/if}
					</div>
					{#each group.panels as panel (panel)}
						<Label class="flex items-start gap-2 font-normal">
							<Checkbox
								name="panels"
								value={panel}
								checked={panels.includes(panel)}
								onCheckedChange={(next) => (panels = toggle(panels, panel, next === true))}
								class="mt-0.5"
							/>
							<span class="flex flex-col">
								{CARD_PANEL_LABELS[panel]}
								<span class="text-xs text-muted-foreground">{CARD_PANEL_HINTS[panel]}</span>
							</span>
						</Label>
					{/each}
				</div>
			{/each}
		</fieldset>
		<fieldset class="flex flex-col gap-2">
			<legend class="mb-2 text-sm font-medium">Шаблоны документов</legend>
			{#each DOCUMENT_TEMPLATE_KEYS as template (template)}
				{@const owner = templateOwnerLabel(template)}
				<Label class="flex items-start gap-2 font-normal">
					<Checkbox
						name="templates"
						value={template}
						checked={templates.includes(template)}
						onCheckedChange={(next) => (templates = toggle(templates, template, next === true))}
						class="mt-0.5"
					/>
					<span class="flex flex-col">
						{DOCUMENT_TEMPLATE_LABELS[template]}
						{#if owner !== null}
							<span class="text-xs text-muted-foreground">
								Модуль «{owner}»: собирается в пространствах, где модуль подключён.
							</span>
						{/if}
					</span>
				</Label>
			{/each}
		</fieldset>
		<div>
			<Button type="submit" size="sm" disabled={!dirty}>Сохранить состав карточки</Button>
		</div>
	</div>

	<div class="flex flex-col gap-2 rounded-lg border border-border p-3" aria-live="polite">
		<p class="section-overline">Предпросмотр</p>
		<ol class="flex list-inside list-decimal flex-col gap-1 text-sm">
			<li>Сторона и условия</li>
			{#each CARD_PANELS.filter((panel) => panels.includes(panel)) as panel (panel)}
				<li>{CARD_PANEL_LABELS[panel]}</li>
			{/each}
		</ol>
		<p class="text-xs text-muted-foreground">
			{#if templates.length === 0}
				Документы по шаблону не собираются.
			{:else}
				По шаблону: {DOCUMENT_TEMPLATE_KEYS.filter((key) => templates.includes(key))
					.map((key) => DOCUMENT_TEMPLATE_LABELS[key])
					.join(', ')}.
			{/if}
		</p>
	</div>
</form>
