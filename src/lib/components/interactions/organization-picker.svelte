<script lang="ts">
	import SearchIcon from '@lucide/svelte/icons/search';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import type { LookupOption } from '$lib/contracts/directory';

	/**
	 * Выбор организации поиском по справочнику.
	 *
	 * Справочник вузов длиннее любого выпадающего списка, поэтому компонент
	 * спрашивает сервер по мере набора и показывает то, что нашлось. Выбранное
	 * значение — идентификатор; подпись компонент помнит сам, чтобы форма после
	 * выбора показывала название, а не UUID.
	 */
	let {
		id,
		lookupPath,
		value = $bindable(null),
		label = $bindable(null),
		placeholder = 'Начните вводить название или ИНН',
		describedBy,
		invalid = false,
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
		onselect?: (option: LookupOption | null) => void;
	} = $props();

	let query = $state('');
	let options = $state<LookupOption[]>([]);
	let loading = $state(false);
	let open = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	// Незавершённый поиск не должен дописывать подсказки в уже закрытую форму.
	$effect(() => () => clearTimeout(timer));

	async function search(text: string) {
		loading = true;

		try {
			const response = await fetch(
				`${lookupPath}?kind=organizations&q=${encodeURIComponent(text)}`
			);

			if (!response.ok) {
				options = [];
				return;
			}

			const body: { items?: LookupOption[] } = await response.json();
			options = body.items ?? [];
		} finally {
			loading = false;
		}
	}

	function oninput(event: Event & { currentTarget: HTMLInputElement }) {
		query = event.currentTarget.value;
		open = true;
		clearTimeout(timer);
		timer = setTimeout(() => void search(query), 250);
	}

	function choose(option: LookupOption) {
		value = option.id;
		label = option.label;
		query = '';
		open = false;
		options = [];
		onselect?.(option);
	}

	function clear() {
		value = null;
		label = null;
		query = '';
		options = [];
		onselect?.(null);
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
			<div class="rounded-md border border-border bg-surface shadow-sm">
				{#if loading}
					<p class="px-3 py-2 text-xs text-muted-foreground">Ищем…</p>
				{:else if options.length === 0}
					<p class="px-3 py-2 text-xs text-muted-foreground">
						{query === '' ? 'Введите часть названия' : 'Ничего не нашлось'}
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
				{/if}
			</div>
		{/if}
	{/if}
</div>
