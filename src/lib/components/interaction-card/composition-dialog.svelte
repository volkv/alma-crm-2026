<script lang="ts">
	import DownloadIcon from '@lucide/svelte/icons/download';
	import LibraryIcon from '@lucide/svelte/icons/library';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SearchIcon from '@lucide/svelte/icons/search';
	import XIcon from '@lucide/svelte/icons/x';
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import FormDialog from '$lib/components/form-dialog.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import { actionEnhance } from '$lib/components/interactions/action-enhance';
	import OrganizationPicker from '$lib/components/interactions/organization-picker.svelte';
	import StaleNotice from '$lib/components/interactions/stale-notice.svelte';
	import { SITE_KIND_LABELS } from '$lib/components/directory/labels';
	import { SITE_KINDS, type LookupOption, type SiteKind } from '$lib/contracts/directory';
	import type { LearningGroupView } from '$lib/contracts/exchange';
	import { normalizeUnitName } from '$lib/contracts/enrichment';
	import type { SiteUnitOffer, SiteUnitOffers } from '$lib/contracts/organization-card';
	import {
		PARTY_ROLE_LABELS,
		PARTY_ROLES,
		type CompositionCatalog,
		type CompositionOperator,
		type InteractionView,
		type PartyRole
	} from '$lib/contracts/interactions';
	import { formatDate } from '$lib/format';
	import {
		COMPOSITION_SECTIONS,
		getCardCommands,
		type CompositionSection
	} from './commands.svelte';
	import { cardLiveUrl, LiveActivity } from './live.svelte';
	import type { CounterpartyShape } from './model';
	import SiteOffersSection from './site-offers-section.svelte';
	import { SITE_POLL_ATTEMPTS, SITE_POLL_INTERVAL_MS } from './site-offers';

	/**
	 * «Изменить состав»: стороны дела, программы с версиями и продукты — на
	 * месте, из карточки. Открывается на нужном разделе из блока правой
	 * колонки или по ссылке `?compose=parties` (так ведёт отказ пакета
	 * документов, которому не хватило стороны).
	 *
	 * Форма присылает итоговые списки целиком — так их и пишет сервер. То, что
	 * от состава зависит в договоре, форма пересчитывает сама и называет до
	 * сохранения: смена основной стороны снимает договор (он принадлежит ей),
	 * снятый продукт уводит свою позицию договора. Потоки, заявленные по снятой
	 * программе, остаются, но стадии больше не засчитываются — это тоже
	 * сказано заранее.
	 *
	 * Версия записи — та, с которой диалог открыли; чужая правка после неё —
	 * отказ в самом диалоге, ввод остаётся.
	 */
	let {
		interaction,
		catalog,
		operator,
		groups,
		shape
	}: {
		interaction: InteractionView;
		catalog: CompositionCatalog;
		operator: CompositionOperator;
		/** Потоки дела: по ним видно, что затронет снятие программы. */
		groups: readonly LearningGroupView[];
		shape: CounterpartyShape;
	} = $props();

	type DraftParty = {
		organizationId: string;
		organizationName: string;
		partyRole: PartyRole;
		isPrimary: boolean;
		contactAffiliationId: string | null;
		siteIds: string[];
	};

	type DraftProgram = {
		programId: string;
		code: string;
		name: string;
		programVersionId: string | null;
	};

	type Draft = { parties: DraftParty[]; programs: DraftProgram[]; productIds: string[] };

	const commands = getCardCommands();
	const liveUrl = $derived(cardLiveUrl(page.params));
	const lookupPath = $derived(
		`${resolve('/(app)/w/[workspace]/interactions', { workspace: page.params.workspace ?? '' })}/lookup`
	);

	const open = {
		get: () => commands.composition !== null,
		set: (next: boolean) => {
			if (!next) commands.close();
		}
	};

	function draftOf(source: InteractionView): Draft {
		return {
			parties: source.parties.map((party) => ({
				organizationId: party.organizationId,
				organizationName: party.organizationName,
				partyRole: party.partyRole,
				isPrimary: party.isPrimary,
				contactAffiliationId: party.contactAffiliationId,
				siteIds: party.sites.map((site) => site.id)
			})),
			programs: source.programs.map((program) => ({
				programId: program.programId,
				code: program.code,
				name: program.name,
				programVersionId: program.programVersionId
			})),
			productIds: source.products.map((product) => product.productId)
		};
	}

	let base = $state(untrack(() => draftOf(interaction)));
	let draft = $state(untrack(() => draftOf(interaction)));
	let section = $state<CompositionSection>('parties');
	let reason = $state('');
	let editVersion = $state(untrack(() => interaction.editVersion));
	let conflict = $state<string | null>(null);
	/** Сторона, которую сейчас меняют поиском: индекс в списке или новая с ролью. */
	let picking = $state<{ index: number } | { role: PartyRole } | null>(null);
	let newRole = $state<PartyRole>('customer');
	/** Выбранная поиском организация уже стоит стороной: сказать, а не молча пропустить. */
	let pickError = $state<string | null>(null);
	let programQuery = $state('');
	/** Переименовать дело вслед за сменой программы — только по согласию человека. */
	let retitle = $state(false);

	/**
	 * Новое название дела, когда одну программу заменили другой, а старая
	 * стояла в названии: название само не меняется (его могли написать
	 * руками), но предложить замену стоит. `null` — предлагать нечего.
	 */
	const renamedTitle = $derived.by(() => {
		const removed = base.programs.filter(
			(program) => !draft.programs.some((item) => item.programId === program.programId)
		);
		const added = draft.programs.filter(
			(program) => !base.programs.some((item) => item.programId === program.programId)
		);

		if (
			removed.length !== 1 ||
			added.length !== 1 ||
			!interaction.title.includes(removed[0].name)
		) {
			return null;
		}

		return interaction.title.replace(removed[0].name, added[0].name);
	});
	let productQuery = $state('');

	// Диалог открывается с тем составом, что в записи сейчас, и на том
	// разделе, из которого его позвали.
	$effect(() => {
		const requested = commands.composition;

		untrack(() => {
			if (requested === null) return;

			section = requested;
			base = draftOf(interaction);
			draft = draftOf(interaction);
			reason = '';
			editVersion = interaction.editVersion;
			conflict = null;
			picking = null;
			pickError = null;
			programQuery = '';
			productQuery = '';
			newSiteName = '';
			newSiteKind = 'department';
			newSiteError = null;
			siteQuery = '';
			importError = null;
		});
	});

	/** Пока диалог открыт, коллеги видят у аватарки «редактирует». */
	$effect(() => {
		if (commands.composition === null) {
			return;
		}

		const activity = new LiveActivity(liveUrl, 'editing');

		activity.hold();

		return () => activity.stop();
	});

	const dirty = $derived(JSON.stringify(draft) !== JSON.stringify(base) || reason.trim() !== '');

	const primary = $derived(draft.parties.find((party) => party.isPrimary) ?? null);
	const primaryOrganizationId = $derived(primary?.organizationId ?? null);

	/**
	 * Площадки основной стороны — среди них её подразделение: кафедра или
	 * институт, с которым идёт работа. Выбранное подразделение закрывает пункт
	 * «Найдено профильное подразделение». Список читается при открытии и при
	 * смене основной стороны: площадку могли завести в карточке организации
	 * минуту назад.
	 */
	let primarySites = $state<LookupOption[] | null>(null);
	let sitesError = $state<string | null>(null);

	/**
	 * Подразделения с сайта вуза, которых нет среди его площадок; `null` —
	 * блока нет (не вуз, нет права заводить площадки или ещё не спросили).
	 * Пока сервер читает сайт, ответ говорит «читается», и диалог спрашивает
	 * ещё раз — ограниченное число раз (`SITE_POLL_ATTEMPTS`).
	 */
	let unitOffers = $state<SiteUnitOffers | null>(null);
	let unitsError = $state<string | null>(null);
	let unitsExhausted = $state(false);
	/** Подразделение с сайта, которое сейчас заводят, — его название. */
	let importing = $state<string | null>(null);
	let importError = $state<string | null>(null);
	/** Поиск по площадкам: одна строка на оба блока — справочник и сайт. */
	let siteQuery = $state('');

	$effect(() => {
		const organizationId = commands.composition === null ? null : primaryOrganizationId;

		primarySites = null;
		sitesError = null;
		unitOffers = null;
		unitsError = null;
		unitsExhausted = false;

		if (organizationId === null) return;

		let current = true;
		let timer: ReturnType<typeof setTimeout> | undefined;

		loadSites(organizationId).then(
			(items) => {
				if (current) primarySites = items;
			},
			(failure: unknown) => {
				if (current) {
					sitesError = `Площадки не загрузились: ${failure instanceof Error ? failure.message : String(failure)}`;
				}
			}
		);

		const poll = (attempt: number) => {
			loadUnitOffers(organizationId).then(
				(offers) => {
					if (!current) return;

					unitOffers = offers;

					if (offers?.source.state !== 'warming') return;

					if (attempt < SITE_POLL_ATTEMPTS) {
						timer = setTimeout(() => poll(attempt + 1), SITE_POLL_INTERVAL_MS);
					} else {
						unitsExhausted = true;
					}
				},
				(failure: unknown) => {
					if (current) {
						unitsError = `Сведения с сайта не загрузились: ${failure instanceof Error ? failure.message : String(failure)}`;
					}
				}
			);
		};

		poll(1);

		return () => {
			current = false;
			clearTimeout(timer);
		};
	});

	async function loadUnitOffers(organizationId: string): Promise<SiteUnitOffers | null> {
		const response = await fetch(
			`${lookupPath}?kind=site-units&organizationId=${encodeURIComponent(organizationId)}`
		);

		if (!response.ok) {
			throw new Error(`сервер ответил ${response.status}`);
		}

		const body: { offers: SiteUnitOffers | null } = await response.json();

		return body.offers;
	}

	function matchesQuery(name: string): boolean {
		const text = normalizeUnitName(siteQuery);

		return text === '' || normalizeUnitName(name).includes(text);
	}

	/** Площадки справочника по поиску; отмеченные видны всегда — выбор не прячется. */
	const siteMatches = $derived(
		(primarySites ?? []).filter(
			(site) => matchesQuery(site.label) || (primary?.siteIds.includes(site.id) ?? false)
		)
	);

	const unitMatches = $derived((unitOffers?.units ?? []).filter((unit) => matchesQuery(unit.name)));

	/** Адрес, почта и телефон подразделения одной строкой — чтобы отличить однофамильцев. */
	function unitDetails(unit: SiteUnitOffer): string {
		return [unit.address, unit.email, unit.phone].filter((part) => part !== null).join(' · ');
	}

	/**
	 * Подразделение с сайта — площадкой вида «Подразделение», сразу отмеченной.
	 * Данные площадки сервер берёт из своего отчёта сайта; форма называет
	 * только название. Уже заведённое сервер не заводит второй раз, а отдаёт.
	 */
	async function importUnit(organizationId: string, unit: SiteUnitOffer) {
		if (importing !== null) return;

		importing = unit.name;
		importError = null;

		try {
			const response = await fetch(lookupPath, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ create: 'site-unit', unit: { organizationId, name: unit.name } })
			});
			const body: { item?: LookupOption; error?: string } = await response.json().catch(() => ({}));

			if (!response.ok || body.item === undefined) {
				importError = body.error ?? `Подразделение не заведено: сервер ответил ${response.status}`;
				return;
			}

			const site = body.item;

			if (!(primarySites ?? []).some((known) => known.id === site.id)) {
				primarySites = [...(primarySites ?? []), site];
			}

			toggleSite(site.id, true);

			if (unitOffers !== null) {
				unitOffers = {
					...unitOffers,
					units: unitOffers.units.filter((offer) => offer.name !== unit.name)
				};
			}
		} catch {
			importError = 'Подразделение не заведено: нет связи с сервером';
		} finally {
			importing = null;
		}
	}

	async function loadSites(organizationId: string): Promise<LookupOption[]> {
		const response = await fetch(
			`${lookupPath}?kind=sites&organizationId=${encodeURIComponent(organizationId)}`
		);

		if (!response.ok) {
			throw new Error(`сервер ответил ${response.status}`);
		}

		const body: { items: LookupOption[] } = await response.json();

		return body.items;
	}

	/**
	 * Новая площадка — прямо здесь: подразделения, с которым идёт работа,
	 * часто ещё нет в справочнике, и уводить за ним в карточку организации
	 * значило бы терять набранный состав. Заводит её тот же сервис, что форма
	 * площадки в карточке организации; заведённая сразу отмечена.
	 */
	let newSiteName = $state('');
	let newSiteKind = $state<SiteKind>('department');
	let newSiteError = $state<string | null>(null);
	let creatingSite = $state(false);

	async function createSite(organizationId: string) {
		const name = newSiteName.trim();

		if (name === '') {
			newSiteError = 'Укажите название площадки';
			return;
		}

		creatingSite = true;
		newSiteError = null;

		try {
			const response = await fetch(lookupPath, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					create: 'site',
					site: { organizationId, kind: newSiteKind, name }
				})
			});
			const body: { item?: LookupOption; error?: string } = await response.json();

			if (!response.ok || body.item === undefined) {
				newSiteError = body.error ?? `Площадка не заведена: сервер ответил ${response.status}`;
				return;
			}

			const site = body.item;

			primarySites = [...(primarySites ?? []), site];
			toggleSite(site.id, true);
			newSiteName = '';
			newSiteKind = 'department';
		} finally {
			creatingSite = false;
		}
	}

	function toggleSite(siteId: string, on: boolean) {
		draft.parties = draft.parties.map((party) =>
			party.isPrimary
				? {
						...party,
						siteIds: on
							? [...party.siteIds.filter((id) => id !== siteId), siteId]
							: party.siteIds.filter((id) => id !== siteId)
					}
				: party
		);
	}
	const primaryChanged = $derived(
		(primary?.organizationId ?? null) !==
			(interaction.parties.find((party) => party.isPrimary)?.organizationId ?? null)
	);

	/**
	 * Договор после правки: принадлежит основной стороне, и со сменой её он
	 * снимается; позиция живёт, пока её продукт в составе.
	 */
	const contract = $derived.by(() => {
		if (interaction.contract === null || primaryChanged) {
			return { contractId: null, contractItemIds: [] as string[] };
		}

		return {
			contractId: interaction.contract.id,
			contractItemIds: interaction.contract.items
				.filter((item) => draft.productIds.includes(item.productId))
				.map((item) => item.id)
		};
	});

	const droppedItems = $derived(
		interaction.contract === null || primaryChanged
			? []
			: interaction.contract.items.filter((item) => !draft.productIds.includes(item.productId))
	);

	/** Потоки, которые перестанут засчитываться стадии: их программу сняли. */
	const orphanedGroups = $derived(
		groups.filter(
			(group) =>
				group.program !== null &&
				!draft.programs.some((program) => program.programId === group.program?.id)
		)
	);

	const payload = $derived(
		JSON.stringify({
			parties: draft.parties.map((party) => ({
				organizationId: party.organizationId,
				partyRole: party.partyRole,
				isPrimary: party.isPrimary,
				contactAffiliationId: party.contactAffiliationId,
				siteIds: party.siteIds
			})),
			programs: draft.programs.map((program) => ({
				programId: program.programId,
				programVersionId: program.programVersionId
			})),
			productIds: draft.productIds,
			...contract,
			...(retitle && renamedTitle !== null ? { title: renamedTitle } : {})
		})
	);

	const hasOperator = $derived(draft.parties.some((party) => party.partyRole === 'operator'));
	const hasCustomer = $derived(
		draft.parties.some((party) => party.partyRole === 'customer' && !party.isPrimary)
	);

	/** Роли, в которых добавляют сторону поиском: оператор — только школа, его добавляют кнопкой. */
	const searchRoles = $derived(
		PARTY_ROLES.filter(
			(role) =>
				role !== 'operator' && !(shape === 'institution' && role === 'educational_institution')
		)
	);

	function roleLabel(party: DraftParty): string {
		// Основная сторона коммерческого обучения записана заказчиком, но
		// называть её так в диалоге значит путать с компанией-заказчиком вуза.
		if (party.isPrimary && shape !== 'institution') {
			return shape === 'person' ? 'Слушатель' : 'Компания';
		}

		return PARTY_ROLE_LABELS[party.partyRole];
	}

	function organizationHref(id: string) {
		return resolve('/(app)/organizations/[id=uuid]', { id });
	}

	function removeParty(index: number) {
		draft.parties = draft.parties.filter((_, position) => position !== index);
		picking = null;
	}

	function setRole(index: number, role: PartyRole) {
		draft.parties = draft.parties.map((party, position) =>
			position === index ? { ...party, partyRole: role } : party
		);
	}

	function addOperator() {
		if (operator.state !== 'configured') return;

		draft.parties = [
			...draft.parties.filter((party) => party.organizationId !== operator.id),
			{
				organizationId: operator.id,
				organizationName: operator.name,
				partyRole: 'operator',
				isPrimary: false,
				contactAffiliationId: null,
				siteIds: []
			}
		];
	}

	/**
	 * Выбранная поиском организация: новая сторона или замена прежней. У
	 * заменённой стороны контакт и площадки были чужими — они сбрасываются.
	 */
	function picked(option: { id: string; label: string } | null) {
		const target = picking;

		if (option === null || target === null) return;

		const taken = draft.parties.findIndex((party) => party.organizationId === option.id);

		// Организация участвует в деле один раз — так же проверяет и сервер.
		if (taken !== -1 && !('index' in target && taken === target.index)) {
			pickError = `«${option.label}» уже стоит стороной в роли «${roleLabel(draft.parties[taken])}»`;
			return;
		}

		pickError = null;

		if ('index' in target) {
			draft.parties = draft.parties.map((party, position) =>
				position === target.index
					? {
							...party,
							organizationId: option.id,
							organizationName: option.label,
							contactAffiliationId: null,
							siteIds: []
						}
					: party
			);
		} else {
			draft.parties = [
				...draft.parties,
				{
					organizationId: option.id,
					organizationName: option.label,
					partyRole: target.role,
					isPrimary: false,
					contactAffiliationId: null,
					siteIds: []
				}
			];
		}

		picking = null;
	}

	/* ------------------------------------------------------ программы */

	const programMatches = $derived.by(() => {
		const text = programQuery.trim().toLocaleLowerCase('ru');

		if (text === '') return [];

		return catalog.programs
			.filter(
				(program) =>
					!draft.programs.some((chosen) => chosen.programId === program.id) &&
					`${program.code} ${program.name}`.toLocaleLowerCase('ru').includes(text)
			)
			.slice(0, 8);
	});

	const productMatches = $derived.by(() => {
		const text = productQuery.trim().toLocaleLowerCase('ru');

		if (text === '') return [];

		return catalog.products
			.filter(
				(product) =>
					!draft.productIds.includes(product.id) &&
					`${product.code} ${product.name}`.toLocaleLowerCase('ru').includes(text)
			)
			.slice(0, 8);
	});

	function versionsOf(programId: string) {
		return catalog.programs.find((program) => program.id === programId)?.versions ?? [];
	}

	function versionLabel(programId: string, versionId: string | null): string {
		if (versionId === null) return 'Версия не закреплена';

		const version = versionsOf(programId).find((item) => item.id === versionId);

		return version === undefined
			? 'Закреплённая версия'
			: `Версия ${version.version} — с ${formatDate(version.effectiveFrom)}`;
	}

	function addProgram(program: CompositionCatalog['programs'][number]) {
		draft.programs = [
			...draft.programs,
			{ programId: program.id, code: program.code, name: program.name, programVersionId: null }
		];
		programQuery = '';
	}

	function setVersion(programId: string, versionId: string | null) {
		draft.programs = draft.programs.map((program) =>
			program.programId === programId ? { ...program, programVersionId: versionId } : program
		);
	}

	function productName(id: string): string {
		const product =
			catalog.products.find((item) => item.id === id) ??
			interaction.products.find((item) => item.productId === id);

		return product === undefined ? 'Продукт' : `${product.code} — ${product.name}`;
	}

	/** Позиции договора и потоки, которые держатся за программу или продукт. */
	function programTies(programId: string): string[] {
		return groups
			.filter((group) => group.program?.id === programId)
			.map((group) => `поток ${group.streamNumber}`);
	}

	function productTies(productId: string): string[] {
		return [
			...(interaction.contract?.items ?? [])
				.filter((item) => item.productId === productId)
				.map(() => `позиция договора № ${interaction.contract?.number ?? ''}`),
			...groups
				.filter((group) => group.products.some((product) => product.id === productId))
				.map((group) => `поток ${group.streamNumber}`)
		];
	}

	/** Карточка перечитана после отказа: нетронутое берётся из свежей записи. */
	function rebase() {
		const fresh = draftOf(interaction);
		const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

		draft = {
			parties: same(draft.parties, base.parties) ? fresh.parties : draft.parties,
			programs: same(draft.programs, base.programs) ? fresh.programs : draft.programs,
			productIds: same(draft.productIds, base.productIds) ? fresh.productIds : draft.productIds
		};
		base = fresh;
		editVersion = interaction.editVersion;
		conflict = null;
	}

	const submit = actionEnhance({
		onsuccess: () => commands.close(),
		onconflict: (message) => (conflict = message)
	});

	const isSection = (value: string): value is CompositionSection =>
		(COMPOSITION_SECTIONS as readonly string[]).includes(value);
