<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import type { SuperForm } from 'sveltekit-superforms';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import FileJsonIcon from '@lucide/svelte/icons/file-json';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import LoaderIcon from '@lucide/svelte/icons/loader-2';
	import SearchIcon from '@lucide/svelte/icons/search';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { deserialize, enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import {
		EDUCATION_LEVEL_LABELS,
		ORGANIZATION_KIND_LABELS
	} from '$lib/components/directory/labels';
	import type {
		CreateOrganizationInput,
		EducationLevel,
		OrganizationKind
	} from '$lib/contracts/directory';
	import {
		PASSPORT_FIELDS,
		type FieldSource,
		type IssuedPassport,
		type LegalStatus,
		type PassportAcceptance,
		type PassportAvailability,
		type PassportField
	} from '$lib/contracts/enrichment';
	import { formatDateTime } from '$lib/format';

	/**
	 * Паспорт организации прямо в форме карточки.
	 *
	 * Панель стоит над формой, но своих записей не делает: найденное показывается
	 * диффом «сейчас в карточке → из источника», сотрудник отмечает, что принять,
	 * и отмеченное переносится в поля формы вместе с отметкой о происхождении
	 * (`accepted`). В справочник это попадает только сохранением формы — там
	 * сервер и сверяет отметки с тем паспортом, который выдавал.
	 */
	let {
		superform,
		availability,
		accepted = $bindable()
	}: {
		superform: SuperForm<CreateOrganizationInput>;
		availability: PassportAvailability;
		accepted: PassportAcceptance;
	} = $props();

	const { form } = untrack(() => superform);

	const FIELD_LABELS: Record<PassportField, string> = {
		kind: 'Тип организации',
		educationLevel: 'Уровень образования',
		legalName: 'Полное наименование',
		shortName: 'Краткое наименование',
		inn: 'ИНН',
		kpp: 'КПП',
		ogrn: 'ОГРН',
		region: 'Регион',
		website: 'Сайт'
	};

	const SOURCE_LABELS: Record<FieldSource, string> = {
		dadata: 'ЕГРЮЛ (Dadata)',
		sveden: 'сайт, раздел «Сведения»',
		guess: 'догадка'
	};

	const STATUS_LABELS: Record<LegalStatus, string> = {
		active: 'Действует',
		liquidating: 'Ликвидируется',
		liquidated: 'Ликвидирована',
		reorganizing: 'Реорганизуется',
		bankrupt: 'Банкротство',
		unknown: 'Состояние неизвестно'
	};

	// Строка поиска по умолчанию — то, что уже есть в карточке: при правке
	// сверяют заведённую организацию, а не ищут новую.
	let query = $state(untrack(() => $form.inn ?? $form.shortName ?? ''));
	let issued = $state<IssuedPassport | null>(null);
	let selected = $state<Partial<Record<PassportField, boolean>>>({});
	let failure = $state<{ message: string; issues: string[] } | null>(null);
	let pending = $state<'registry' | 'site' | 'import' | null>(null);

	const website = $derived($form.website ?? '');
	const live = $derived(availability.enabled);
	const registryLive = $derived(live && availability.registryConfigured);

	/**
	 * Подсказки реестра по мере набора. Каждое новое обращение стоит единицы
	 * квоты, поэтому реестр спрашивается от трёх символов и с паузой после
	 * последней буквы, а ответ на прежнюю строку не перетирает подсказки к новой.
	 * Строку поиска, подставленную из карточки при открытии, никто не набирал —
	 * по ней подсказки не спрашиваются.
	 */
	const SUGGEST_MIN_QUERY = 3;
	const SUGGEST_DELAY_MS = 600;

	let suggestions = $state<IssuedPassport[] | null>(null);
	let suggestOpen = $state(false);
	let suggestLoading = $state(false);
	let suggestError = $state<string | null>(null);
	let suggestTimer: ReturnType<typeof setTimeout> | undefined;
	let suggestGeneration = 0;

	$effect(() => () => clearTimeout(suggestTimer));

	function closeSuggestions() {
		suggestGeneration += 1;
		clearTimeout(suggestTimer);
		suggestOpen = false;
		suggestLoading = false;
	}

	function onQueryInput(event: Event & { currentTarget: HTMLInputElement }) {
		// Значение берётся из события: порядок, в котором `bind:value` и этот
		// обработчик увидят ввод, не гарантирован.
		query = event.currentTarget.value;
		closeSuggestions();
		suggestions = null;
		suggestError = null;

		if (!registryLive || query.trim().length < SUGGEST_MIN_QUERY) {
			return;
		}

		const current = suggestGeneration;
		const text = query;

		suggestOpen = true;
		suggestTimer = setTimeout(() => void suggest(text, current), SUGGEST_DELAY_MS);
	}

	/**
	 * Действие формы вызывается напрямую: подсказка не отправка, и
	 * `use:enhance` с его сбросом формы и обновлением страницы ей не нужен.
	 */
	async function suggest(text: string, current: number) {
		suggestLoading = true;

		try {
			const body = new FormData();
			body.set('query', text);

			const response = await fetch('?/passportSuggest', {
				method: 'POST',
				body,
				headers: { 'x-sveltekit-action': 'true' }
			});
			const result = deserialize(await response.text());

			if (current !== suggestGeneration) {
				return;
			}

			if (result.type === 'success' && Array.isArray(result.data?.suggestions)) {
				suggestions = result.data.suggestions as IssuedPassport[];
			} else if (result.type === 'failure') {
				suggestions = [];
				suggestError = String(result.data?.message ?? 'Справочник организаций не ответил');
			} else {
				suggestions = [];
				suggestError = 'Справочник организаций не ответил';
			}
		} catch {
			if (current === suggestGeneration) {
				suggestions = [];
				suggestError = 'Справочник организаций не ответил';
			}
		} finally {
			if (current === suggestGeneration) {
				suggestLoading = false;
			}
		}
	}

	/** Выбранная подсказка — уже выданный паспорт: показываем его диффом. */
	function chooseSuggestion(next: IssuedPassport) {
		closeSuggestions();
		issued = next;
		selected = defaultSelection(next);
		failure = null;
	}

	/** Реквизиты подсказки одной строкой: по ним отличают головной вуз от филиала. */
	function suggestionDetails(next: IssuedPassport): string {
		const entity = next.passport.entity;

		if (entity === null) {
			return '';
		}

		return [
			entity.inn === null ? null : `ИНН ${entity.inn}`,
			entity.kpp === null ? null : `КПП ${entity.kpp}`,
			entity.region,
			entity.isBranch ? 'филиал' : null,
			entity.status === 'active' ? null : STATUS_LABELS[entity.status].toLocaleLowerCase('ru')
		]
			.filter((part) => part !== null)
			.join(' · ');
	}

	/** Текущее значение поля карточки — строкой, как его сравнивает дифф. */
	function currentValue(field: PassportField): string | null {
		const value = $form[field];

		return value === null || value === undefined || value === '' ? null : String(value);
	}

	function display(field: PassportField, value: string | null): string {
		if (value === null) {
			return '—';
		}

		if (field === 'kind') {
			return ORGANIZATION_KIND_LABELS[value as OrganizationKind] ?? value;
		}

		if (field === 'educationLevel') {
			return EDUCATION_LEVEL_LABELS[value as EducationLevel] ?? value;
		}

		return value;
	}

	type DiffRow = {
		field: PassportField;
		current: string | null;
		offered: string;
		source: FieldSource;
		fetchedAt: string;
		same: boolean;
	};

	const rows = $derived.by((): DiffRow[] => {
		if (issued === null) {
			return [];
		}

		const fields = issued.passport.fields;

		return PASSPORT_FIELDS.flatMap((field) => {
			const offer = fields[field];

			if (offer === undefined) {
				return [];
			}

			const current = currentValue(field);

			return [
				{
					field,
					current,
					offered: offer.value,
					source: offer.source,
					fetchedAt: offer.fetchedAt,
					same: current === offer.value
				}
			];
		});
	});

	const selectedCount = $derived(
		rows.filter((row) => !row.same && selected[row.field] === true).length
	);

	/**
	 * Что отмечено сразу: пустые поля карточки заполняются охотно, а занятые
	 * человек переписывает только сам — источник ошибается, и его значение не
	 * должно молча вытеснить то, что сотрудник знает лучше.
	 */
	function defaultSelection(next: IssuedPassport): Partial<Record<PassportField, boolean>> {
		const selection: Partial<Record<PassportField, boolean>> = {};

		for (const field of PASSPORT_FIELDS) {
			const offer = next.passport.fields[field];

			if (offer !== undefined && currentValue(field) === null) {
				selection[field] = true;
			}
		}

		return selection;
	}

	function submitter(kind: 'registry' | 'site' | 'import'): SubmitFunction {
		return () => {
			pending = kind;
			failure = null;

			// Явная проверка заменяет подсказки: список к этой строке больше не нужен.
			if (kind === 'registry') {
				closeSuggestions();
			}

			return async ({ result, formElement }) => {
				pending = null;

				if (result.type === 'success' && result.data?.issued) {
					const next = result.data.issued as IssuedPassport;

					issued = next;
					selected = defaultSelection(next);

					if (kind === 'import') {
						formElement.reset();
					}

					return;
				}

				if (result.type === 'failure') {
					failure = {
						message: String(result.data?.message ?? 'Источник не ответил'),
						issues: Array.isArray(result.data?.issues) ? result.data.issues.map(String) : []
					};

					return;
				}

				if (result.type === 'error') {
					failure = { message: result.error?.message ?? 'Сбой приложения', issues: [] };
				}
			};
		};
	}

	/** Переносит отмеченное в поля формы; запись — сохранением формы. */
	function acceptSelected() {
		if (issued === null) {
			return;
		}

		const token = issued.token;
		const taken: PassportField[] = [];

		for (const row of rows) {
			if (row.same || selected[row.field] !== true) {
				continue;
			}

			if (row.field === 'kind') {
				$form.kind = row.offered as OrganizationKind;
			} else if (row.field === 'educationLevel') {
				$form.educationLevel = row.offered as EducationLevel;
			} else {
				$form[row.field] = row.offered;
			}

			taken.push(row.field);
		}

		accepted = [
			...accepted.filter((entry) => !taken.includes(entry.field)),
			...taken.map((field) => ({ token, field }))
		];
		selected = {};

		toast.success(
			`Перенесено в форму полей: ${taken.length}. В карточку они попадут, когда вы сохраните форму`
		);
	}

	/** Снимок того же формата, что отдаёт поиск: его загружают там, где источники выключены. */
	function downloadSnapshot() {
		if (issued === null) {
			return;
		}

		const passport = issued.passport;
		const label =
			passport.fields.inn?.value ??
			(passport.site === null ? 'organization' : new URL(passport.site.website).hostname);
		const blob = new Blob([JSON.stringify(passport, null, 2)], { type: 'application/json' });
		const link = document.createElement('a');

		link.href = URL.createObjectURL(blob);
		link.download = `passport-${label}-${new Date().toISOString().slice(0, 10)}.json`;
		link.click();
		URL.revokeObjectURL(link.href);
	}
</script>

<section
	data-tour="organization-passport"
	class="flex max-w-3xl flex-col gap-4 rounded-lg border border-border bg-surface p-4 sm:p-6"
>
	<div class="flex flex-wrap items-start justify-between gap-2">
		<div>
			<h2 class="section-title">Паспорт из официальных источников</h2>
			<p class="text-sm text-muted-foreground">
				Реквизиты из ЕГРЮЛ по ИНН или названию, наименования, руководители подразделений и программы
				— из раздела «Сведения об образовательной организации» на сайте из карточки. Ничего не
				записывается само: отметьте, что принять, и сохраните форму.
			</p>
		</div>
		{#if live}
			<StatusBadge tone={availability.remaining > 0 ? 'neutral' : 'warning'}>
				Обращений на сегодня: {availability.remaining} из {availability.dailyQuota}
			</StatusBadge>
		{/if}
	</div>

	{#if !live}
		<Alert.Root>
			<TriangleAlertIcon aria-hidden="true" />
			<Alert.Title>Внешние источники выключены</Alert.Title>
			<Alert.Description>
				Заполните карточку вручную или загрузите снимок паспорта файлом — он пройдёт тот же дифф с
				подтверждением. Включает источники администратор в общих настройках.
			</Alert.Description>
		</Alert.Root>
	{:else if !availability.registryConfigured}
		<Alert.Root>
			<TriangleAlertIcon aria-hidden="true" />
			<Alert.Title>Поиск по ЕГРЮЛ не настроен</Alert.Title>
			<Alert.Description>
				Администратору стенда нужно задать переменную окружения <code>DADATA_API_KEY</code>. Раздел
				«Сведения» на сайте читается и без неё.
			</Alert.Description>
		</Alert.Root>
	{/if}

	<div class="flex flex-col gap-3">
		<!-- Enter в строке поиска — та же проверка, что и кнопка ниже: она стоит
			 вне формы и ссылается на неё атрибутом `form`. -->
		<form
			id="passport-registry-form"
			method="POST"
			action="?/passportRegistry"
			use:enhance={submitter('registry')}
			class="flex flex-col gap-1.5"
		>
			<div class="relative">
				<SearchIcon
					class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
					aria-hidden="true"
				/>
				<Input
					name="query"
					class="pl-8"
					autocomplete="off"
					aria-label="ИНН или название организации"
					aria-expanded={suggestOpen}
					aria-controls="passport-registry-suggestions"
					placeholder="Начните вводить ИНН или название"
					bind:value={query}
					oninput={onQueryInput}
					onkeydown={(event) => {
						if (event.key === 'Escape') {
							closeSuggestions();
						}
					}}
					disabled={!registryLive}
				/>
			</div>

			{#if suggestOpen}
				<div
					id="passport-registry-suggestions"
					class="rounded-md border border-border bg-surface shadow-sm"
					aria-live="polite"
				>
					{#if suggestLoading || suggestions === null}
						<p class="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground">
							<LoaderIcon class="size-3.5 animate-spin" aria-hidden="true" />
							Ищем в ЕГРЮЛ…
						</p>
					{:else if suggestError !== null}
						<p class="px-3 py-2 text-xs text-destructive" role="alert">{suggestError}</p>
					{:else if suggestions.length === 0}
						<p class="px-3 py-2 text-xs text-muted-foreground">
							В ЕГРЮЛ по этому запросу ничего не нашлось
						</p>
					{:else}
						<ul class="max-h-72 overflow-y-auto py-1">
							{#each suggestions as suggestion (suggestion.token)}
								<li>
									<button
										type="button"
										class="flex w-full flex-col gap-0.5 px-3 py-2 text-left focus-ring hover:bg-surface-muted"
										onclick={() => chooseSuggestion(suggestion)}
									>
										<span class="text-sm">
											{suggestion.passport.entity?.shortName ??
												suggestion.passport.fields.shortName?.value}
										</span>
										<span class="text-xs text-muted-foreground tabular-nums">
											{suggestionDetails(suggestion)}
										</span>
									</button>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			{/if}
		</form>

		<div class="flex flex-wrap gap-2">
			<Button
				type="submit"
				form="passport-registry-form"
				variant="outline"
				disabled={!registryLive || pending !== null}
				title="Найти по строке поиска без выбора из подсказок"
			>
				<SearchIcon aria-hidden="true" />
				{pending === 'registry' ? 'Проверяем…' : 'Проверить в ЕГРЮЛ'}
			</Button>

			<form method="POST" action="?/passportSite" use:enhance={submitter('site')}>
				<input type="hidden" name="website" value={website} />
				<Button
					type="submit"
					variant="outline"
					disabled={!live || website === '' || pending !== null}
					title={website === '' ? 'Сначала укажите сайт в карточке' : `Читать ${website}/sveden`}
				>
					<GlobeIcon aria-hidden="true" />
					{pending === 'site' ? 'Читаем сайт…' : 'Прочитать «Сведения» на сайте'}
				</Button>
			</form>

			<form
				method="POST"
				action="?/passportImport"
				enctype="multipart/form-data"
				use:enhance={submitter('import')}
				class="flex flex-wrap items-center gap-2"
			>
				<Input
					type="file"
					name="snapshot"
					accept="application/json,.json"
					aria-label="Снимок паспорта, JSON"
					class="max-w-64"
				/>
				<Button type="submit" variant="outline" disabled={pending !== null}>
					<FileJsonIcon aria-hidden="true" />
					{pending === 'import' ? 'Загружаем…' : 'Загрузить снимок'}
				</Button>
			</form>
		</div>
	</div>

	{#if failure}
		<Alert.Root variant="destructive">
			<TriangleAlertIcon aria-hidden="true" />
			<Alert.Title>{failure.message}</Alert.Title>
			{#if failure.issues.length > 0}
				<Alert.Description>
					<ul class="list-disc pl-4">
						{#each failure.issues as issue (issue)}
							<li>{issue}</li>
						{/each}
					</ul>
				</Alert.Description>
			{/if}
		</Alert.Root>
	{/if}

	{#if issued}
		{@const passport = issued.passport}
		{#if issued.via === 'snapshot'}
			<p class="text-xs text-muted-foreground">
				Загружен снимок: источник и дата в нём указаны тем, кто его собирал.
			</p>
		{/if}

		{#if passport.warnings.length > 0}
			<Alert.Root>
				<TriangleAlertIcon aria-hidden="true" />
				<Alert.Title>Проверьте глазами</Alert.Title>
				<Alert.Description>
					<ul class="list-disc pl-4">
						{#each passport.warnings as warning (warning)}
							<li>{warning}</li>
						{/each}
					</ul>
				</Alert.Description>
			</Alert.Root>
		{/if}

		{#if rows.length > 0}
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead class="text-left text-xs text-muted-foreground">
						<tr>
							<th class="w-8 py-1"><span class="sr-only">Принять</span></th>
							<th class="py-1 pr-2 font-medium">Поле</th>
							<th class="py-1 pr-2 font-medium">Сейчас в карточке</th>
							<th class="py-1 pr-2 font-medium">Из источника</th>
						</tr>
					</thead>
					<tbody>
						{#each rows as row (row.field)}
							<tr class="border-t border-border align-top">
								<td class="py-2">
									{#if !row.same}
										<Checkbox
											aria-label={`Принять: ${FIELD_LABELS[row.field]}`}
											checked={selected[row.field] === true}
											onCheckedChange={(next) =>
												(selected = { ...selected, [row.field]: next === true })}
										/>
									{/if}
								</td>
								<td class="py-2 pr-2">{FIELD_LABELS[row.field]}</td>
								<td class="py-2 pr-2 break-words text-muted-foreground">
									{display(row.field, row.current)}
								</td>
								<td class="py-2 pr-2 break-words">
									{#if row.same}
										<span class="text-faint">совпадает</span>
									{:else}
										{display(row.field, row.offered)}
									{/if}
									<div class="text-xs text-faint">
										{SOURCE_LABELS[row.source]} · {formatDateTime(row.fetchedAt)}
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}

		<div class="flex flex-wrap gap-2">
			<Button type="button" disabled={selectedCount === 0} onclick={acceptSelected}>
				Перенести отмеченное в форму{selectedCount > 0 ? ` (${selectedCount})` : ''}
			</Button>
			<Button type="button" variant="ghost" onclick={downloadSnapshot}>
				<DownloadIcon aria-hidden="true" />
				Скачать снимок JSON
			</Button>
		</div>

		{#if passport.entity}
			{@const entity = passport.entity}
			<div class="flex flex-col gap-1 text-sm">
				<div class="flex flex-wrap items-center gap-2">
					<span class="font-medium">По ЕГРЮЛ</span>
					<StatusBadge tone={entity.status === 'active' ? 'success' : 'warning'} dot>
						{STATUS_LABELS[entity.status]}
					</StatusBadge>
					{#if entity.isBranch}
						<StatusBadge tone="warning">Филиал</StatusBadge>
					{/if}
				</div>
				{#if entity.address}
					<div class="text-muted-foreground">Адрес: {entity.address}</div>
				{/if}
				{#if entity.management}
					<div class="text-muted-foreground">
						Руководитель: {entity.management.name}{entity.management.post
							? `, ${entity.management.post.toLocaleLowerCase('ru')}`
							: ''}
					</div>
				{/if}
				{#if passport.others.length > 0}
					<details class="mt-1">
						<summary class="cursor-pointer text-muted-foreground">
							Ещё под запрос попали: {passport.others.length}
						</summary>
						<ul class="mt-1 flex flex-col gap-1 pl-4">
							{#each passport.others as other, index (`${other.ogrn}/${other.kpp}/${index}`)}
								<li>
									{other.legalName}
									<span class="text-xs text-faint">
										ИНН {other.inn ?? '—'}, КПП {other.kpp ?? '—'} · {STATUS_LABELS[other.status]}
									</span>
								</li>
							{/each}
						</ul>
					</details>
				{/if}
			</div>
		{/if}

		{#if passport.site}
			{@const site = passport.site}
			<div class="flex flex-col gap-2 text-sm">
				<div class="text-muted-foreground">
					Сайт {site.website}, прочитан {formatDateTime(site.fetchedAt)}.
					{#if site.common.found && site.common.fields.address}
						Адрес по разделу: {site.common.fields.address}.
					{/if}
				</div>

				<details>
					<summary class="cursor-pointer font-medium">
						Кандидаты в контакты — руководители подразделений: {site.contacts.length}
					</summary>
					<p class="mt-1 text-xs text-muted-foreground">
						Из подраздела «Структура и органы управления». Сами в справочник не попадают: нужного
						человека заведите на карточке организации.
					</p>
					{#if site.contacts.length > 0}
						<ul class="mt-2 flex max-h-72 flex-col gap-1 overflow-y-auto pr-2">
							{#each site.contacts as contact, index (index)}
								<li class="border-t border-border pt-1 first:border-0">
									<div>{contact.name ?? '—'}{contact.post ? `, ${contact.post}` : ''}</div>
									<div class="text-xs text-faint">
										{contact.unit}{contact.email ? ` · ${contact.email}` : ''}
									</div>
								</li>
							{/each}
						</ul>
					{/if}
				</details>

				<details>
					<summary class="cursor-pointer font-medium">
						Реализуемые программы: {site.programs.length}
					</summary>
					{#if site.programs.length > 0}
						<ul class="mt-2 flex max-h-72 flex-col gap-1 overflow-y-auto pr-2">
							{#each site.programs as program, index (index)}
								<li class="border-t border-border pt-1 first:border-0">
									<div><span class="tabular-nums">{program.code}</span> {program.name}</div>
									<div class="text-xs text-faint">
										{[program.level, program.profile, program.forms.join(', ')]
											.filter((part) => part !== null && part !== '')
											.join(' · ')}
									</div>
								</li>
							{/each}
						</ul>
					{/if}
				</details>
			</div>
		{/if}
	{/if}

	{#if accepted.length > 0}
		<div class="flex flex-wrap items-center gap-2 border-t border-border pt-3 text-sm">
			<span class="text-muted-foreground">
				Принято из источника полей: {accepted.length}. Источник и дата запишутся в журнал при
				сохранении формы.
			</span>
			<Button type="button" variant="ghost" size="sm" onclick={() => (accepted = [])}>
				Сохранить как введённое вручную
			</Button>
		</div>
	{/if}
</section>
