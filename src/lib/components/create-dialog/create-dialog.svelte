<script lang="ts" module>
	import { tick, untrack } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { withoutParam } from '$lib/components/directory/query';
	import { CREATE_PARAM } from './open-param';

	/**
	 * Убрать `?create` и подстановки из адреса, когда окно уже открыто: иначе
	 * обновление страницы открывало бы его снова. Вызывается из `onMount`.
	 *
	 * `replaceState` до отметки готовности маршрутизатора отказывает, а
	 * ближайший такт — уже за ней (тот же приём — `directory/flash.svelte`).
	 */
	export async function consumeCreateParam(...extra: string[]): Promise<void> {
		const names = [CREATE_PARAM, ...extra];

		if (!names.some((name) => page.url.searchParams.has(name))) return;

		await tick();
		const cleaned = withoutParam(page.url, ...names);

		replaceState(cleaned, page.state);
	}

	/**
	 * Открыть окно, когда адрес этого просит (`requested` — обычно
	 * `data.create?.openOnLoad`), и убрать просьбу из адреса. Следит за данными
	 * страницы, а не за её монтированием: ссылка с `?create` на тот же экран,
	 * где человек уже стоит (быстрое действие поиска), страницу не пересоздаёт,
	 * но загрузчик перечитывает — и окно открывается и так.
	 *
	 * Вызывается при создании компонента страницы.
	 */
	export function openWhenRequested(
		requested: () => boolean,
		open: () => void,
		...extra: string[]
	): void {
		$effect(() => {
			if (!requested()) return;

			untrack(open);
			void consumeCreateParam(...extra);
		});
	}
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import FormDialog from '$lib/components/form-dialog.svelte';

	/**
	 * Окно создания записи — одно на весь продукт: организации, человека,
	 * программы, взаимодействия и остального. Отдельных страниц «Новый …» нет:
	 * форма открывается над списком или карточкой, из которых её вызвали.
	 *
	 * Правила окна общие, поэтому живут здесь, а не в каждой форме:
	 * - закрывается только крестиком — клик мимо и `Esc` не прячут набранное;
	 *   с непустым вводом крестик спрашивает подтверждение (`dirty`);
	 * - верх прибит к постоянной высоте: подсказки поиска и раскрытые поля
	 *   растят окно вниз, а не раскачивают его вокруг центра;
	 * - кнопка отправки одна и называет действие; «Отмены» нет — её роль у
	 *   крестика.
	 *
	 * Форму внутри собирает вызывающий: тег `<form id={formId}>` и поля. Кнопка
	 * стоит в панели вне формы и находит её по `formId`.
	 */
	let {
		open = $bindable(false),
		title,
		description,
		formId,
		submitLabel,
		actions,
		submitting = false,
		dirty = false,
		width = 'default',
		onclose,
		children
	}: {
		open?: boolean;
		title: string;
		/** Что будет создано и что дополняют потом. */
		description?: string;
		/** `id` формы в теле окна: к ней привязана кнопка отправки. */
		formId?: string;
		/** Называет действие: «Создать организацию», а не «Сохранить». */
		submitLabel?: string;
		/**
		 * Своя панель кнопок вместо кнопки отправки — для шага без формы
		 * (поиск перед заполнением). Задан — `formId` и `submitLabel` не нужны.
		 */
		actions?: Snippet;
		/** `$submitting` из superforms. */
		submitting?: boolean;
		/** В форме есть несохранённый ввод: крестик спросит подтверждение. */
		dirty?: boolean;
		/** `default` — обычная форма, `wide` — форма с таблицей или двумя колонками. */
		width?: 'default' | 'wide';
		/** Окно закрылось (крестиком или страницей): форме пора забыть набранное. */
		onclose?: () => void;
		/** Сама форма. */
		children: Snippet;
	} = $props();

	/**
	 * Закрытие любым путём — крестиком или самой страницей после сохранения —
	 * сообщает форме: ей пора забыть набранное.
	 */
	let wasOpen = false;

	$effect(() => {
		if (open) {
			wasOpen = true;
		} else if (wasOpen) {
			wasOpen = false;
			untrack(() => onclose?.());
		}
	});

	const WIDTHS = {
		default: 'sm:max-w-[37rem]',
		wide: 'sm:max-w-[48rem]'
	} as const;
</script>

<FormDialog
	bind:open={() => open, (next) => (open = next)}
	{title}
	{description}
	{dirty}
	width="lg"
	class={WIDTHS[width]}
	closeOnlyByButton
	pinTop
>
	{@render children()}

	{#snippet footer()}
		{#if actions}
			{@render actions()}
		{:else}
			<FormActions form={formId} {submitting} {submitLabel} class="border-t-0 pt-0" />
		{/if}
	{/snippet}
</FormDialog>
