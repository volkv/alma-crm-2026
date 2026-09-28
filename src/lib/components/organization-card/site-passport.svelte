<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import UserPlusIcon from '@lucide/svelte/icons/user-plus';
	import { toast } from 'svelte-sonner';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { actionEnhance } from '$lib/components/interactions/action-enhance';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import {
		candidateUnitLabel,
		type ContactCandidate,
		type SiteReport
	} from '$lib/contracts/enrichment';
	import {
		normalizePersonName,
		splitPersonName,
		type ProgramMatchResult
	} from '$lib/contracts/organization-card';
	import ExternalLink from '$lib/components/external-link.svelte';
	import LinkedText from '$lib/components/linked-text.svelte';
	import { formatDateTime, pluralize } from '$lib/format';

	/**
	 * Раздел «Сведения об образовательной организации» с сайта вуза — прямо на
	 * его карточке. Шаги 1–2 работы с вузом: кого из руководителей завести
	 * контактом и какие программы школы ему предлагать.
	 *
	 * Это подготовка, а не текущая работа, поэтому раздел стоит под
	 * взаимодействиями и договорами и свёрнут: сверху — счётчики и первые
	 * рекомендации программ школы, кандидаты в контакты и перечень программ
	 * вуза — раскрытием.
	 *
	 * Чтение — то же действие, что в форме правки: та же квота и тот же кэш на
	 * неделю, поэтому повторное нажатие в течение недели ничего не стоит. Если
	 * раздел уже читали (кнопкой или прогревом из карточки дела), он приходит с загрузкой карточки (`initial`)
	 * и виден сразу. В
	 * реквизиты карточка отсюда ничего не пишет; контакт заводится только
	 * нажатием «Добавить в контакты», и данные кандидата сервер берёт из своей
	 * копии раздела, а не из формы.
	 */
	let {
		website,
		reading,
		initial,
		canAddContacts,
		contactNames
	}: {
		website: string | null;
		/** `null` — у сотрудника нет права читать раздел (право правки карточки). */
		reading: { enabled: boolean; remaining: number } | null;
		/** Раздел из кэша суток; `null` — сегодня его не читали. */
		initial: {
			site: SiteReport;
			warnings: string[];
			programMatch: ProgramMatchResult | null;
		} | null;
		canAddContacts: boolean;
		/** ФИО действующих контактов организации, приведённые к виду для сравнения. */
		contactNames: ReadonlySet<string>;
	} = $props();

	// Дальше блок живёт своим состоянием: «Перечитать» и добавление контактов
	// не должны сбрасывать прочитанное обратно к тому, что пришло с загрузкой.
	let site = $state<SiteReport | null>(untrack(() => initial?.site ?? null));
	let warnings = $state<string[]>(untrack(() => initial?.warnings ?? []));
	let programMatch = $state<ProgramMatchResult | null>(
		untrack(() => initial?.programMatch ?? null)
	);
	let failure = $state<string | null>(null);
	let pending = $state(false);
	let adding = $state<string | null>(null);
	let expanded = $state(false);

	/** Рекомендаций программ школы, видных без раскрытия. */
	const TOP_MATCHES = 3;

	const matches = $derived(programMatch?.matches ?? []);
	const shownMatches = $derived(expanded ? matches : matches.slice(0, TOP_MATCHES));
	/** С сайта не взято ничего: ни кандидатов, ни программ. */
	const emptyRead = $derived(
		site !== null && site.contacts.length === 0 && site.programs.length === 0
	);
	const newCandidates = $derived(
		site?.contacts.filter((candidate) => !isContact(candidate)).length ?? 0
	);

	const blocked = $derived.by((): string | null => {
		if (reading === null) {
			return 'Читать «Сведения» может сотрудник с правом правки карточки организации.';
		}

		if (!reading.enabled) {
			return 'Внешние источники выключены в общих настройках — включает администратор.';
		}

		if (website === null) {
			return 'У организации не указан сайт: укажите его в реквизитах, и раздел можно будет прочитать.';
		}

		return null;
	});

	const readSite: SubmitFunction = () => {
		pending = true;
		failure = null;

		return async ({ result }) => {
			pending = false;

			if (result.type === 'success' && result.data !== undefined) {
				site = (result.data.site as SiteReport | null) ?? null;
				warnings = (result.data.warnings as string[] | undefined) ?? [];
				programMatch = (result.data.programMatch as ProgramMatchResult | null) ?? null;

				return;
			}

			if (result.type === 'failure') {
				failure = String(result.data?.message ?? 'Раздел не прочитан');

				return;
			}

			if (result.type === 'error') {
				failure = result.error?.message ?? 'Сбой приложения';
			}
		};
	};

	function keyOf(candidate: ContactCandidate): string {
		return `${candidate.unit}\u0000${candidate.name}`;
	}

	/** Почему кандидата нельзя добавить одним щелчком; `null` — можно. */
	function refusal(candidate: ContactCandidate): string | null {
		return splitPersonName(candidate.name) === null ? 'ФИО из одного слова' : null;
	}

	function isContact(candidate: ContactCandidate): boolean {
		return contactNames.has(normalizePersonName(candidate.name));
	}

	function addCandidate(candidate: ContactCandidate): SubmitFunction {
		const submit = actionEnhance({
			onsuccess: () => toast.success(`${candidate.name} — в контактах организации`)
		});

		return async (input) => {
			adding = keyOf(candidate);
			const after = await submit(input);

			return async (options) => {
				await after?.(options);
				adding = null;
			};
		};
	}