</script>

{#snippet sitePicker(party: DraftParty)}
	<fieldset class="flex flex-col gap-2" data-slot="site-picker">
		<legend class="mb-1 text-xs text-muted-foreground">Подразделение и площадки</legend>
		{#if (primarySites?.length ?? 0) > 0 || (unitOffers?.units.length ?? 0) > 0}
			<div class="relative">
				<SearchIcon
					class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
					aria-hidden="true"
				/>
				<Input
					type="search"
					class="pl-8"
					placeholder="Найти подразделение: кафедра, институт, факультет"
					aria-label="Найти подразделение"
					bind:value={siteQuery}
					onkeydown={(event) => {
						// Enter в поиске не отправляет весь состав.
						if (event.key === 'Enter') event.preventDefault();
					}}
				/>
			</div>
		{/if}

		<section class="flex flex-col gap-1.5" aria-label="Площадки в справочнике">
			<p class="flex items-center gap-1.5 text-xs font-medium">
				<LibraryIcon class="size-3.5" aria-hidden="true" />
				В справочнике
			</p>
			{#if (primarySites?.length ?? 0) === 0}
				<p class="text-xs text-muted-foreground">
					У организации ещё нет площадок: импортируйте подразделение с сайта или добавьте его ниже.
				</p>
			{:else if siteMatches.length === 0}
				<p class="text-xs text-muted-foreground">Среди площадок организации не нашлось</p>
			{:else}
				<div class="flex max-h-48 flex-col gap-1.5 overflow-y-auto">
					{#each siteMatches as site (site.id)}
						<Label class="flex items-center gap-2 font-normal">
							<Checkbox
								checked={party.siteIds.includes(site.id)}
								onCheckedChange={(checked) => toggleSite(site.id, checked === true)}
							/>
							{site.label}
						</Label>
					{/each}
				</div>
			{/if}
		</section>

		{#if unitsError !== null}
			<p class="text-xs text-destructive" role="alert">{unitsError}</p>
		{:else if unitOffers !== null}
			<SiteOffersSection
				source={unitOffers.source}
				kind="units"
				total={unitOffers.total}
				shown={unitOffers.units.length}
				exhausted={unitsExhausted}
				hint="Подразделения из «Структуры» сайта, которых нет в справочнике. «Импортировать» заведёт площадку и отметит её."
				error={importError}
			>
				{#if unitMatches.length === 0}
					<p class="px-3 py-2 text-xs text-muted-foreground">С сайта по запросу ничего</p>
				{:else}
					<ul class="flex max-h-56 flex-col divide-y divide-border overflow-y-auto">
						{#each unitMatches as unit, index (`${unit.name}\u0000${index}`)}
							{@const details = unitDetails(unit)}
							<li class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-1.5">
								<div class="min-w-0 flex-1 basis-48">
									<p class="text-sm break-words">{unit.name}</p>
									{#if details !== ''}
										<p class="text-xs break-words text-muted-foreground">{details}</p>
									{/if}
								</div>
								<Button
									type="button"
									size="xs"
									variant="outline"
									disabled={importing !== null}
									onclick={() => importUnit(party.organizationId, unit)}
								>
									<DownloadIcon aria-hidden="true" />
									{importing === unit.name ? 'Импортируем…' : 'Импортировать'}
								</Button>
							</li>
						{/each}
					</ul>
				{/if}
			</SiteOffersSection>
		{/if}
	</fieldset>
{/snippet}

{#snippet newSite(organizationId: string)}
	<div class="flex flex-col gap-1.5" data-slot="new-site">
		<p class="text-xs font-medium">Добавить площадку</p>
		<div class="flex flex-wrap items-end gap-2">
			<Input
				class="min-w-0 flex-1 basis-48"
				aria-label="Название новой площадки"
				placeholder="Например: кафедра информационных систем"
				bind:value={newSiteName}
				onkeydown={(event) => {
					// Enter заводит площадку, а не отправляет весь состав.
					if (event.key === 'Enter') {
						event.preventDefault();
						void createSite(organizationId);
					}
				}}
			/>
			<Select.Root
				type="single"
				value={newSiteKind}
				onValueChange={(value) => (newSiteKind = value as SiteKind)}
			>
				<Select.Trigger size="sm" class="w-40" aria-label="Вид новой площадки">
					{SITE_KIND_LABELS[newSiteKind]}
				</Select.Trigger>
				<Select.Content>
					{#each SITE_KINDS as kind (kind)}
						<Select.Item value={kind} label={SITE_KIND_LABELS[kind]} />
					{/each}
				</Select.Content>
			</Select.Root>
			<Button
				type="button"
				size="sm"
				variant="outline"
				disabled={creatingSite || newSiteName.trim() === ''}
				onclick={() => createSite(organizationId)}
			>
				<PlusIcon aria-hidden="true" />
				{creatingSite ? 'Добавляем…' : 'Добавить и отметить'}
			</Button>
		</div>
		{#if newSiteError !== null}
			<p class="text-xs text-destructive" role="alert">{newSiteError}</p>
		{/if}
	</div>
{/snippet}

<FormDialog
	bind:open={open.get, open.set}
	title="Изменить состав"
	description="Стороны дела, программы и продукты. Правка попадёт в ленту вместе с причиной."
	{dirty}
	width="xl"
>
	<form
		id="card-composition-form"
		method="POST"
		action="?/compose"
		use:enhance={submit}
		class="flex flex-col gap-4"
	>
		<input type="hidden" name="editVersion" value={editVersion} />
		<input type="hidden" name="composition" value={payload} />
		{#if conflict !== null}
			<StaleNotice message={conflict} onrefreshed={rebase} />
		{/if}

		<Tabs.Root
			bind:value={
				() => section,
				(value: string) => {
					if (isSection(value)) section = value;
				}
			}
		>
			<Tabs.List variant="line" aria-label="Разделы состава">
				<Tabs.Trigger value="parties">Стороны</Tabs.Trigger>
				<Tabs.Trigger value="offering">Программы и продукты</Tabs.Trigger>
			</Tabs.List>

			<Tabs.Content value="parties" class="flex flex-col gap-4 pt-3">
				<ul class="flex flex-col divide-y divide-border rounded-lg border border-border">
					{#each draft.parties as party, index (`${party.organizationId}:${index}`)}
						<li class="flex flex-col gap-2 p-3">
							<div class="flex flex-wrap items-start justify-between gap-2">
								<div class="flex min-w-0 flex-col gap-0.5">
									<p class="text-xs text-muted-foreground">
										{roleLabel(party)}{party.isPrimary ? ' · основная сторона' : ''}
									</p>
									<a
										class="text-sm font-medium break-words text-link hover:text-link-hover hover:underline"
										href={organizationHref(party.organizationId)}
										target="_blank"
										rel="noopener">{party.organizationName}</a
									>
								</div>
								<div class="flex flex-wrap items-center gap-1.5">
									{#if !party.isPrimary && party.partyRole !== 'operator'}
										<Select.Root
											type="single"
											value={party.partyRole}
											onValueChange={(value) => setRole(index, value as PartyRole)}
										>
											<Select.Trigger
												size="sm"
												class="w-44"
												aria-label="Роль стороны «{party.organizationName}»"
											>
												{PARTY_ROLE_LABELS[party.partyRole]}
											</Select.Trigger>
											<Select.Content>
												{#each searchRoles as role (role)}
													<Select.Item value={role} label={PARTY_ROLE_LABELS[role]} />
												{/each}
											</Select.Content>
										</Select.Root>
									{/if}
									{#if party.partyRole !== 'operator'}
										<Button
											type="button"
											size="xs"
											variant="outline"
											onclick={() => (picking = { index })}
										>
											Сменить
										</Button>
									{/if}
									{#if !party.isPrimary}
										<Button
											type="button"
											size="xs"
											variant="outline"
											onclick={() => removeParty(index)}
										>
											<XIcon aria-hidden="true" />
											Убрать
										</Button>
									{/if}
								</div>
							</div>

							{#if party.isPrimary && party.partyRole !== 'operator'}
								{#if sitesError !== null}
									<p class="text-xs text-destructive" role="alert">{sitesError}</p>
								{:else if primarySites !== null}
									{@render sitePicker(party)}
								{/if}
								{#if primarySites !== null}
									{@render newSite(party.organizationId)}
								{/if}
							{/if}

							{#if picking !== null && 'index' in picking && picking.index === index}
								<OrganizationPicker
									id="card-composition-replace-{index}"
									{lookupPath}
									placeholder="Найдите организацию по названию или ИНН"
									onselect={picked}
								/>
								<Button
									type="button"
									size="xs"
									variant="ghost"
									class="w-fit"
									onclick={() => {
										picking = null;
										pickError = null;
									}}
								>
									Не менять
								</Button>
							{/if}
						</li>
					{/each}
				</ul>

				{#if primaryChanged && interaction.contract !== null}
					<InlineHint tone="warning">
						Договор № {interaction.contract.number} принадлежит прежней основной стороне и будет снят
						с дела. Договор новой стороны выбирают в панели договора.
					</InlineHint>
				{/if}

				{#if pickError !== null}
					<p class="text-xs text-destructive" role="alert">{pickError}</p>
				{/if}

				<div class="flex flex-col gap-2">
					<p class="text-sm font-medium">Добавить сторону</p>
					<div class="flex flex-wrap gap-2">
						{#if !hasOperator}
							{#if operator.state === 'configured'}
								<Button type="button" size="sm" variant="outline" onclick={addOperator}>
									<PlusIcon aria-hidden="true" />
									Оператор: {operator.name}
								</Button>
							{/if}
						{/if}
						{#if shape === 'institution' && !hasCustomer}
							<Button
								type="button"
								size="sm"
								variant="outline"
								onclick={() => (picking = { role: 'customer' })}
							>
								<PlusIcon aria-hidden="true" />
								Заказчик подготовки
							</Button>
						{/if}
					</div>
					{#if !hasOperator && operator.state === 'unavailable'}
						<InlineHint tone="warning">{operator.reason}</InlineHint>
					{/if}
					<div class="flex flex-wrap items-end gap-2">
						<div class="flex flex-col gap-1.5">
							<Label for="card-composition-role">Другая сторона в роли</Label>
							<Select.Root
								type="single"
								value={newRole}
								onValueChange={(value) => (newRole = value as PartyRole)}
							>
								<Select.Trigger id="card-composition-role" class="w-52">
									{PARTY_ROLE_LABELS[newRole]}
								</Select.Trigger>
								<Select.Content>
									{#each searchRoles as role (role)}
										<Select.Item value={role} label={PARTY_ROLE_LABELS[role]} />
									{/each}
								</Select.Content>
							</Select.Root>
						</div>
						<Button
							type="button"
							variant="outline"
							disabled={picking !== null}
							onclick={() => (picking = { role: newRole })}
						>
							<SearchIcon aria-hidden="true" />
							Найти организацию
						</Button>
					</div>
					{#if picking !== null && 'role' in picking}
						<OrganizationPicker
							id="card-composition-add"
							{lookupPath}
							placeholder="{PARTY_ROLE_LABELS[picking.role]}: название или ИНН"
							onselect={picked}
						/>
						<Button
							type="button"
							size="xs"
							variant="ghost"
							class="w-fit"
							onclick={() => {
								picking = null;
								pickError = null;
							}}
						>
							Не добавлять
						</Button>
					{/if}
				</div>
			</Tabs.Content>

			<Tabs.Content value="offering" class="flex flex-col gap-5 pt-3">
				<fieldset class="flex flex-col gap-2">
					<legend class="mb-1 text-sm font-medium">Образовательные программы</legend>
					{#if draft.programs.length === 0}
						<p class="text-xs text-muted-foreground">Программа не выбрана.</p>
					{/if}
					<ul class="flex flex-col gap-2">
						{#each draft.programs as program (program.programId)}
							{@const ties = programTies(program.programId)}
							{@const versions = versionsOf(program.programId)}
							<li class="flex flex-col gap-1.5 rounded-lg border border-border p-2.5">
								<div class="flex flex-wrap items-start justify-between gap-2">
									<p class="min-w-0 text-sm break-words">
										<span class="text-muted-foreground tabular-nums">{program.code}</span>
										{program.name}
									</p>
									<Button
										type="button"
										size="xs"
										variant="outline"
										onclick={() =>
											(draft.programs = draft.programs.filter(
												(item) => item.programId !== program.programId
											))}
									>
										<XIcon aria-hidden="true" />
										Убрать
									</Button>
								</div>
								{#if versions.length > 0}
									<Select.Root
										type="single"
										value={program.programVersionId ?? ''}
										onValueChange={(value) =>
											setVersion(program.programId, value === '' ? null : value)}
									>
										<Select.Trigger
											size="sm"
											class="w-full sm:w-72"
											aria-label="Версия программы «{program.name}»"
										>
											{versionLabel(program.programId, program.programVersionId)}
										</Select.Trigger>
										<Select.Content>
											<Select.Item value="" label="Версия не закреплена" />
											{#each versions as version (version.id)}
												<Select.Item
													value={version.id}
													label={`Версия ${version.version} — с ${formatDate(version.effectiveFrom)}`}
												/>
											{/each}
										</Select.Content>
									</Select.Root>
								{:else}
									<p class="text-xs text-muted-foreground">
										{versionLabel(program.programId, program.programVersionId)}
									</p>
								{/if}
								{#if ties.length > 0}
									<p class="text-xs text-muted-foreground">
										По программе заведены: {ties.join(', ')}
									</p>
								{/if}
							</li>
						{/each}
					</ul>
					<div class="relative">
						<SearchIcon
							class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
							aria-hidden="true"
						/>
						<Input
							type="search"
							class="pl-8"
							placeholder="Добавить программу: код или название"
							aria-label="Найти программу"
							bind:value={programQuery}
						/>
					</div>
					{#if programQuery.trim() !== ''}
						{#if programMatches.length === 0}
							<p class="text-xs text-muted-foreground">Среди действующих программ не нашлось</p>
						{:else}
							<ul class="flex flex-col rounded-md border border-border">
								{#each programMatches as match (match.id)}
									<li>
										<button
											type="button"
											class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm focus-ring hover:bg-surface-muted"
											onclick={() => addProgram(match)}
										>
											<PlusIcon class="size-3.5 shrink-0" aria-hidden="true" />
											{match.code} — {match.name}
										</button>
									</li>
								{/each}
							</ul>
						{/if}
					{/if}
					{#if renamedTitle !== null}
						<Label class="flex items-start gap-2 font-normal" data-slot="composition-retitle">
							<Checkbox
								checked={retitle}
								onCheckedChange={(checked) => (retitle = checked === true)}
								class="mt-0.5"
							/>
							<span class="text-sm break-words">
								Обновить название дела: «{renamedTitle}»
								<span class="block text-xs text-muted-foreground">
									Сейчас в названии прежняя программа. Документы, собранные дальше, возьмут новое
									название.
								</span>
							</span>
						</Label>
					{/if}
				</fieldset>

				<fieldset class="flex flex-col gap-2">
					<legend class="mb-1 text-sm font-medium">Продукты</legend>
					{#if draft.productIds.length === 0}
						<p class="text-xs text-muted-foreground">Продукт не выбран.</p>
					{/if}
					<ul class="flex flex-col gap-2">
						{#each draft.productIds as productId (productId)}
							{@const ties = productTies(productId)}
							<li
								class="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border p-2.5"
							>
								<div class="flex min-w-0 flex-col gap-0.5">
									<p class="text-sm break-words">{productName(productId)}</p>
									{#if ties.length > 0}
										<p class="text-xs text-muted-foreground">Связано: {ties.join(', ')}</p>
									{/if}
								</div>
								<Button
									type="button"
									size="xs"
									variant="outline"
									onclick={() =>
										(draft.productIds = draft.productIds.filter((item) => item !== productId))}
								>
									<XIcon aria-hidden="true" />
									Убрать
								</Button>
							</li>
						{/each}
					</ul>
					<div class="relative">
						<SearchIcon
							class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
							aria-hidden="true"
						/>
						<Input
							type="search"
							class="pl-8"
							placeholder="Добавить продукт: код или название"
							aria-label="Найти продукт"
							bind:value={productQuery}
						/>
					</div>
					{#if productQuery.trim() !== ''}
						{#if productMatches.length === 0}
							<p class="text-xs text-muted-foreground">Среди действующих продуктов не нашлось</p>
						{:else}
							<ul class="flex flex-col rounded-md border border-border">
								{#each productMatches as match (match.id)}
									<li>
										<button
											type="button"
											class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm focus-ring hover:bg-surface-muted"
											onclick={() => {
												draft.productIds = [...draft.productIds, match.id];
												productQuery = '';
											}}
										>
											<PlusIcon class="size-3.5 shrink-0" aria-hidden="true" />
											{match.code} — {match.name}
										</button>
									</li>
								{/each}
							</ul>
						{/if}
					{/if}
				</fieldset>

				{#if droppedItems.length > 0}
					<InlineHint tone="warning">
						С продуктом снимется и позиция договора: {droppedItems
							.map((item) => `«${item.name}»`)
							.join(', ')}.
					</InlineHint>
				{/if}
				{#if orphanedGroups.length > 0}
					<InlineHint tone="warning">
						{orphanedGroups.map((group) => `Поток ${group.streamNumber}`).join(', ')} заявлен по снятой
						программе: он останется в деле, но перестанет засчитываться стадиям.
					</InlineHint>
				{/if}
			</Tabs.Content>
		</Tabs.Root>

		<div class="flex flex-col gap-1.5">
			<Label for="card-composition-reason">Причина правки</Label>
			<Textarea
				id="card-composition-reason"
				name="reason"
				rows={2}
				placeholder="Например: заказчиком подготовки стала другая компания"
				bind:value={reason}
			/>
		</div>
	</form>

	{#snippet footer({ close })}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="outline" onclick={close}>Отмена</Button>
			<Button type="submit" form="card-composition-form" disabled={!dirty || picking !== null}>
				Сохранить состав
			</Button>
		</div>
	{/snippet}
</FormDialog>
