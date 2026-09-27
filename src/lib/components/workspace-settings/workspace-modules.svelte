<script lang="ts">
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import type { WorkspaceModuleState } from '$lib/contracts/modules';

	/**
	 * Модули одного пространства: установленные модули с переключателем.
	 * Модуль, который нужен стадии процесса, действует и без включения, поэтому
	 * его переключатель стоит включённым и заблокированным, а рядом названы
	 * стадии: иначе непонятно, почему выключить нельзя. Проверка всё равно в
	 * сервисе — адрес действия набирают и руками.
	 *
	 * Панель модуля видна в карточке, только если её выбрал ещё и процесс
	 * пространства. Поэтому у действующего модуля названы панели, которых процесс
	 * не выбрал, и ссылка на состав карточки процесса: без неё администратор
	 * включит модуль и будет искать панель, которой в карточке нет.
	 *
	 * Какому пространству принадлежат модули, форма не сообщает: действие
	 * `?/module` стоит на странице пространства и берёт его ключ из адреса.
	 */
	let {
		modules,
		workflow
	}: {
		modules: WorkspaceModuleState[];
		/** Процесс пространства; `null` — не назначен, и карточек пока нет. */
		workflow: { key: string; name: string } | null;
	} = $props();

	/**
	 * Выбор, отправленный на сервер, но ещё не подтверждённый ответом: пока
	 * запрос идёт, переключатель показывает новое положение и заблокирован. По
	 * ответу запись снимается, и переключатель показывает то, что записано, —
	 * при отказе он сам вернётся назад.
	 */
	let pending = $state<Record<string, boolean>>({});

	function checkedOf(module: WorkspaceModuleState): boolean {
		return pending[module.key] ?? module.active;
	}

	/** «Нужен стадии «А»» или «Нужен стадиям «А», «Б»». */
	function requiredText(stages: readonly string[]): string {
		const names = stages.map((name) => `«${name}»`).join(', ');

		return `${stages.length === 1 ? 'Нужен стадии' : 'Нужен стадиям'} ${names}`;
	}

	/** «Панель «А» не выбрана … — её не будет» или «Панели «А», «Б» не выбраны … — их не будет». */
	function unchosenText(panels: readonly string[], workflowName: string): string {
		const names = panels.map((name) => `«${name}»`).join(', ');

		return panels.length === 1
			? `Панель ${names} не выбрана в составе карточки процесса «${workflowName}» — в карточках её не будет.`
			: `Панели ${names} не выбраны в составе карточки процесса «${workflowName}» — в карточках их не будет.`;
	}

	/**
	 * Переключатели отправляет одна скрытая форма на весь блок: переключатель
	 * рисуем мы, и своей формы у него нет.
	 */
	let moduleForm = $state<HTMLFormElement | null>(null);
	let formModuleKey = $state('');
	let formEnabled = $state(false);

	async function toggle(moduleKey: string, enabled: boolean) {
		pending[moduleKey] = enabled;
		formModuleKey = moduleKey;
		formEnabled = enabled;

		// Отправка ждёт `tick()`, иначе запрос уйдёт с прежними значениями скрытых
		// полей.
		await tick();
		moduleForm?.requestSubmit();
	}

	const submitModule: SubmitFunction = ({ formData }) => {
		const key = String(formData.get('moduleKey'));

		return async ({ update }) => {
			await update({ reset: false });
			delete pending[key];
		};
	};
</script>

{#if modules.length === 0}
	<p class="text-sm text-muted-foreground">В этой установке модулей нет.</p>
{:else}
	<ul class="flex flex-col divide-y divide-border rounded-lg border border-border">
		{#each modules as module (module.key)}
			{@const id = `module-${module.key}`}
			{@const required = module.requiredBy.length > 0}
			{@const busy = module.key in pending}
			<li class="flex items-start gap-3 px-3 py-2.5">
				<Switch
					{id}
					class="mt-0.5"
					checked={checkedOf(module)}
					disabled={required || busy}
					aria-describedby="{id}-about"
					onCheckedChange={(next) => toggle(module.key, next)}
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
						{#if module.active && workflow !== null && module.unchosenPanels.length > 0}
							<span class="text-xs text-warning-soft-foreground">
								{unchosenText(module.unchosenPanels, workflow.name)}
								<a
									class="font-medium underline underline-offset-2"
									href="{resolve('/(app)/settings/workflows/[key]', { key: workflow.key })}#card"
								>
									Настроить состав карточки
								</a>
							</span>
						{/if}
					</span>
				</div>
			</li>
		{/each}
	</ul>
{/if}

<!-- Переключатель в строке только называет значение; отправляет эта форма —
	действие одно на все модули пространства. -->
<form
	method="POST"
	action="?/module"
	bind:this={moduleForm}
	use:enhance={submitModule}
	class="hidden"
>
	<input type="hidden" name="moduleKey" value={formModuleKey} />
	<input type="hidden" name="enabled" value={formEnabled ? 'true' : 'false'} />
</form>
