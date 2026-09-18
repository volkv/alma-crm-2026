<script lang="ts" module>
	import { getContext, setContext } from 'svelte';

	const POPUP_KEY = Symbol('select-popup');

	/** Связь триггера со списком: `aria-controls` у одного, `id` у другого. */
	export type SelectPopup = { readonly id: string; readonly open: boolean };

	/**
	 * Список этого выбора. Зовётся из триггера и из содержимого — оба живут
	 * внутри `Select.Root`, даже если разметку списка уносит портал: контекст
	 * идёт по дереву компонентов, а не по DOM.
	 */
	export function getSelectPopup(): SelectPopup {
		return getContext<SelectPopup>(POPUP_KEY);
	}
</script>

<script lang="ts">
	import { Select as SelectPrimitive } from 'bits-ui';

	let {
		open = $bindable(false),
		value = $bindable(),
		...restProps
	}: SelectPrimitive.RootProps = $props();

	const uid = $props.id();

	setContext<SelectPopup>(POPUP_KEY, {
		get id() {
			return `${uid}-listbox`;
		},
		get open() {
			return open;
		}
	});
</script>

<SelectPrimitive.Root bind:open bind:value={value as never} {...restProps} />
