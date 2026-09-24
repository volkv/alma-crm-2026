<script lang="ts">
	import * as Avatar from '$lib/components/ui/avatar/index.js';
	import * as Popover from '$lib/components/ui/popover/index.js';
	import { LIVE_RELATION_LABELS, type LivePerson } from '$lib/contracts/live';
	import { initials } from '$lib/format';

	/**
	 * У кого доступ к делу. Список собирает сервер тем же правилом, по
	 * которому карточка открывается каждому: ответственный, руководители,
	 * коллеги по пространству, которым дело видно, администраторы. Зелёная
	 * точка — человек сейчас в карточке.
	 *
	 * Аватарки стоят встык, без наложения, как в «Сейчас в карточке»: край
	 * соседнего кружка иначе срезает вторую букву инициалов. На телефоне
	 * аватарок нет — строка присутствия и доступа должна уместиться в одну
	 * строку, а список целиком открывается по нажатию.
	 */
	let { people }: { people: readonly LivePerson[] } = $props();

	const PREVIEW = 4;

	const listed = $derived(people.filter((person) => person.relation !== null));
</script>

{#if listed.length > 0}
	<Popover.Root>
		<Popover.Trigger
			class="flex items-center gap-2 rounded-md px-1 py-0.5 text-xs text-muted-foreground focus-ring hover:bg-surface-muted"
			data-slot="card-access"
		>
			<Avatar.Group class="space-x-0 max-sm:hidden">
				{#each listed.slice(0, PREVIEW) as person (person.userId)}
					<Avatar.Root>
						<Avatar.Fallback class="text-xs font-medium">
							{initials(person.name)}
						</Avatar.Fallback>
					</Avatar.Root>
				{/each}
			</Avatar.Group>
			<span>Доступ к делу: <span class="tabular-nums">{listed.length}</span></span>
		</Popover.Trigger>
		<Popover.Content align="end" class="w-80 gap-2">
			<p class="text-sm font-medium">У кого доступ к делу</p>
			<ul class="flex max-h-72 flex-col gap-2 overflow-y-auto">
				{#each listed as person (person.userId)}
					<li class="flex items-center gap-2">
						<Avatar.Root>
							<Avatar.Fallback class="text-xs font-medium">
								{initials(person.name)}
							</Avatar.Fallback>
							{#if person.online > 0}
								<Avatar.Badge class="bg-success" aria-hidden="true" />
							{/if}
						</Avatar.Root>
						<span class="min-w-0 flex-1">
							<span class="block truncate text-sm">
								{person.name}{person.you ? ' (вы)' : ''}
							</span>
							<span class="block text-xs text-muted-foreground">
								{person.relation === null
									? ''
									: LIVE_RELATION_LABELS[person.relation]}{person.online > 0
									? ' · сейчас в карточке'
									: ''}
							</span>
						</span>
					</li>
				{/each}
			</ul>
		</Popover.Content>
	</Popover.Root>
{/if}
