<script lang="ts" module>
	/** Ширина слоя: та же шкала, что у `Dialog.Content`. */
	const WIDTHS = {
		md: 'sm:max-w-md',
		lg: 'sm:max-w-lg',
		xl: 'sm:max-w-2xl'
	} as const;

	export type FormDialogWidth = keyof typeof WIDTHS;
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import ConfirmDialog from './confirm-dialog.svelte';
	import { cn } from '$lib/utils';

	/**
	 * Раскладка диалога с формой: заголовок сверху, прокручиваемое тело,
	 * панель кнопок, прибитая к нижнему краю слоя.
	 *
	 * Прокручивается именно тело, а не весь слой: полоса кнопок, прокрученная
	 * вместе с формой, встаёт посреди полей и накрывает то, что под ней (в
	 * диалоге стадии процесса под неё уходила подпись чек-листа целиком). Высота
	 * слоя — `100vh - 4rem`: диалог всегда виден полностью, а длинная форма
	 * добирает высоту прокруткой внутри себя.
	 *
	 * Кнопка отправки стоит в панели, то есть вне самой формы, поэтому она
	 * называет форму атрибутом `form`: поле и кнопка с этим атрибутом
	 * принадлежат форме, где бы ни стояли в разметке.
	 *
	 * **Закрытие с непустым вводом спрашивает подтверждение.** `Esc`, клик вне
	 * слоя и крестик — это не «отменить», а «уйти», и набранное объяснение
	 * исчезало от случайного нажатия молча. Что считать непустым вводом, знает
	 * только форма, поэтому она и передаёт `dirty`.
	 */
	let {
		open = $bindable(false),
		title,
		description,
		dirty = false,
		width = 'md',
		closeOnlyByButton = false,
		pinTop = false,
		titleClass,
		discardTitle = 'Закрыть без сохранения?',
		discardDescription = 'Введённое в форме пропадёт: диалог закроется, ничего не сохранив.',
		class: className,
		children,
		footer
	}: {
		open?: boolean;
		title: string;
		/** Зачем диалог открыт и что случится после отправки. */
		description?: string;
		/** В форме есть несохранённый ввод: закрытие спросит подтверждение. */
		dirty?: boolean;
		width?: FormDialogWidth;
		/**
		 * Закрывать только крестиком: клик вне слоя и `Esc` окно не трогают.
		 * Для длинной формы, которую случайный клик не должен прятать.
		 */
		closeOnlyByButton?: boolean;
		/**
		 * Прибить верхний край окна к постоянной высоте вместо центра экрана.
		 * Окно, которое растёт по ходу ввода (подсказки поиска, раскрытые
		 * секции), по центру скачет вверх и вниз; прибитое растёт только вниз.
		 */
		pinTop?: boolean;
		/** Заголовок крупнее обычного — у окна, которое открывает целый сценарий. */
		titleClass?: string;
		discardTitle?: string;
		discardDescription?: string;
		class?: string;
		/** Тело диалога: сама форма, она же и прокручивается. */
		children: Snippet;
		/** Панель кнопок внизу; `close` закрывает с тем же вопросом про ввод. */
		footer: Snippet<[{ close: () => void }]>;
	} = $props();

	let discardOpen = $state(false);

	/**
	 * Закрытие по просьбе человека: крестиком, `Esc`, кликом вне слоя или
	 * кнопкой панели. Успешная отправка закрывает диалог не этим путём, а
	 * сбросом `open` у владельца формы — вопроса там быть не должно.
	 */
	function requestClose() {
		if (dirty) {
			discardOpen = true;

			return;
		}

		open = false;
	}
</script>

<Dialog.Root bind:open={() => open, (next) => (next ? (open = true) : requestClose())}>
	<Dialog.Content
		interactOutsideBehavior={closeOnlyByButton ? 'ignore' : 'close'}
		escapeKeydownBehavior={closeOnlyByButton ? 'ignore' : 'close'}
		class={cn(
			'flex max-h-[calc(100vh-4rem)] flex-col gap-0 overflow-hidden p-0',
			pinTop && 'top-[8vh] max-h-[calc(92vh-2rem)] translate-y-0',
			WIDTHS[width],
			className
		)}
	>
		<Dialog.Header class="shrink-0 border-b border-border p-6 pr-12">
			<Dialog.Title class={titleClass}>{title}</Dialog.Title>
			{#if description}
				<Dialog.Description>{description}</Dialog.Description>
			{/if}
		</Dialog.Header>

		<!-- Место под полосу прокрутки держится всегда: появившись посреди ввода,
			она сужала бы поля, и форма дёргалась бы вбок. -->
		<div
			class="min-h-0 flex-1 [scrollbar-gutter:stable] overflow-y-auto p-6"
			data-slot="dialog-body"
		>
			{@render children()}
		</div>

		<div class="shrink-0 border-t border-border px-6 py-4" data-slot="dialog-actions">
			{@render footer({ close: requestClose })}
		</div>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={discardOpen}
	title={discardTitle}
	description={discardDescription}
	confirmLabel="Закрыть без сохранения"
	cancelLabel="Вернуться к вводу"
	tone="danger"
	onconfirm={() => {
		open = false;
	}}
/>
