<script lang="ts">
	/**
	 * Текст статьи справки.
	 *
	 * Принимает готовый HTML: разметку разбирает сервер (`$lib/help/markdown`),
	 * и делает он это один раз на страницу, а не в браузере на каждый переход.
	 * Источник — файлы репозитория, поэтому `{@html}` здесь не дыра: чужого
	 * ввода в этих строках не бывает.
	 *
	 * Оформление живёт здесь и нигде больше: экран и печатная страница берут
	 * один и тот же компонент, поэтому PDF не может оказаться свёрстанным иначе,
	 * чем то, что человек читал на экране.
	 */
	let { html }: { html: string } = $props();
</script>

<div class="help-prose">
	<!-- eslint-disable-next-line svelte/no-at-html-tags -->
	{@html html}
</div>

<style>
	/* Длину строки держит не сам блок, а его текстовые дети: снимок экрана
	   показывает целый раздел продукта, и урезанный до ширины абзаца он
	   перестаёт читаться. Поэтому текст остаётся в 68 знаках, а картинка
	   занимает всю колонку статьи. */
	.help-prose {
		line-height: 1.6;
	}

	.help-prose :global(:is(p, ul, ol, blockquote, pre, table, h2, h3, h4, h5, h6)) {
		max-width: 68ch;
	}

	.help-prose :global(h2),
	.help-prose :global(h3),
	.help-prose :global(h4),
	.help-prose :global(h5),
	.help-prose :global(h6) {
		font-weight: 600;
		letter-spacing: -0.01em;
		scroll-margin-top: 4rem;
	}

	.help-prose :global(h2) {
		margin-top: 2rem;
		font-size: 1.125rem;
	}

	.help-prose :global(h3) {
		margin-top: 1.5rem;
		font-size: 1rem;
	}

	.help-prose :global(h4),
	.help-prose :global(h5),
	.help-prose :global(h6) {
		margin-top: 1.25rem;
		font-size: 0.875rem;
	}

	.help-prose :global(:is(h2, h3, h4, h5, h6):first-child) {
		margin-top: 0;
	}

	.help-prose :global(p),
	.help-prose :global(ul),
	.help-prose :global(ol),
	.help-prose :global(blockquote),
	.help-prose :global(pre),
	.help-prose :global(table) {
		margin-top: 0.75rem;
	}

	.help-prose :global(ul),
	.help-prose :global(ol) {
		padding-left: 1.5rem;
	}

	.help-prose :global(ul) {
		list-style: disc;
	}

	.help-prose :global(ol) {
		list-style: decimal;
	}

	.help-prose :global(li) {
		margin-top: 0.25rem;
	}

	.help-prose :global(a) {
		color: var(--color-link);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	/* Разметка оборачивает одиночную картинку абзацем — он тоже не должен
	   держать её в ширине строки. */
	.help-prose :global(p:has(> img)) {
		max-width: none;
	}

	.help-prose :global(img) {
		display: block;
		margin-top: 1rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		max-width: 100%;
		height: auto;
	}

	.help-prose :global(strong) {
		font-weight: 600;
	}

	.help-prose :global(code) {
		border-radius: var(--radius-sm);
		background-color: var(--color-surface-muted);
		padding: 0.0625rem 0.25rem;
		font-size: 0.8125rem;
	}

	.help-prose :global(pre) {
		overflow-x: auto;
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		background-color: var(--color-surface-muted);
		padding: 0.75rem;
	}

	.help-prose :global(pre code) {
		background-color: transparent;
		padding: 0;
	}

	.help-prose :global(blockquote) {
		border-left: 2px solid var(--color-border-strong);
		padding-left: 0.75rem;
		color: var(--color-muted-foreground);
	}

	.help-prose :global(table) {
		display: block;
		width: 100%;
		overflow-x: auto;
		border-collapse: collapse;
		font-size: 0.8125rem;
	}

	.help-prose :global(th),
	.help-prose :global(td) {
		border-bottom: 1px solid var(--color-border);
		padding: 0.375rem 0.75rem 0.375rem 0;
		text-align: left;
		vertical-align: top;
	}

	.help-prose :global(th) {
		font-weight: 600;
		color: var(--color-muted-foreground);
	}

	@media print {
		.help-prose :global(:is(p, ul, ol, blockquote, pre, table, h2, h3, h4, h5, h6)) {
			max-width: none;
		}

		/* Снимок не делится между страницами и не уезжает за поле листа: при
		   ширине окна съёмки 1280×860 шестнадцать сантиметров по ширине дают
		   около одиннадцати по высоте — это половина полосы A4. */
		.help-prose :global(img) {
			break-inside: avoid;
			max-width: 16cm;
		}

		/* Заголовок не должен оставаться последней строкой страницы, а таблица —
		   разрываться посередине: в PDF это читается как потерянный кусок. */
		.help-prose :global(:is(h2, h3, h4, h5, h6)) {
			break-after: avoid;
		}

		.help-prose :global(table),
		.help-prose :global(pre),
		.help-prose :global(blockquote) {
			break-inside: avoid;
		}
	}
</style>
