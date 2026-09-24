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

	function toggle<T>(list: T[], item: T, on: boolean): T[] {
		return on
			? [...list.filter((value) => value !== item), item]
			: list.filter((value) => value !== item);
	}
</script>

<form method="POST" {action} class="grid gap-6 md:grid-cols-[minmax(0,1fr)_16rem]">
	<div class="flex flex-col gap-4">
		<fieldset class="flex flex-col gap-2">
			<legend class="mb-2 text-sm font-medium">Панели</legend>
			{#each CARD_PANELS as panel (panel)}
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
		</fieldset>
		<fieldset class="flex flex-col gap-2">
			<legend class="mb-2 text-sm font-medium">Шаблоны документов</legend>
			{#each DOCUMENT_TEMPLATE_KEYS as template (template)}
				<Label class="flex items-center gap-2 font-normal">
					<Checkbox
						name="templates"
						value={template}
						checked={templates.includes(template)}
						onCheckedChange={(next) => (templates = toggle(templates, template, next === true))}
					/>
					{DOCUMENT_TEMPLATE_LABELS[template]}
				</Label>
			{/each}
		</fieldset>
		<div>
			<Button type="submit" size="sm" disabled={!dirty}>Сохранить состав карточки</Button>
		</div>
	</div>

	<div class="flex flex-col gap-2 rounded-lg border border-border p-3" aria-live="polite">
		<p class="text-xs font-semibold tracking-wide text-faint uppercase">Предпросмотр</p>
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
