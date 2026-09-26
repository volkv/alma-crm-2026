<script lang="ts">
	import LandmarkIcon from '@lucide/svelte/icons/landmark';
	import LoaderIcon from '@lucide/svelte/icons/loader-2';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SearchIcon from '@lucide/svelte/icons/search';
	import { deserialize } from '$app/forms';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import {
		EDUCATION_LEVEL_LABELS,
		ORGANIZATION_FORM_KIND_OPTIONS,
		ORGANIZATION_KIND_LABELS
	} from '$lib/components/directory/labels';
	import type { OrganizationFormKind } from '$lib/contracts/directory';
	import type { LegalStatus, RegistryCandidate } from '$lib/contracts/enrichment';

	/**
	 * Начало новой организации — одна строка поиска по ЕГРЮЛ.
	 *
	 * Сотрудник набирает название или ИНН, реестр отвечает списком, выбранная
	 * строка заводится организацией сразу — с реквизитами из выписки — и
	 * открывается её карточка. Вид угадывается по ОКВЭД и названию: похожая на
	 * учебное заведение заводится им, остальным строка предлагает выбрать вид
	 * (по умолчанию «Юридическое лицо»). Уже заведённая организация узнаётся по
	 * ИНН и открывается, а не дублируется.
	 *
	 * Каждое новое обращение к реестру стоит единицы суточной квоты, поэтому
	 * реестр спрашивается от трёх символов и с паузой после последней буквы.
	 */

	let {
		allowVendor
	}: {
		/** Предлагать ли вид «Вендор»: заводит вендоров только полный доступ. */
		allowVendor: boolean;
	} = $props();

	const kindOptions = $derived(
		allowVendor
			? ORGANIZATION_FORM_KIND_OPTIONS
			: ORGANIZATION_FORM_KIND_OPTIONS.filter((option) => option.value !== 'vendor')
	);

	const MIN_QUERY = 3;
	const DELAY_MS = 600;

	const STATUS_NOTES: Partial<Record<LegalStatus, string>> = {
		liquidating: 'По ЕГРЮЛ в процессе ликвидации',
		reorganizing: 'По ЕГРЮЛ в процессе реорганизации',
		bankrupt: 'По ЕГРЮЛ в процедуре банкротства',
		unknown: 'Состояние в ЕГРЮЛ не определено'
	};

	let query = $state('');
	let candidates = $state<RegistryCandidate[] | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	/** Строка, у которой раскрыт выбор вида, — её номер. */
	let choosing = $state<string | null>(null);
	let chosenKind = $state<OrganizationFormKind>('legal_entity');
	/** Строка, которую сейчас заводят, — её номер. */
	let creating = $state<string | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let generation = 0;

	$effect(() => () => clearTimeout(timer));

	const ready = $derived(query.trim().length >= MIN_QUERY);
	const manualHref = $derived(
		`${resolve('/organizations/new')}?manual${query.trim() === '' ? '' : `&name=${encodeURIComponent(query.trim())}`}`
	);

	function oninput(event: Event & { currentTarget: HTMLInputElement }) {
		query = event.currentTarget.value;
		generation += 1;
		clearTimeout(timer);
		candidates = null;
		error = null;
		choosing = null;
		loading = false;

		if (!ready) {
			return;
		}

		const current = generation;
		const text = query;

		loading = true;
		timer = setTimeout(() => void search(text, current), DELAY_MS);
	}

	/** Действие формы вызывается напрямую: подсказке не нужен `use:enhance`. */
	async function callAction(name: string, fields: Record<string, string>) {
		const body = new FormData();

		for (const [key, value] of Object.entries(fields)) {
			body.set(key, value);
		}

		const response = await fetch(`?/${name}`, {
			method: 'POST',
			body,
			headers: { 'x-sveltekit-action': 'true' }
		});

		return deserialize(await response.text());
	}

	async function search(text: string, current: number) {
		try {
			const result = await callAction('registrySearch', { query: text });

			if (current !== generation) {
				return;
			}

			if (result.type === 'success' && Array.isArray(result.data?.candidates)) {
				candidates = result.data.candidates as RegistryCandidate[];
			} else {
				candidates = [];
				error =
					result.type === 'failure'
						? String(result.data?.message ?? 'ЕГРЮЛ не ответил')
						: 'ЕГРЮЛ не ответил. Попробуйте позже';
			}
		} catch {
			if (current === generation) {
				candidates = [];
				error = 'ЕГРЮЛ не ответил. Попробуйте позже';
			}
		} finally {
			if (current === generation) {
				loading = false;
			}
		}
	}

	/** Заводит строку реестра и переходит в карточку — её вернёт сервер переадресацией. */
	async function create(candidate: RegistryCandidate, kind: OrganizationFormKind) {
		if (candidate.token === null || creating !== null) {
			return;
		}

		creating = candidate.token;
		error = null;

		try {
			const result = await callAction('registryCreate', { token: candidate.token, kind });

			if (result.type === 'redirect') {
				// eslint-disable-next-line svelte/no-navigation-without-resolve -- адрес карточки собрал сервер через resolve()
				await goto(result.location);
				return;
			}

			error =
				result.type === 'failure'
					? String(result.data?.message ?? 'Не удалось создать организацию')
					: 'Не удалось создать организацию';
		} catch {
			error = 'Не удалось создать организацию: нет связи с сервером';
		} finally {
			creating = null;
		}
	}

	/** Похожая на учебное заведение заводится им сразу, остальным — выбор вида. */
	function start(candidate: RegistryCandidate) {
		if (candidate.looksEducational) {
			void create(candidate, 'educational_institution');
			return;
		}

		chosenKind = 'legal_entity';
		choosing = candidate.token;
	}

	function details(candidate: RegistryCandidate): string {
		return [
			`ИНН ${candidate.inn}`,
			candidate.kpp === null ? null : `КПП ${candidate.kpp}`,
			candidate.region,
			candidate.isBranch ? 'филиал' : null
		]
			.filter((part) => part !== null)
			.join(' · ');
	}

	/** Вид, которым строка заведётся по угадыванию, — одной фразой. */
	function guessed(candidate: RegistryCandidate): string | null {
		if (!candidate.looksEducational) {
			return null;
		}

		return candidate.educationLevel === null
			? `${ORGANIZATION_KIND_LABELS.educational_institution} · уровень не определён`
			: `${ORGANIZATION_KIND_LABELS.educational_institution} · ${EDUCATION_LEVEL_LABELS[candidate.educationLevel]}`;
	}
