<script lang="ts">
	import ExternalLink from '$lib/components/external-link.svelte';

	/**
	 * Строка с сервера, в которой адреса — ссылками: предупреждения паспорта
	 * называют страницу («по адресу https://…/sveden/ не прочитались»), и
	 * проверить её хочется одним щелчком. Разметку сервер не присылает — строка
	 * остаётся текстом, а ссылкой становится только найденный в ней http(s)-адрес.
	 * Знак препинания в конце адреса («…/sveden/:») к адресу не относится.
	 */
	let { text }: { text: string } = $props();

	type Part = { kind: 'text' | 'link'; value: string };

	const parts = $derived.by(() => {
		const found: Part[] = [];
		let rest = 0;

		for (const match of text.matchAll(/https?:\/\/[^\s«»"<>]+/gi)) {
			const url = match[0].replace(/[.,:;!?)]+$/, '');
			const start = match.index;

			if (start > rest) {
				found.push({ kind: 'text', value: text.slice(rest, start) });
			}

			found.push({ kind: 'link', value: url });
			rest = start + url.length;
		}

		if (rest < text.length) {
			found.push({ kind: 'text', value: text.slice(rest) });
		}

		return found;
	});
</script>

{#each parts as part, index (index)}{#if part.kind === 'link'}<ExternalLink
			href={part.value}
		/>{:else}{part.value}{/if}{/each}
