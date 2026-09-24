import { getContext, setContext } from 'svelte';

/** Плотность группы: один размер на все её варианты. */
export type SegmentedControlSize = 'default' | 'sm' | 'xs';

const KEY = Symbol('segmented-control-size');

export function setSegmentSize(size: () => SegmentedControlSize): void {
	setContext(KEY, size);
}

export function getSegmentSize(): () => SegmentedControlSize {
	const size = getContext<(() => SegmentedControlSize) | undefined>(KEY);
	if (size === undefined) {
		throw new Error('SegmentedControl item is rendered outside its group');
	}
	return size;
}
