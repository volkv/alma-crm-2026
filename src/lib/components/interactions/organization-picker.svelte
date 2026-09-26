<script lang="ts">
	import LandmarkIcon from '@lucide/svelte/icons/landmark';
	import LoaderIcon from '@lucide/svelte/icons/loader-2';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SearchIcon from '@lucide/svelte/icons/search';
	import XIcon from '@lucide/svelte/icons/x';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import { EDUCATION_LEVEL_LABELS } from '$lib/components/directory/labels';
	import type { LookupOption } from '$lib/contracts/directory';
	import type { LegalStatus, RegistryCandidate, RegistryPickRole } from '$lib/contracts/enrichment';

	/**
	 * Выбор организации поиском по справочнику, а если её там нет — по ЕГРЮЛ.
	 *
	 * Справочник вузов длиннее любого выпадающего списка, поэтому компонент
	 * спрашивает сервер по мере набора и показывает то, что нашлось. Выбранное
	 * значение — идентификатор; подпись компонент помнит сам, чтобы форма после
	 * выбора показывала название, а не UUID.
	 *
	 * Реестр спрашивается сам, когда справочник ничего не нашёл, и по ссылке,
	 * когда нашёл что-то не то: каждое новое обращение к реестру стоит единицы
	 * суточной квоты сотрудника, и тратить её на каждую набранную букву при
	 * найденном в справочнике незачем. Выбранная строка реестра заводится
	 * организацией справочника сразу, с видом по этому полю.
	 */
	let {
		id,
		lookupPath,
		value = $bindable(null),
		label = $bindable(null),
		placeholder = 'Начните вводить название или ИНН',
		describedBy,
		invalid = false,
		registryRole = null,
		onselect
	}: {
		/** Идентификатор контрола: на него ссылается подпись поля. */
		id: string;
		/**
		 * Адрес подсказок. Приходит снаружи, потому что маршрут лежит внутри
		 * пространства, а ключ пространства знает страница, а не поле ввода.
		 */
		lookupPath: string;
		/** Выбранная организация или `null`. */
		value?: string | null;
		/** Название выбранной организации — для показа в поле. */
		label?: string | null;
		placeholder?: string;
		describedBy?: string;
		invalid?: boolean;
		/**
		 * Каким полем формы заводить организацию из ЕГРЮЛ; `null` — реестр
		 * недоступен (нет права, источники выключены, нет ключа), и поле ищет
		 * только по справочнику.
		 */
		registryRole?: RegistryPickRole | null;
		onselect?: (option: LookupOption | null) => void;
	} = $props();

	/** Короче трёх букв реестр отвечает сотней однофамильцев. */
	const REGISTRY_MIN_QUERY = 3;

	const STATUS_NOTES: Partial<Record<LegalStatus, string>> = {
		liquidating: 'в процессе ликвидации',
		reorganizing: 'в процессе реорганизации',
		bankrupt: 'в процедуре банкротства',
		unknown: 'состояние в ЕГРЮЛ не определено'
	};

	let query = $state('');
	let options = $state<LookupOption[]>([]);
	let loading = $state(false);
	let open = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let registryTimer: ReturnType<typeof setTimeout> | undefined;

	/** Строки реестра по последнему запросу; `null` — реестр ещё не спрашивали. */
	let candidates = $state<RegistryCandidate[] | null>(null);
	let registryLoading = $state(false);
	let registryError = $state<string | null>(null);
	/** Строка реестра, которую сейчас заводят, — её номер. */
	let creating = $state<string | null>(null);
	/** Выбранная организация только что заведена из ЕГРЮЛ. */
	let createdFromRegistry = $state(false);

	/**
	 * Номер набора: ответ на прежнюю строку не должен перетирать подсказки к
	 * новой, если сервер ответил на них в обратном порядке.
	 */
	let generation = 0;

	// Незавершённый поиск не должен дописывать подсказки в уже закрытую форму.
	$effect(() => () => {
		clearTimeout(timer);
		clearTimeout(registryTimer);
	});

	const registryReady = $derived(
		registryRole !== null && query.trim().length >= REGISTRY_MIN_QUERY
	);

	async function search(text: string, current: number) {
		loading = true;

		try {
			const response = await fetch(
				`${lookupPath}?kind=organizations&q=${encodeURIComponent(text)}`
			);
			const body: { items?: LookupOption[] } = response.ok ? await response.json() : {};

			if (current !== generation) {
				return;
			}

			options = body.items ?? [];

			// В справочнике пусто — спрашиваем реестр сами, с паузой сверх обычной:
			// реестр стоит квоты, и промежуточные строки быстрого набора ему не нужны.
			if (options.length === 0 && registryReady) {
				registryTimer = setTimeout(() => void searchRegistry(text, current), 350);
			}
		} finally {
			if (current === generation) {
				loading = false;
			}
		}
	}

	async function searchRegistry(text: string, current: number) {
		if (registryRole === null) {
			return;
		}

		registryLoading = true;
		registryError = null;

		try {
			const response = await fetch(`${lookupPath}?kind=registry&q=${encodeURIComponent(text)}`);
			const body: { items?: RegistryCandidate[]; error?: string } = await response
				.json()
				.catch(() => ({}));

			if (current !== generation) {
				return;
			}

			if (!response.ok) {
				candidates = [];
				registryError = body.error ?? 'ЕГРЮЛ не ответил. Попробуйте позже';
				return;
			}

			candidates = body.items ?? [];
		} catch {
			if (current === generation) {
				candidates = [];
				registryError = 'ЕГРЮЛ не ответил. Попробуйте позже';
			}
		} finally {
			if (current === generation) {
				registryLoading = false;
			}
		}
	}

	function oninput(event: Event & { currentTarget: HTMLInputElement }) {
		query = event.currentTarget.value;
		open = true;
		generation += 1;
		candidates = null;
		registryError = null;
		registryLoading = false;
		clearTimeout(timer);
		clearTimeout(registryTimer);

		const current = generation;
		timer = setTimeout(() => void search(query, current), 250);
	}

	function choose(option: LookupOption, fromRegistry = false) {
		value = option.id;
		label = option.label;
		query = '';
		open = false;
		options = [];
		candidates = null;
		registryError = null;
		createdFromRegistry = fromRegistry;
		onselect?.(option);
	}

	/**
	 * Строка реестра: уже есть в справочнике — выбирается она, нет — сервер
	 * заводит организацию по выданному им номеру строки и отдаёт её.
	 */
	async function pick(candidate: RegistryCandidate) {
		if (candidate.existing !== null) {
			choose(candidate.existing);
			return;
		}

		if (candidate.token === null || registryRole === null || creating !== null) {
			return;
		}

		creating = candidate.token;
		registryError = null;

		try {
			const response = await fetch(lookupPath, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({ token: candidate.token, role: registryRole })
			});
			const body: { item?: LookupOption; error?: string } = await response.json().catch(() => ({}));

			if (!response.ok || body.item === undefined) {
				registryError = body.error ?? 'Не удалось добавить организацию в справочник';
				return;
			}

			choose(body.item, true);
		} catch {
			registryError = 'Не удалось добавить организацию в справочник: нет связи с сервером';
		} finally {
			creating = null;
		}
	}

	function clear() {
		value = null;
		label = null;
		query = '';
		options = [];
		candidates = null;
		createdFromRegistry = false;
		onselect?.(null);
	}

	/** Реквизиты строки реестра одной строкой: по ним отличают головной вуз от филиала. */
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

	/** Что проверить глазами, прежде чем заводить: состояние, вид, уровень. */
	function notes(candidate: RegistryCandidate): string[] {
		const result: string[] = [];
		const status = STATUS_NOTES[candidate.status];

		if (status !== undefined && candidate.unavailable === null) {
			result.push(`По ЕГРЮЛ ${status}`);
		}

		if (registryRole === 'educational_institution' && candidate.existing === null) {
			if (!candidate.looksEducational) {
				result.push('По ОКВЭД и названию не похожа на учебное заведение');
			}

			if (candidate.educationLevel === null) {
				result.push('Уровень образования не определён — укажете в карточке');
			}
		}

		return result;
	}
