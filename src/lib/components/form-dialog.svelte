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
		class={cn(
			'flex max-h-[calc(100vh-4rem)] flex-col gap-0 overflow-hidden p-0',
			WIDTHS[width],
			className
		)}
	>
		<Dialog.Header class="shrink-0 border-b border-border p-6 pr-12">
			<Dialog.Title>{title}</Dialog.Title>
			{#if description}
				<Dialog.Description>{description}</Dialog.Description>
			{/if}
		</Dialog.Header>

		<div class="min-h-0 flex-1 overflow-y-auto p-6" data-slot="dialog-body">
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