</script>

<section
	data-tour="organization-new-registry"
	class="flex max-w-3xl flex-col gap-3 rounded-lg border border-border bg-surface p-4 sm:p-6"
>
	<div class="flex flex-col gap-1">
		<h2 class="text-base font-medium">Найдите организацию в ЕГРЮЛ</h2>
		<p class="text-sm text-muted-foreground">
			Выберите её из списка — карточка создастся с реквизитами из реестра: наименованиями, ИНН, КПП,
			ОГРН и регионом.
		</p>
	</div>

	<div class="relative">
		<SearchIcon
			class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
			aria-hidden="true"
		/>
		<Input
			type="search"
			class="pl-8"
			autocomplete="off"
			autofocus
			aria-label="Название организации или ИНН"
			aria-controls="organization-registry-results"
			placeholder="Начните вводить название организации или ИНН"
			value={query}
			{oninput}
		/>
	</div>

	{#if error !== null}
		<p class="text-sm text-destructive" role="alert">{error}</p>
	{/if}

	<div id="organization-registry-results" aria-live="polite" aria-busy={loading}>
		{#if loading}
			<p class="flex items-center gap-1.5 text-sm text-muted-foreground">
				<LoaderIcon class="size-4 animate-spin" aria-hidden="true" />
				Ищем в ЕГРЮЛ…
			</p>
		{:else if query.trim() !== '' && !ready}
			<p class="text-sm text-muted-foreground">Введите хотя бы {MIN_QUERY} символа</p>
		{:else if candidates !== null && candidates.length === 0}
			<div
				class="flex flex-col items-start gap-2 rounded-md border border-dashed border-border p-4"
			>
				<p class="text-sm">
					{error === null
						? 'В ЕГРЮЛ по этому запросу ничего не нашлось.'
						: 'Найти в ЕГРЮЛ не получилось.'}
					Организацию можно добавить вручную.
				</p>
				<Button href={manualHref}>
					<PencilIcon aria-hidden="true" />
					Добавить вручную
				</Button>
			</div>
		{:else if candidates !== null}
			<ul class="flex flex-col divide-y divide-border rounded-md border border-border">
				{#each candidates as candidate (`${candidate.inn}:${candidate.kpp}`)}
					{@const busy = creating !== null && creating === candidate.token}
					{@const kindHint = guessed(candidate)}
					{@const statusNote = STATUS_NOTES[candidate.status]}
					<li class="flex flex-col gap-2 px-3 py-2.5">
						<div class="flex items-start gap-3">
							<div class="flex min-w-0 flex-1 flex-col gap-0.5">
								<span class="text-sm font-medium">{candidate.shortName}</span>
								<span class="text-xs text-muted-foreground tabular-nums">
									{details(candidate)}
								</span>
								{#if candidate.existing !== null}
									<span class="text-xs text-muted-foreground">
										Уже в справочнике как «{candidate.existing.label}»
									</span>
								{:else if candidate.unavailable !== null}
									<span class="text-xs text-muted-foreground">{candidate.unavailable}</span>
								{:else if kindHint !== null}
									<span class="text-xs text-muted-foreground">{kindHint}</span>
								{/if}
								{#if statusNote !== undefined && candidate.unavailable === null}
									<span class="text-xs text-warning-soft-foreground">{statusNote}</span>
								{/if}
							</div>

							{#if candidate.existing !== null}
								<Button
									size="sm"
									variant="outline"
									href={resolve('/(app)/organizations/[id=uuid]', { id: candidate.existing.id })}
								>
									Открыть карточку
								</Button>
							{:else if candidate.token !== null && choosing !== candidate.token}
								<Button
									size="sm"
									variant="outline"
									disabled={creating !== null}
									aria-busy={busy}
									onclick={() => start(candidate)}
								>
									{#if busy}
										<LoaderIcon class="animate-spin" aria-hidden="true" />
										Создаём…
									{:else}
										<PlusIcon aria-hidden="true" />
										{candidate.looksEducational ? 'Создать' : 'Создать…'}
									{/if}
								</Button>
							{/if}
						</div>

						{#if candidate.token !== null && choosing === candidate.token}
							<div
								class="flex flex-wrap items-center gap-2 rounded-md bg-surface-muted px-2.5 py-2"
							>
								<span class="text-xs text-muted-foreground">
									По ОКВЭД и названию вид не угадывается. Создать как:
								</span>
								<Select.Root
									type="single"
									bind:value={
										() => chosenKind, (next) => (chosenKind = next as OrganizationFormKind)
									}
								>
									<Select.Trigger size="sm" aria-label="Вид организации">
										{ORGANIZATION_KIND_LABELS[chosenKind]}
									</Select.Trigger>
									<Select.Content>
										{#each kindOptions as option (option.value)}
											<Select.Item value={option.value} label={option.label} />
										{/each}
									</Select.Content>
								</Select.Root>
								<Button
									size="sm"
									disabled={creating !== null}
									aria-busy={busy}
									onclick={() => void create(candidate, chosenKind)}
								>
									{#if busy}
										<LoaderIcon class="animate-spin" aria-hidden="true" />
										Создаём…
									{:else}
										Создать
									{/if}
								</Button>
								<Button
									size="sm"
									variant="ghost"
									disabled={creating !== null}
									onclick={() => (choosing = null)}
								>
									Отмена
								</Button>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	<!-- Адрес ручной формы собран через resolve(): к нему дописана только строка
		 запроса с набранным текстом. -->
	<p class="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
		<LandmarkIcon class="size-3.5" aria-hidden="true" />
		Нет в реестре или нужна своя карточка?
		<Button variant="link" size="xs" class="h-auto px-0" href={manualHref}>Добавить вручную</Button>
	</p>
</section>
