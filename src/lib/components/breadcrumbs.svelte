<script lang="ts" module>
	import type { ResolvedPathname } from '$app/types';

	/**
	 * Шаг пути. `href` — то, что вернул `resolve()`: так адрес, которого нет,
	 * в крошку не попадёт.
	 */
	export type Breadcrumb = {
		label: string;
		href?: ResolvedPathname;
	};
</script>

<script lang="ts">
	import * as BreadcrumbUi from '$lib/components/ui/breadcrumb/index.js';

	/**
	 * Где эта страница лежит.
	 *
	 * Полоса стоит под шапкой, а не над ней: заголовок — первое, что читают, и
	 * отодвигать его ради пути неверно. Внизу путь отвечает на другой вопрос —
	 * не «как я сюда пришёл», а «где это находится», — и уезжает при прокрутке
	 * вместе со страницей, потому что второй раз он не нужен.
	 *
	 * Список приходит целиком, вместе с текущей страницей последним шагом:
	 * приклеивать её к заголовку автоматически — значит запрещать страницам,
	 * у которых крошка и заголовок называются по-разному, назвать их по-разному.
	 */
	let { items }: { items: readonly Breadcrumb[] } = $props();
</script>

{#if items.length > 0}
	<!-- `-order-1` ставит крошки сразу за шапкой, перед полосой демо-режима
		(`app-shell/app-shell.svelte`). -->
	<div class="-order-1 border-b border-border bg-surface px-4 py-1.5 sm:px-9">
		<BreadcrumbUi.Root>
			<BreadcrumbUi.List class="gap-1 text-xs sm:gap-2">
				{#each items as crumb, index (crumb.label)}
					{#if index > 0}
						<BreadcrumbUi.Separator class="[&>svg]:size-3" />
					{/if}
					<BreadcrumbUi.Item>
						{#if crumb.href}
							<BreadcrumbUi.Link href={crumb.href}>{crumb.label}</BreadcrumbUi.Link>
						{:else}
							<BreadcrumbUi.Page>{crumb.label}</BreadcrumbUi.Page>
						{/if}
					</BreadcrumbUi.Item>
				{/each}
			</BreadcrumbUi.List>
		</BreadcrumbUi.Root>
	</div>
{/if}
