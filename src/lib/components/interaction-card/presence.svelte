<script lang="ts">
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import * as Avatar from '$lib/components/ui/avatar/index.js';
	import type { LivePerson } from '$lib/contracts/live';
	import { initials } from '$lib/format';

	/**
	 * Кто сейчас в карточке: аватарка на учётную запись, а вкладки одной
	 * учётки — числом на ней. Себя не прячем: демонстрационной учёткой
	 * пользуются несколько человек разом, и «вы» узнаётся по своей вкладке.
	 * Карандаш на аватарке — у человека открыта форма правки полей дела.
	 */
	let { people }: { people: readonly LivePerson[] } = $props();

	const here = $derived(people.filter((person) => person.online > 0));

	function caption(person: LivePerson): string {
		const tabs = person.online > 1 ? ` — вкладок: ${person.online}` : '';

		const editing = person.editing ? ' — редактирует' : '';

		return `${person.name}${person.you ? ' (вы)' : ''}${tabs}${editing}`;
	}
</script>

{#if here.length > 0}
	<div class="flex min-w-0 items-center gap-2" data-slot="card-presence">
		<span class="text-xs text-muted-foreground">Сейчас в карточке</span>
		<!--
			Без наложения: стандартное `-space-x-2` заезжает соседней аватаркой на
			инициалы — у двухбуквенной подписи (имя и фамилия) край следующего
			кружка перекрывает вторую букву предыдущего. Инициалы здесь — не
			декор, а то, по чему узнают коллегу, и должны читаться целиком у
			любого имени, не только у того, что оказалось на кадре. Кольцо фона
			(`ring-background` у каждой аватарки) само даёт стеку границу между
			кружками — сближать их ещё и внахлёст не нужно.
		-->
		<Avatar.Group class="space-x-0">
			{#each here as person (person.userId)}
				<Avatar.Root title={caption(person)}>
					<Avatar.Fallback
						class="text-xs font-medium {person.you
							? 'bg-primary-soft text-primary'
							: 'bg-success-soft text-success-soft-foreground'}"
					>
						{initials(person.name)}
					</Avatar.Fallback>
					{#if person.editing}
						<span
							class="absolute -top-1 -right-1 z-10 flex size-4 items-center justify-center rounded-full bg-surface text-primary ring-1 ring-border"
							aria-hidden="true"
							data-slot="presence-editing"><PencilIcon class="size-2.5" /></span
						>
					{/if}
					{#if person.online > 1}
						<span
							class="absolute -right-1 -bottom-1 z-10 rounded-full bg-surface px-1 text-[0.625rem] leading-4 font-medium tabular-nums ring-1 ring-border"
							aria-hidden="true">{person.online}</span
						>
					{/if}
				</Avatar.Root>
			{/each}
		</Avatar.Group>
		<span class="sr-only">{here.map(caption).join(', ')}</span>
	</div>
{/if}
