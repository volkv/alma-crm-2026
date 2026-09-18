<script lang="ts">
	import { resolve } from '$app/paths';
	import type { LucideIcon } from '@lucide/svelte';
	import BuildingIcon from '@lucide/svelte/icons/building';
	import GraduationCapIcon from '@lucide/svelte/icons/graduation-cap';
	import HandshakeIcon from '@lucide/svelte/icons/handshake';
	import PackageIcon from '@lucide/svelte/icons/package';
	import * as Command from '$lib/components/ui/command/index.js';
	import {
		SEARCH_KINDS,
		SEARCH_MIN_QUERY_LENGTH,
		searchResultSchema,
		type SearchHit,
		type SearchKind
	} from '$lib/search/contract';
	import type { NavLink } from './nav-links';

	/**
	 * Единственная точка «найти что угодно»: `Ctrl`/`⌘` + `K` в любом месте
	 * приложения. Разделы палитра знает от оболочки — те же и в том же порядке,
	 * что в меню, — а записи спрашивает у `GET /search`, который отбирает их
	 * правами и областью доступа того, кто ищет.
	 */
	let {
		open = $bindable(false),
		links = []
	}: {
		open?: boolean;
		/** Разделы, открытые этому человеку; отбирает их оболочка. */
		links?: readonly NavLink[];
	} = $props();

	/**
	 * Пауза после последней нажатой буквы. Двести миллисекунд — это меньше, чем
	 * человек замечает, и при этом «организация» перестаёт быть двенадцатью
	 * запросами к базе.
	 */
	const DEBOUNCE_MS = 200;

	/** Куда ведёт группа выдачи и чем она подписана. */
	const KINDS: Record<
		SearchKind,
		{ heading: string; icon: LucideIcon; href: (id: string) => string }
	> = {
		organization: {
			heading: 'Организации',
			icon: BuildingIcon,
			href: (id) => resolve('/(app)/organizations/[id=uuid]', { id })
		},
		interaction: {
			heading: 'Взаимодействия',
			icon: HandshakeIcon,
			href: (id) => resolve('/(app)/interactions/[id=uuid]', { id })
		},
		program: {
			heading: 'Программы',
			icon: GraduationCapIcon,
			href: (id) => resolve('/(app)/programs/[id=uuid]', { id })
		},
		product: {
			heading: 'Продукты',
			icon: PackageIcon,
			href: (id) => resolve('/(app)/products/[id=uuid]', { id })
		}
	};

	/** Строка выдачи в том виде, в каком её рисует список. */
	type Row = {
		/** Значение пункта для bits-ui: оно же ключ цикла и обязано быть уникальным. */
		value: string;
		href: string;
		title: string;
		subtitle: string | null;
		icon: LucideIcon;
	};

	let query = $state('');
	let hits = $state<SearchHit[]>([]);
	let searching = $state(false);
	let failure = $state<string | null>(null);

	/**
	 * Номер последнего запроса. Обычная переменная, а не `$state`: на неё ничто
	 * не смотрит, а ответ на отменённый запрос отбрасывается сравнением с ней —
	 * закрытая палитра и новая строка увеличивают номер, и опоздавший ответ уже
	 * никуда не ложится.
	 */
	let issued = 0;

	const term = $derived(query.trim());
	const short = $derived(term.length < SEARCH_MIN_QUERY_LENGTH);

	/**
	 * Разделы. Пока запрос короткий — все, что человеку открыты: палитра с пустой
	 * строкой это и есть оглавление системы. Дальше они отбираются по названию
	 * наравне с записями.
	 */
	const sections = $derived(
		short ? links : links.filter((link) => link.label.toLowerCase().includes(term.toLowerCase()))
	);

	const groups = $derived([
		...(sections.length === 0
			? []
			: [{ key: 'sections', heading: 'Разделы', rows: sections.map(sectionRow) }]),
		...SEARCH_KINDS.flatMap((kind) => {
			const rows = hits.filter((hit) => hit.kind === kind).map(hitRow);

			return rows.length === 0 ? [] : [{ key: kind, heading: KINDS[kind].heading, rows }];
		})
	]);

	function sectionRow(link: NavLink): Row {
		return {
			value: `section:${link.href}`,
			href: link.href,
			title: link.label,
			subtitle: null,
			icon: link.icon
		};
	}

	function hitRow(hit: SearchHit): Row {
		return {
			value: `${hit.kind}:${hit.id}`,
			href: KINDS[hit.kind].href(hit.id),
			title: hit.title,
			subtitle: hit.subtitle,
			icon: KINDS[hit.kind].icon
		};
	}

	// Закрытая палитра не помнит прошлого запроса: следующее открытие начинается
	// с оглавления, а не с чужой выдачи.
	$effect(() => {
		if (!open) {
			query = '';
		}
	});

	$effect(() => {
		if (!open || short) {
			issued += 1;
			hits = [];
			failure = null;
			searching = false;

			return;
		}

		const wanted = term;
		searching = true;
		const timer = setTimeout(() => void run(wanted), DEBOUNCE_MS);

		return () => clearTimeout(timer);
	});

	async function run(wanted: string): Promise<void> {
		const token = ++issued;
		let result: { items: SearchHit[] };

		try {
			const response = await fetch(`${resolve('/(app)/search')}?q=${encodeURIComponent(wanted)}`, {
				headers: { accept: 'application/json' }
			});

			if (!response.ok) {
				settle(token, [], await refusal(response));

				return;
			}

			result = searchResultSchema.parse(await response.json());
		} catch {
			// Сеть не ответила или ответ разошёлся с контрактом. Сказать об этом
			// словами обязательно: пустой список на том же месте человек прочитает
			// как «ничего такого нет», а нет — связи.
			settle(token, [], 'Поиск не отвечает. Проверьте связь и повторите запрос.');

			return;
		}

		settle(token, result.items, null);
	}

	/** Ответ ложится в палитру, только если его ещё ждут. */
	function settle(token: number, items: SearchHit[], error: string | null): void {
		if (token !== issued) {
			return;
		}

		hits = items;
		failure = error;
		searching = false;
	}

	/** Чем отказал сервер: его словами, если он их прислал. */
	async function refusal(response: Response): Promise<string> {
		const body: unknown = await response.json().catch(() => null);

		if (
			typeof body === 'object' &&
			body !== null &&
			'error' in body &&
			typeof body.error === 'string'
		) {
			return body.error;
		}

		return `Поиск отказал: ответ ${response.status}.`;
	}