</script>

<div class="flex flex-col gap-1.5" data-slot="organization-picker">
	{#if value !== null}
		<div
			class="flex items-center gap-2 rounded-md border border-border bg-surface-muted px-2.5 py-1.5"
		>
			<span class="min-w-0 flex-1 truncate text-sm">{label ?? value}</span>
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				aria-label="Очистить выбор организации"
				onclick={clear}
			>
				<XIcon aria-hidden="true" />
			</Button>
		</div>

		{#if createdFromRegistry}
			<InlineHint tone="info">
				<span>
					Организация добавлена в справочник с реквизитами из ЕГРЮЛ. Проверить и дополнить её можно
					в <a
						class="underline underline-offset-2"
						href={resolve('/(app)/organizations/[id=uuid]', { id: value })}
						target="_blank"
						rel="noopener">карточке</a
					>.
				</span>
			</InlineHint>
		{/if}
	{:else}
		<div class="relative">
			<SearchIcon
				class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
				aria-hidden="true"
			/>
			<Input
				{id}
				type="search"
				class="pl-8"
				autocomplete="off"
				{placeholder}
				aria-invalid={invalid}
				aria-describedby={describedBy}
				value={query}
				{oninput}
				onfocus={() => (open = true)}
			/>
		</div>

		{#if open}
			<div class="rounded-md border border-border bg-surface shadow-sm" aria-live="polite">
				{#if loading}
					<p class="px-3 py-2 text-xs text-muted-foreground">Ищем…</p>
				{:else if options.length === 0}
					<p class="px-3 py-2 text-xs text-muted-foreground">
						{#if query === ''}
							Введите часть названия или ИНН
						{:else if registryRole !== null && query.trim().length < REGISTRY_MIN_QUERY}
							В справочнике не нашлось. Для поиска в ЕГРЮЛ введите хотя бы {REGISTRY_MIN_QUERY} символа
						{:else if registryRole !== null}
							В справочнике не нашлось
						{:else}
							Ничего не нашлось
						{/if}
					</p>
				{:else}
					<ul class="max-h-56 overflow-y-auto py-1">
						{#each options as option (option.id)}
							<li>
								<button
									type="button"
									class="w-full px-3 py-1.5 text-left text-sm focus-ring hover:bg-surface-muted"
									onclick={() => choose(option)}
								>
									{option.label}
								</button>
							</li>
						{/each}
					</ul>

					{#if registryReady && candidates === null && !registryLoading}
						<button
							type="button"
							class="flex w-full items-center gap-1.5 border-t border-border px-3 py-2 text-left text-xs text-muted-foreground focus-ring hover:bg-surface-muted hover:text-foreground"
							onclick={() => {
								clearTimeout(registryTimer);
								void searchRegistry(query, generation);
							}}
						>
							<LandmarkIcon class="size-3.5" aria-hidden="true" />
							Нет нужной? Искать в ЕГРЮЛ
						</button>
					{/if}
				{/if}

				{#if !loading && (registryLoading || candidates !== null)}
					<section class="border-t border-border" aria-label="Организации из ЕГРЮЛ">
						<div class="flex flex-col gap-0.5 bg-surface-muted px-3 py-2">
							<p class="flex items-center gap-1.5 text-xs font-medium">
								<LandmarkIcon class="size-3.5" aria-hidden="true" />
								Из ЕГРЮЛ
							</p>
							<p class="text-xs text-muted-foreground">
								Выбранная организация будет добавлена в справочник с реквизитами из реестра.
							</p>
						</div>

						{#if registryError !== null}
							<p class="px-3 py-2 text-xs text-destructive" role="alert">{registryError}</p>
						{/if}

						{#if registryLoading}
							<p class="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground">
								<LoaderIcon class="size-3.5 animate-spin" aria-hidden="true" />
								Ищем в ЕГРЮЛ…
							</p>
						{:else if candidates !== null && candidates.length === 0 && registryError === null}
							<p class="px-3 py-2 text-xs text-muted-foreground">
								В ЕГРЮЛ по этому запросу ничего не нашлось
							</p>
						{:else if candidates !== null && candidates.length > 0}
							<ul class="max-h-72 overflow-y-auto py-1">
								{#each candidates as candidate (`${candidate.inn}:${candidate.kpp}`)}
									{@const candidateNotes = notes(candidate)}
									{@const busy = creating !== null && creating === candidate.token}
									<li>
										<button
											type="button"
											class="flex w-full items-start gap-3 px-3 py-2 text-left focus-ring enabled:hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-60"
											disabled={candidate.unavailable !== null || creating !== null}
											aria-busy={busy}
											onclick={() => void pick(candidate)}
										>
											<span class="flex min-w-0 flex-1 flex-col gap-0.5">
												<span class="text-sm">{candidate.shortName}</span>
												<span class="text-xs text-muted-foreground tabular-nums">
													{details(candidate)}
												</span>
												{#if registryRole === 'educational_institution' && candidate.educationLevel !== null && candidate.existing === null}
													<span class="text-xs text-muted-foreground">
														{EDUCATION_LEVEL_LABELS[candidate.educationLevel]}
													</span>
												{/if}
												{#if candidate.existing !== null}
													<span class="text-xs text-muted-foreground">
														Уже в справочнике как «{candidate.existing.label}»
													</span>
												{/if}
												{#if candidate.unavailable !== null}
													<span class="text-xs text-muted-foreground">{candidate.unavailable}</span>
												{/if}
												{#each candidateNotes as note (note)}
													<span class="text-xs text-warning-soft-foreground">{note}</span>
												{/each}
											</span>
											{#if busy}
												<span
													class="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
												>
													<LoaderIcon class="size-3.5 animate-spin" aria-hidden="true" />
													Добавляем…
												</span>
											{:else if candidate.existing !== null}
												<span class="shrink-0 text-xs text-muted-foreground">Выбрать</span>
											{:else if candidate.unavailable === null}
												<span
													class="flex shrink-0 items-center gap-1 rounded-4xl border border-border px-2 py-0.5 text-xs font-medium"
												>
													<PlusIcon class="size-3" aria-hidden="true" />
													Добавить
												</span>
											{/if}
										</button>
									</li>
								{/each}
							</ul>
						{/if}
					</section>
				{/if}
			</div>
		{/if}
	{/if}
</div>
