<script lang="ts">
	import { resolve } from '$app/paths';
	import EmptyState from '$lib/components/empty-state.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { formatNumber } from '$lib/format';
	import type {
		ProcessPreview,
		ProcessPreviewMove,
		StageChangeKind
	} from '$lib/contracts/interactions';

	/**
	 * Последствия применения черновика: сколько записей переедет, сколько
	 * увидит изменение своей стадии на месте и что стало с каждой изменённой
	 * стадией. Одна разметка и во вкладке «Изменения», и в диалоге применения:
	 * решение принимают по тем же числам, которые видели, пока правили.
	 */
	let { preview }: { preview: ProcessPreview } = $props();

	/** Что стало со стадией в черновике — словами предпросмотра. */
	const CHANGE_LABELS: Record<StageChangeKind, string> = {
		kept: 'Без изменений',
		renamed: 'Переименована',
		changed: 'Параметры изменены',
		added: 'Новая',
		removed: 'Удалена'
	};

	/** Строки, на которых что-то меняется; «без изменений» не показываем. */
	const rows = $derived(preview.rows.filter((row) => row.change !== 'kept'));

	/**
	 * Сколько незавершённых взаимодействий увидят изменение своей стадии, никуда
	 * не переезжая: переименование и правка параметров. Переезжающие сюда не
	 * идут — их считает `preview.affected`.
	 */
	/**
	 * Переезжающие дела по пространствам: процесс бывает назначен нескольким,
	 * и администратор должен видеть, чью работу двигает. Сервер уже отдаёт их
	 * по порядку пространств в меню.
	 */
	const movesByWorkspace = $derived.by(() => {
		const groups: { key: string; name: string; moves: ProcessPreviewMove[] }[] = [];

		for (const move of preview.moves) {
			const group = groups.find((candidate) => candidate.key === move.workspaceKey);

			if (group === undefined) {
				groups.push({ key: move.workspaceKey, name: move.workspaceName, moves: [move] });
			} else {
				group.moves.push(move);
			}
		}

		return groups;
	});

	const affectedInPlace = $derived(
		rows
			.filter((row) => row.change === 'renamed' || row.change === 'changed')
			.reduce((total, row) => total + row.interactions, 0)
	);
</script>

<div class="flex flex-col gap-4">
	<!-- Два числа, а не одно: «затронуто» на сервере считает только тех, кто
		переезжает на другую стадию, а переименование и правка параметров видны
		всем, кто стоит на изменённой стадии. Одно число рядом с «На ней стоит: 3»
		читалось как ошибка. -->
	<div class="flex flex-col gap-0.5 text-sm">
		<p>
			Переедут на другую стадию: <strong>{formatNumber(preview.affected)}</strong>
		</p>
		<p class="text-muted-foreground">
			Увидят изменение своей стадии, оставаясь на ней:
			<strong class="text-foreground">{formatNumber(affectedInPlace)}</strong>
		</p>
	</div>

	{#if movesByWorkspace.length > 0}
		<section class="flex flex-col gap-2" aria-labelledby="preview-moves">
			<h3 id="preview-moves" class="text-sm font-medium">Какие дела переедут</h3>
			{#each movesByWorkspace as group (group.key)}
				<div class="flex flex-col gap-1">
					<p class="section-overline">
						{group.name} — {formatNumber(group.moves.length)}
					</p>
					<ul class="flex flex-col divide-y divide-border rounded-md border border-border">
						{#each group.moves as move (move.interactionId)}
							<li class="flex flex-col gap-0.5 px-3 py-2 text-sm">
								<a
									class="rounded-sm font-medium text-link underline-offset-4 focus-ring hover:text-link-hover hover:underline"
									href={resolve('/(app)/w/[workspace]/interactions/[id=uuid]', {
										workspace: move.workspaceKey,
										id: move.interactionId
									})}
								>
									{move.title}
								</a>
								<span class="text-xs text-muted-foreground">
									{move.ownerName ?? 'без ответственного'} · «{move.fromStageName}» →
									{#if move.toStageName === null}
										<span class="text-danger">куда — не указано</span>
									{:else}
										«{move.toStageName}»
									{/if}
								</span>
							</li>
						{/each}
					</ul>
				</div>
			{/each}
		</section>
	{/if}

	{#if rows.length === 0}
		<EmptyState
			title="Структура не изменилась"
			description="В черновике нет отличий от действующего процесса."
		/>
	{:else}
		<!-- Карточки, а не таблица: строка диффа с перечнем изменённых параметров
			растягивала таблицу до 1137 px внутри диалога шириной 624, и колонки
			«На ней стоит» и «Куда переедут» — те самые числа, ради которых
			предпросмотр и открывают, — уезжали за край. -->
		<ul class="flex flex-col gap-2">
			{#each rows as row (row.stageKey)}
				<li class="flex flex-col gap-1.5 rounded-md border border-border p-3">
					<div class="flex flex-wrap items-center justify-between gap-2">
						<span class="font-medium">{row.stageName}</span>
						<StatusBadge tone={row.change === 'removed' ? 'warning' : 'info'}>
							{CHANGE_LABELS[row.change]}
						</StatusBadge>
					</div>

					{#if row.changes.length > 0}
						<ul class="list-inside list-disc text-xs text-muted-foreground">
							{#each row.changes as change (change)}
								<li>{change}</li>
							{/each}
						</ul>
					{/if}

					<div class="flex flex-wrap gap-x-6 gap-y-1 text-xs">
						<span class="text-muted-foreground">
							На ней стоит:
							{#if row.interactions === 0}
								<span class="text-faint">никого нет</span>
							{:else}
								<strong class="text-foreground">{formatNumber(row.interactions)}</strong>
							{/if}
						</span>
						{#if row.change === 'removed'}
							<span class="text-muted-foreground">
								Куда переедут:
								<strong class="text-foreground">
									{row.targetStageName ?? 'предыдущая сохранившаяся стадия'}
								</strong>
							</span>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>