</script>

<!-- `data-tour` — метка подсказок: по ней тур находит «Сведения» с сайта. -->
<section
	class="flex min-w-0 flex-col gap-3"
	aria-labelledby="org-site-title"
	data-tour="organization-site-passport"
>
	<div class="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
		<div class="min-w-0 flex-1 basis-64">
			<h2 id="org-site-title" class="section-title">Сведения с сайта вуза</h2>
			<p class="mt-1 text-xs text-muted-foreground">
				{#if blocked !== null}
					{blocked}
				{:else if site !== null}
					Сайт <ExternalLink class="break-all" href={site.website} />, прочитан {formatDateTime(
						site.fetchedAt
					)}.
				{:else}
					Руководители подразделений и программы из раздела «Сведения об образовательной
					организации». Обращений к внешним источникам на сегодня осталось: {reading?.remaining ??
						0}.
				{/if}
			</p>
		</div>
		{#if blocked === null}
			<form method="POST" action="?/readSite" use:enhance={readSite}>
				<input type="hidden" name="website" value={website} />
				<Button type="submit" variant="outline" size="sm" disabled={pending}>
					<GlobeIcon aria-hidden="true" />
					{pending
						? 'Читаем сайт…'
						: site === null
							? 'Прочитать «Сведения» на сайте'
							: 'Перечитать'}
				</Button>
			</form>
		{/if}
	</div>

	{#if failure !== null}
		<Alert.Root variant="destructive">
			<TriangleAlertIcon aria-hidden="true" />
			<Alert.Title>{failure}</Alert.Title>
		</Alert.Root>
	{/if}

	{#if site !== null}
		<ul class="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Прочитано с сайта">
			<li>
				Кандидатов в контакты: <span class="font-semibold tabular-nums">{site.contacts.length}</span
				>{#if site.contacts.length > 0}<span class="text-xs text-muted-foreground"
						>&nbsp;· новых {newCandidates}</span
					>{/if}
			</li>
			<li>
				Программ вуза: <span class="font-semibold tabular-nums">{site.programs.length}</span>
			</li>
			{#if programMatch !== null}
				<li>
					Подходит программ школы: <span class="font-semibold tabular-nums">{matches.length}</span>
				</li>
			{/if}
		</ul>

		<!-- Раздел прочитан, а взять из него нечего: почему — видно сразу, а не
			за раскрытием, иначе нули выглядят ответом сайта. -->
		{#if emptyRead && warnings.length > 0}
			<Alert.Root>
				<TriangleAlertIcon aria-hidden="true" />
				<Alert.Title>Проверьте глазами</Alert.Title>
				<Alert.Description>
					<ul class="list-disc pl-4">
						{#each warnings as warning (warning)}
							<li><LinkedText text={warning} /></li>
						{/each}
					</ul>
				</Alert.Description>
			</Alert.Root>
		{/if}

		{#if !emptyRead}
			<!-- Подбор программ школы виден сразу: это то, что вузу предлагать. -->
			<div class="flex min-w-0 flex-col gap-1">
				<h3 class="section-overline">Подходящие программы школы</h3>
				{#if programMatch === null}
					<p class="text-sm text-muted-foreground">
						Каталог программ закрыт правами: подбор делает сотрудник с правом «Просмотр программ».
					</p>
				{:else if matches.length === 0}
					<p class="text-sm text-muted-foreground">
						Ни одна действующая программа школы не совпала с программами вуза по укрупнённой группе
						направлений.
					</p>
				{:else}
					<ol class="flex flex-col divide-y divide-border">
						{#each shownMatches as match (match.programId)}
							<li class="flex flex-col gap-1 py-2">
								<div class="flex flex-wrap items-center gap-1.5">
									<SparklesIcon class="size-3.5 shrink-0 text-link" aria-hidden="true" />
									<span class="text-sm font-medium break-words">{match.programName}</span>
									<StatusBadge tone={match.sameCodeCount > 0 ? 'success' : 'accent'}>
										{match.directionCode}
									</StatusBadge>
									{#if match.priority !== null}
										<StatusBadge tone="neutral">приоритет {match.priority}</StatusBadge>
									{/if}
								</div>
								<p class="text-xs break-words text-muted-foreground">Почему: {match.reason}</p>
							</li>
						{/each}
					</ol>
				{/if}
			</div>

			<Button
				variant="link"
				size="sm"
				class="-ml-2.5 h-auto min-h-7 w-fit max-w-full text-left whitespace-normal"
				aria-expanded={expanded}
				aria-controls="org-site-details"
				onclick={() => (expanded = !expanded)}
			>
				<ChevronDownIcon
					class="transition-transform {expanded ? 'rotate-180' : ''}"
					aria-hidden="true"
				/>
				{#if expanded}
					Свернуть
				{:else}
					Кандидаты в контакты и программы вуза{matches.length > TOP_MATCHES
						? ` · ещё ${pluralize(matches.length - TOP_MATCHES, ['рекомендация', 'рекомендации', 'рекомендаций'])}`
						: ''}
				{/if}
			</Button>

			{#if expanded}
				<div id="org-site-details" class="flex min-w-0 flex-col gap-4">
					{#if warnings.length > 0}
						<Alert.Root>
							<TriangleAlertIcon aria-hidden="true" />
							<Alert.Title>Проверьте глазами</Alert.Title>
							<Alert.Description>
								<ul class="list-disc pl-4">
									{#each warnings as warning (warning)}
										<li><LinkedText text={warning} /></li>
									{/each}
								</ul>
							</Alert.Description>
						</Alert.Root>
					{/if}

					<!-- Кандидаты в контакты -->
					<div class="flex min-w-0 flex-col gap-2">
						<h3 class="section-overline">
							Кандидаты в контакты · {site.contacts.length}
						</h3>
						{#if site.contacts.length === 0}
							<p class="text-sm text-muted-foreground">
								В подразделе «Структура и органы управления» руководителей не нашлось.
							</p>
						{:else}
							<p class="text-xs text-faint">
								Источник: <ExternalLink class="break-all" href={site.struct.url} />. Источник и дата
								запишутся в примечание человека.
							</p>
							<ul class="flex flex-col divide-y divide-border">
								{#each site.contacts as candidate (keyOf(candidate))}
									{@const why = refusal(candidate)}
									<li class="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5 py-2">
										<div class="min-w-0 flex-1 basis-56 text-sm">
											<p class="font-medium break-words">{candidate.name}</p>
											{#if candidate.post}
												<p class="break-words">{candidate.post}</p>
											{/if}
											{#if candidateUnitLabel(candidate)}
												<p class="text-xs break-words text-muted-foreground">
													{candidateUnitLabel(candidate)}
												</p>
											{/if}
											{#if candidate.phone}
												<p class="text-xs break-all text-muted-foreground">{candidate.phone}</p>
											{/if}
											{#if candidate.email}
												<p class="text-xs break-all text-muted-foreground">{candidate.email}</p>
											{/if}
										</div>
										{#if isContact(candidate)}
											<StatusBadge tone="success">
												<CheckIcon class="size-3" aria-hidden="true" />
												В контактах
											</StatusBadge>
										{:else if why !== null}
											<span class="text-xs text-faint">Вручную: {why}</span>
										{:else if canAddContacts}
											<form
												method="POST"
												action="?/addSiteContact"
												use:enhance={addCandidate(candidate)}
											>
												<input type="hidden" name="unit" value={candidate.unit} />
												<input type="hidden" name="name" value={candidate.name} />
												<Button
													type="submit"
													variant="outline"
													size="sm"
													disabled={adding !== null}
												>
													<UserPlusIcon aria-hidden="true" />
													{adding === keyOf(candidate) ? 'Добавляем…' : 'Добавить в контакты'}
												</Button>
											</form>
										{/if}
									</li>
								{/each}
							</ul>
						{/if}
					</div>

					<!-- Программы вуза по укрупнённым группам и весь перечень -->
					<div class="flex min-w-0 flex-col gap-2">
						<h3 class="section-overline">
							Программы вуза · {site.programs.length}
						</h3>
						{#if site.programs.length === 0}
							<p class="text-sm text-muted-foreground">Перечень программ на сайте не прочитался.</p>
						{:else}
							{#if programMatch !== null}
								<ul class="flex flex-col gap-1 text-sm">
									{#each programMatch.universityGroups as row (row.group.code)}
										<li class="break-words">
											<span class="tabular-nums">{row.group.code}</span>
											{row.group.name ?? ''}
											<span class="text-xs text-muted-foreground">
												— {pluralize(row.count, ['программа', 'программы', 'программ'])}
											</span>
										</li>
									{/each}
								</ul>
							{/if}
							<details>
								<summary class="cursor-pointer text-xs text-link hover:text-link-hover">
									Весь перечень с кодами направлений
								</summary>
								<ul class="mt-2 flex flex-col gap-1">
									{#each site.programs as program, index (index)}
										<li class="border-t border-border pt-1 text-sm first:border-0">
											<span class="tabular-nums">{program.code}</span>
											<span class="break-words">{program.name}</span>
											<span class="block text-xs break-words text-faint">
												{[program.level, program.profile]
													.filter((part) => part !== null)
													.join(' · ')}
											</span>
										</li>
									{/each}
								</ul>
							</details>
						{/if}
						{#if programMatch !== null && (programMatch.universityOutside > 0 || programMatch.schoolWithoutCode > 0)}
							<p class="text-xs text-faint">
								{#if programMatch.universityOutside > 0}
									Программ вуза с кодом не по перечню ФГОС (научные специальности): {programMatch.universityOutside}
									— в подборе не участвуют.
								{/if}
								{#if programMatch.schoolWithoutCode > 0}
									Программ школы без кода направления: {programMatch.schoolWithoutCode} — им не с чем
									совпасть.
								{/if}
							</p>
						{/if}
					</div>
				</div>
			{/if}
		{/if}
	{/if}
</section>