</script>

<!-- Отбор выключен: строки выбирает сервер — по правам, области доступа и ИНН,
	которого в подписи пункта может и не быть. Оставленный отбор bits-ui выкинул
	бы половину найденного, потому что искал бы по видимому тексту. -->
<Command.Dialog
	bind:open
	title="Поиск"
	description="Поиск по разделам, организациям, взаимодействиям, программам и продуктам"
	loop
	shouldFilter={false}
>
	<Command.Input placeholder="Что ищем?" bind:value={query} />
	<Command.List>
		{#if failure !== null}
			<p class="px-4 py-6 text-center text-sm text-danger-soft-foreground">{failure}</p>
		{:else if searching && groups.length === 0}
			<p class="px-4 py-6 text-center text-sm text-muted-foreground">Ищем…</p>
		{:else}
			<Command.Empty>По запросу «{term}» ничего не найдено.</Command.Empty>
		{/if}

		{#each groups as group (group.key)}
			<Command.Group heading={group.heading}>
				{#each group.rows as row (row.value)}
					{@const Icon = row.icon}
					<Command.LinkItem value={row.value} href={row.href} onSelect={() => (open = false)}>
						<Icon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						<span class="truncate">{row.title}</span>
						{#if row.subtitle !== null}
							<span class="ml-auto truncate pl-3 text-xs text-muted-foreground">{row.subtitle}</span
							>
						{/if}
					</Command.LinkItem>
				{/each}
			</Command.Group>
		{/each}
	</Command.List>
</Command.Dialog>
