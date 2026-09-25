<script lang="ts" module>
	import markArch from './mark-arch.svg';
	import markGlyphDark from './mark-glyph-dark.svg';
	import markGlyph from './mark-glyph.svg';
	import markTile from './mark-tile.svg';

	/**
	 * Варианты знака «Альма». У каждого — рисунок для светлого фона и для
	 * тёмного; у знаков на плашке они совпадают: оранжевая плашка с белой
	 * буквой читается на любом фоне. Плашка и буква — та же пара, что у кнопки
	 * главного действия (`#e8470f` и белый, Lc 71 по APCA), чтобы оранжевый в
	 * интерфейсе был один.
	 *
	 * - `tile` — геометрическая «А» на оранжевой плашке. Знак по умолчанию: он же
	 *   значок вкладки и знак формы входа каталога.
	 * - `arch` — «А» аркой на той же плашке: буква и ворота вуза сразу.
	 * - `glyph` — одна буква без плашки, перекладина оранжевая.
	 */
	const MARK_VARIANTS = {
		tile: { light: markTile, dark: markTile },
		arch: { light: markArch, dark: markArch },
		glyph: { light: markGlyph, dark: markGlyphDark }
	} as const;

	export type MarkVariant = keyof typeof MARK_VARIANTS;
</script>

<script lang="ts">
	let {
		/** Сторона знака в пикселях. */
		size = 32,
		variant = 'tile',
		/**
		 * Под какой фон рисовать. `auto` следует теме интерфейса; `light` и
		 * `dark` — для мест, где фон известен заранее.
		 */
		tone = 'auto',
		/**
		 * Имя знака для экранного диктора. Без него знак декоративный: рядом
		 * обычно стоит название словом, и второй раз его читать незачем.
		 */
		label,
		class: className
	}: {
		size?: number;
		variant?: MarkVariant;
		tone?: 'auto' | 'light' | 'dark';
		label?: string;
		class?: string;
	} = $props();

	const sources = $derived(MARK_VARIANTS[variant]);
	const alt = $derived(label ?? '');
	const hidden = $derived(label === undefined ? true : undefined);
</script>

{#if tone === 'auto' && sources.light !== sources.dark}
	<img
		src={sources.light}
		{alt}
		aria-hidden={hidden}
		width={size}
		height={size}
		class="shrink-0 dark:hidden {className}"
	/>
	<img
		src={sources.dark}
		{alt}
		aria-hidden={hidden}
		width={size}
		height={size}
		class="hidden shrink-0 dark:block {className}"
	/>
{:else}
	<img
		src={tone === 'dark' ? sources.dark : sources.light}
		{alt}
		aria-hidden={hidden}
		width={size}
		height={size}
		class="shrink-0 {className}"
	/>
{/if}
