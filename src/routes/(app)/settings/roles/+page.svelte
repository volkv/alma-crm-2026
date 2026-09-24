<script lang="ts">
	import { resolve } from '$app/paths';
	import CheckIcon from '@lucide/svelte/icons/check';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Роли и права — Альма CRM</title>
</svelte:head>

<Card.Root>
	<Card.Header>
		<Card.Title>Роли и права</Card.Title>
		<Card.Description>
			Право отвечает на вопрос «можно ли вообще это действие». Таблица читает его напрямую из базы,
			ровно так же, как сервер проверяет его на каждом запросе, — здесь не описание задуманного, а
			то, что действует сейчас.
		</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-4">
		<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`). -->
		<div data-tour="roles-explainer" class="flex flex-col gap-2">
			<InlineHint tone="info">
				Роль назначается не здесь, а в каталоге учётных записей — Keycloak, realm <code>lct</code>:
				администратор realm выдаёт пользователю роль <code>crm-admin</code>,
				<code>crm-lead</code>
				или <code>crm-user</code> в карточке пользователя, на вкладке «Назначение ролей». Систему эту
				роль читает из токена при каждом входе, поэтому новая роль действует со следующего входа, а не
				сразу.
			</InlineHint>
			<InlineHint>
				Таблица ниже отвечает только на вопрос «можно ли вообще». Какие именно записи видно — решает
				не роль, а назначения ответственных за вуз и то, кто кому подчиняется: подробнее в статье
				<Button
					variant="link"
					class="h-auto p-0 align-baseline"
					href={resolve('/(app)/help/[section]/[page]', { section: 'admin', page: 'roles' })}
				>
					«Роли и права»
				</Button>.
			</InlineHint>
		</div>

		<div
			data-tour="roles-matrix"
			class="overflow-x-auto rounded-lg border border-border bg-surface shadow-xs"
		>
			<Table.Root>
				<Table.Header>
					<Table.Row class="hover:bg-transparent">
						<Table.Head>Право</Table.Head>
						{#each data.roles as role (role.id)}
							<Table.Head class="text-center align-bottom whitespace-normal">
								<span class="block font-medium text-foreground">{role.name}</span>
								{#if role.isService}
									<StatusBadge
										tone="neutral"
										class="mt-1"
										title="Машинный субъект: от его имени работают ключи обмена CMS и LMS"
									>
										Не входит в систему
									</StatusBadge>
								{:else}
									<span class="block text-xs font-normal text-faint">{role.description}</span>
								{/if}
							</Table.Head>
						{/each}
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.groups as group (group.key)}
						<Table.Row class="hover:bg-transparent">
							<Table.Cell
								colspan={data.roles.length + 1}
								class="bg-surface-muted font-medium text-foreground"
							>
								{group.label}
							</Table.Cell>
						</Table.Row>
						{#each group.permissions as permission (permission.key)}
							<Table.Row>
								<Table.Cell class="whitespace-normal">{permission.label}</Table.Cell>
								{#each data.roles as role (role.id)}
									{@const granted = role.permissions.includes(permission.key)}
									<Table.Cell class="text-center">
										<span class="sr-only">{granted ? 'Есть' : 'Нет'}</span>
										{#if granted}
											<CheckIcon class="mx-auto size-4 text-success" aria-hidden="true" />
										{:else}
											<span aria-hidden="true" class="text-faint">—</span>
										{/if}
									</Table.Cell>
								{/each}
							</Table.Row>
						{/each}
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	</Card.Content>
</Card.Root>
