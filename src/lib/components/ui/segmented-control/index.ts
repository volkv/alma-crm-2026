import Root from './segmented-control.svelte';
import Item from './segmented-control-item.svelte';
import LinkGroup from './segmented-control-link-group.svelte';
import Link from './segmented-control-link.svelte';

export type { SegmentedControlSize } from './context';

export {
	Root,
	Item,
	LinkGroup,
	Link,
	//
	Root as SegmentedControl,
	Item as SegmentedControlItem,
	LinkGroup as SegmentedControlLinkGroup,
	Link as SegmentedControlLink
};
