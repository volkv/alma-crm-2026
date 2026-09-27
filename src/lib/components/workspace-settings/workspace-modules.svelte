<script lang="ts">
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import type { WorkspaceModuleState, WorkspaceModulesView } from '$lib/contracts/modules';

	/**
	 * Модули пространств: по каждому пространству — установленные модули с
	 * переключателем. Модуль, который нужен стадии процесса, действует и без
	 * включения, поэтому его переключатель стоит включённым и заблокированным, а
	 * рядом названы стадии: иначе непонятно, почему выключить нельзя. Проверка
	 * всё равно в сервисе — адрес действия набирают и руками.
	 */
	let { modules }: { modules: WorkspaceModulesView[] } = $props();

	/**
	 * Выбор, отправленный на сервер, но ещё не подтверждённый ответом: пока
	 * запрос идёт, переключатель показывает новое положение и заблокирован. По
	 * ответу запись снимается, и переключатель показывает то, что записано, —
	 * при отказе он сам вернётся назад.
	 */
	let pending = $state<Record<string, boolean>>({});

	function pendingKey(workspaceKey: string, moduleKey: string): string {
		return `${workspaceKey}/${moduleKey}`;
	}

	function checkedOf(workspaceKey: string, module: WorkspaceModuleState): boolean {
		return pending[pendingKey(workspaceKey, module.key)] ?? module.active;
	}

	/** «Нужен стадии «А»» или «Нужен стадиям «А», «Б»». */
	function requiredText(stages: readonly string[]): string {
		const names = stages.map((name) => `«${name}»`).join(', ');

		return `${stages.length === 1 ? 'Нужен стадии' : 'Нужен стадиям'} ${names}`;
	}

	/**
	 * Переключатели отправляет одна скрытая форма на весь блок — тем же приёмом,
	 * что назначение процесса на этой странице: переключатель рисуем мы, и своей
	 * формы у него нет.
	 */
	let moduleForm = $state<HTMLFormElement | null>(null);
	let formWorkspaceKey = $state('');
	let formModuleKey = $state('');
	let formEnabled = $state(false);

	async function toggle(workspaceKey: string, moduleKey: string, enabled: boolean) {
		pending[pendingKey(workspaceKey, moduleKey)] = enabled;
		formWorkspaceKey = workspaceKey;
		formModuleKey = moduleKey;
		formEnabled = enabled;

		// Отправка ждёт `tick()`, иначе запрос уйдёт с прежними значениями скрытых
		// полей.
		await tick();
		moduleForm?.requestSubmit();
	}

	const submitModule: SubmitFunction = ({ formData }) => {
		const key = pendingKey(String(formData.get('workspaceKey')), String(formData.get('moduleKey')));

		return async ({ update }) => {
			await update({ reset: false });
			delete pending[key];
		};
	};
</script>

{#if modules.length === 0}
	<p class="text-sm text-muted-foreground">Пространств пока нет — модули подключать некуда.</p>
{:else}
	<div class="flex flex-col gap-6">
		{#each modules as workspace (workspace.workspaceId)}
			<section class="flex flex-col gap-3" aria-labelledby="modules-{workspace.workspaceKey}">
				<h3 id="modules-{workspace.workspaceKey}" class="section-title">
					{workspace.workspaceName}
				</h3>

				{#if workspace.modules.length === 0}
					<p class="text-sm text-muted-foreground">В этой установке модулей нет.</p>
				{:else}
					<ul class="flex flex-col divide-y divide-border rounded-lg border border-border">
						{#each workspace.modules as module (module.key)}
							{@const id = `module-${workspace.workspaceKey}-${module.key}`}
							{@const required = module.requiredBy.length > 0}
							{@const busy = pendingKey(workspace.workspaceKey, module.key) in pending}
							<li class="flex items-start gap-3 px-3 py-2.5">
								<Switch
									{id}
									class="mt-0.5"
									checked={checkedOf(workspace.workspaceKey, module)}
									disabled={required || busy}
									aria-describedby="{id}-about"
									onCheckedChange={(next) => toggle(workspace.workspaceKey, module.key, next)}
								/>
								<div class="flex min-w-0 flex-col gap-0.5">
									<span class="flex flex-wrap items-center gap-2">
										<Label for={id} class="font-medium">{module.label}</Label>
										{#if required}
											<StatusBadge tone="info" wrap>{requiredText(module.requiredBy)}</StatusBadge>
										{/if}
									</span>
									<span id="{id}-about" class="flex flex-col gap-0.5">
										<span class="text-sm text-muted-foreground">{module.description}</span>
										{#if module.contributions.length > 0}
											<span class="text-xs text-muted-foreground">
												Даёт: {module.contributions.join(', ')}.
											</span>
										{/if}
										{#if required}
											<span class="text-xs text-muted-foreground">
												Выключить нельзя, пока стадии процесса его требуют.
											</span>
										{/if}
									</span>
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/each}
	</div>
{/if}

<!-- Переключатель в строке только называет значение; отправляет эта форма —
	действие одно на все пространства. -->
<form
	method="POST"
	action="?/module"
	bind:this={moduleForm}
	use:enhance={submitModule}
	class="hidden"
>
	<input type="hidden" name="workspaceKey" value={formWorkspaceKey} />
	<input type="hidden" name="moduleKey" value={formModuleKey} />
	<input type="hidden" name="enabled" value={formEnabled ? 'true' : 'false'} />
</form>
