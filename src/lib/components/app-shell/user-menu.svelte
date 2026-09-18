<script lang="ts">
	import LifeBuoyIcon from '@lucide/svelte/icons/life-buoy';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
	import * as Avatar from '$lib/components/ui/avatar/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { initials } from '$lib/format';
	import { getOnboardingTour } from '$lib/onboarding/tour.svelte';
	import type { SessionUser } from '$lib/server/auth/types';

	/**
	 * Who is signed in, and the way out. Signing out is a POST, not a link: it
	 * changes state, so it must not be reachable by a prefetch or a crawler.
	 */
	let { user }: { user: SessionUser } = $props();

	/**
	 * Подсказки первого входа показываются один раз; вернуть их человек ищет там
	 * же, где свою учётную запись. Роли без тура пункта не видят: меню не должно
	 * предлагать действие, которое ничего не делает.
	 */
	const tour = getOnboardingTour();
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="ghost" class="h-control gap-2 px-1.5">
				<Avatar.Root size="sm">
					<Avatar.Fallback class="bg-primary-soft text-xs font-medium text-primary">
						{initials(user.fullName)}
					</Avatar.Fallback>
				</Avatar.Root>
				<span class="hidden max-w-32 truncate sm:inline">{user.fullName}</span>
				<ChevronsUpDownIcon class="hidden text-muted-foreground sm:block" aria-hidden="true" />
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end" class="w-56">
		<div class="px-2 py-1.5">
			<p class="truncate text-sm font-medium">{user.fullName}</p>
			<p class="truncate text-xs text-muted-foreground">{user.email}</p>
			<p class="mt-1 text-xs text-faint">Роль: {user.roleId}</p>
		</div>
		{#if tour.steps.length > 0}
			<DropdownMenu.Item onSelect={() => tour.restart()}>
				<LifeBuoyIcon aria-hidden="true" />
				Показать подсказки снова
			</DropdownMenu.Item>
		{/if}
		<DropdownMenu.Separator />
		<form method="POST" action="/logout">
			<DropdownMenu.Item class="w-full">
				{#snippet child({ props })}
					<button {...props} type="submit">
						<LogOutIcon aria-hidden="true" />
						Выйти
					</button>
				{/snippet}
			</DropdownMenu.Item>
		</form>
	</DropdownMenu.Content>
</DropdownMenu.Root>
