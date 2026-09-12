<script lang="ts">
	import { enhance } from '$app/forms';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Avatar, AvatarFallback } from '$lib/components/ui/avatar/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import type { CommentView } from '$lib/contracts/interactions';
	import { formatDateTime, initials } from '$lib/format';
	import { actionEnhance } from './action-enhance';

	/** Переписка по взаимодействию: то, что не ложится ни в поле, ни в чек-лист. */
	let { comments, canWrite }: { comments: readonly CommentView[]; canWrite: boolean } = $props();

	let body = $state('');
</script>

<Card.Root size="sm">
	<Card.Header>
		<Card.Title>Комментарии</Card.Title>
	</Card.Header>
	<Card.Content class="flex flex-col gap-4">
		{#if canWrite}
			<form
				method="POST"
				action="?/comment"
				use:enhance={actionEnhance({ onsuccess: () => (body = '') })}
				class="flex flex-col gap-2"
			>
				<Textarea
					name="body"
					rows={2}
					required
					bind:value={body}
					placeholder="Что важно знать коллегам"
					aria-label="Текст комментария"
				/>
				<div class="flex justify-end">
					<Button type="submit" size="sm" disabled={body.trim() === ''}>Добавить</Button>
				</div>
			</form>
		{/if}

		{#if comments.length === 0}
			<p class="text-sm text-muted-foreground">Комментариев пока нет.</p>
		{/if}

		{#each comments as comment (comment.id)}
			<div class="flex gap-3 border-b border-border pb-3 last:border-0 last:pb-0">
				<Avatar class="size-8 shrink-0">
					<AvatarFallback>{initials(comment.authorName)}</AvatarFallback>
				</Avatar>
				<div class="min-w-0 flex-1">
					<p class="text-xs text-muted-foreground">
						{comment.authorName} · {formatDateTime(comment.createdAt)}
					</p>
					<p class="text-sm break-words whitespace-pre-line">{comment.body}</p>
				</div>
			</div>
		{/each}
	</Card.Content>
</Card.Root>
