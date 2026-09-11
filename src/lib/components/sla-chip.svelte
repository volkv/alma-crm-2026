<script lang="ts">
	import { daysUntil, formatDate, pluralize, type DateInput } from '$lib/format';
	import StatusBadge, { type StatusTone } from './status-badge.svelte';

	/**
	 * How much time is left before a deadline, coloured by how little that is.
	 * Put it next to a stage, a task or a document that has a due date; the
	 * wording and the tone both come from the date, so a list of chips can be
	 * scanned without reading any of them.
	 */
	let {
		/** The deadline itself. */
		deadline,
		/** Frozen "now", for tests and for rendering a list against one instant. */
		now = Date.now(),
		/** Days left at which the chip starts warning. */
		warnWithin = 3,
		class: className
	}: {
		deadline: DateInput;
		now?: DateInput;
		warnWithin?: number;
		class?: string;
	} = $props();

	const left = $derived(daysUntil(deadline, now));

	const tone = $derived<StatusTone>(
		left < 0 ? 'danger' : left <= warnWithin ? 'warning' : 'neutral'
	);

	const label = $derived(
		left < 0
			? `просрочено на ${pluralize(-left, ['день', 'дня', 'дней'])}`
			: left === 0
				? 'срок сегодня'
				: `осталось ${pluralize(left, ['день', 'дня', 'дней'])}`
	);
</script>

<StatusBadge {tone} dot title="Срок: {formatDate(deadline)}" class={className}>{label}</StatusBadge>
