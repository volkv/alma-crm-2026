<script lang="ts">
	import { resolve } from '$app/paths';
	import BellIcon from '@lucide/svelte/icons/bell';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Popover from '$lib/components/ui/popover/index.js';
	import { formatDateTime, pluralize } from '$lib/format';
	import type { InboxItem } from '$lib/contracts/inbox';
	import { inbox } from './inbox.svelte';

	/**
	 * Колокольчик: где меня упомянули и какие новые дела с сайта мне назначены.
	 *
	 * Число — непрочитанные строки обоих видов в делах, которые человек видит
	 * сейчас. Строка ведёт в карточку (упоминание — к самому комментарию) и
	 * сразу отмечается прочитанной; открытая карточка отмечает прочитанными все
	 * свои строки. Текста комментария здесь нет: что сказали — видно в ленте
	 * карточки, рядом с тем, о чём говорили.
	 */
	let { class: className = '' }: { class?: string } = $props();

	let open = $state(false);

	const unread = $derived(inbox.unread);

	const label = $derived(
		unread === 0
			? 'Уведомления: новых нет'
			: `Уведомления: ${pluralize(unread, ['новое', 'новых', 'новых'])}`
	);

	/** Упоминание ведёт сразу к своему комментарию, новое дело — в карточку. */
	function anchor(item: InboxItem): string {
		return item.kind === 'mention' ? `#comment-${item.commentId}` : '';
	}
</script>

<Popover.Root
	bind:open
	onOpenChange={(next) => {
		if (next) {
			inbox.opened();
		}
	}}
>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="ghost"
				size="icon-sm"
				class="relative text-muted-foreground {className}"
				aria-label={label}
				data-slot="inbox-bell"
				data-tour="inbox"
			>
				<BellIcon aria-hidden="true" />
				{#if unread > 0}
					<span
						class="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-link px-1 text-[10px] leading-none font-semibold text-link-foreground tabular-nums"
						aria-hidden="true"
					>
						{unread > 99 ? '99+' : unread}
					</span>
				{/if}
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content align="end" class="w-80 gap-2 p-0">
		<div class="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
			<p class="text-sm font-medium">Уведомления</p>
			{#if unread > 0}
				<Button variant="ghost" size="sm" onclick={() => void inbox.markAllRead()}>
					Прочитать все
				</Button>
			{/if}
		</div>
		{#if inbox.failure !== null}
			<p class="px-3 pb-2 text-sm text-danger" role="alert">{inbox.failure}</p>
		{/if}
		{#if inbox.current === null}
			<p class="px-3 pb-3 text-sm text-muted-foreground">Загружаем…</p>
		{:else if inbox.current.items.length === 0}
			<p class="px-3 pb-3 text-sm text-muted-foreground">
				Новых нет. Здесь появятся упоминания — коллеги зовут в обсуждение через «@» в комментарии к
				делу — и новые дела с сайта, назначенные вам.
			</p>
		{:else}
			<ul class="flex max-h-96 flex-col overflow-y-auto pb-1">
				{#each inbox.current.items as item (item.kind + item.id)}
					<li>
						<a
							href="{resolve('/(app)/w/[workspace]/interactions/[id=uuid]', {
								workspace: item.workspaceKey,
								id: item.interactionId
							})}{anchor(item)}"
							class="flex gap-2 px-3 py-2 text-sm focus-ring hover:bg-surface-muted"
							onclick={() => {
								open = false;

								if (item.readAt === null) {
									void inbox.markRead(item);
								}
							}}
						>
							<span
								class="mt-1.5 size-2 shrink-0 rounded-full {item.readAt === null
									? 'bg-link'
									: 'bg-transparent'}"
								aria-hidden="true"
							></span>
							<span class="min-w-0 flex-1">
								<span class="block">
									{#if item.kind === 'mention'}
										<span class="font-medium">{item.authorName}</span> упомянул(а) вас
									{:else}
										<span class="font-medium">Новое дело с сайта</span> назначено вам
									{/if}
								</span>
								{#if item.kind === 'mention' && item.excerpt !== ''}
									<span class="line-clamp-2 block text-foreground/80">«{item.excerpt}»</span>
								{/if}
								<span class="block truncate text-muted-foreground">{item.interactionTitle}</span>
								<span class="block text-xs text-faint">
									{formatDateTime(item.createdAt)}{item.readAt === null ? ' · новое' : ''}
								</span>
							</span>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</Popover.Content>
</Popover.Root>
