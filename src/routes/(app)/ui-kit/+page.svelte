<script lang="ts">
	import { untrack } from 'svelte';
	import { renderSnippet, type ColumnDef } from '@tanstack/svelte-table';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { toast } from 'svelte-sonner';
	import { resolve } from '$app/paths';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import InfoIcon from '@lucide/svelte/icons/info';

	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Progress } from '$lib/components/ui/progress/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';

	import ConfirmDialog from '$lib/components/confirm-dialog.svelte';
	import FormDialog from '$lib/components/form-dialog.svelte';
	import EmptyState from '$lib/components/empty-state.svelte';
	import ErrorState from '$lib/components/error-state.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import KeyValue from '$lib/components/key-value.svelte';
	import KeyValueRow from '$lib/components/key-value-row.svelte';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import SlaChip from '$lib/components/sla-chip.svelte';
	import StageTimeline, {
		type Stage,
		type StageState
	} from '$lib/components/stage-timeline.svelte';
	import StatusBadge, { type StatusTone } from '$lib/components/status-badge.svelte';
	import ThemeToggle from '$lib/components/app-shell/theme-toggle.svelte';
	import DataTable from '$lib/components/data-table/data-table.svelte';
	import type { DataTableFeatures } from '$lib/components/data-table/features';
	import DateField from '$lib/components/form/date-field.svelte';
	import FieldDate from '$lib/components/form/field-date.svelte';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import FieldSelect from '$lib/components/form/field-select.svelte';
	import FieldTextarea from '$lib/components/form/field-textarea.svelte';
	import FileInput from '$lib/components/form/file-input.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import { formatDate, formatNumber } from '$lib/format';

	import { showcaseOrganizationSchema } from './schema';
	import {
		ORGANIZATION_KINDS,
		REGIONS,
		SHOWCASE_NOW,
		SHOWCASE_ROUTE,
		type OrganizationKind,
		type ShowcaseOrganization
	} from './showcase-data';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const {
		form,
		errors,
		enhance,
		submitting,
		message: formMessage
		// superforms takes the initial form once and then follows page updates on
		// its own, so this read is deliberately not a dependency.
	} = superForm(
		untrack(() => data.form),
		{
			validators: zod4Client(showcaseOrganizationSchema),
			// superforms hooks this into `beforeNavigate`, so leaving the page with
			// unsaved input asks first — including a reload or a closed tab.
			taintedMessage: 'Введённые данные не сохранены. Уйти со страницы?',
			onUpdated: ({ form: updated }) => {
				if (updated.message) toast.success(updated.message);
			}
		}
	);

	let kitDate = $state('2026-09-12');

	const kindTone: Record<OrganizationKind, StatusTone> = {
		university: 'accent',
		college: 'info',
		partner: 'neutral'
	};

	const columns: ColumnDef<DataTableFeatures, ShowcaseOrganization>[] = [
		{
			accessorKey: 'name',
			header: 'Название',
			meta: { title: 'Название' },
			enableHiding: false,
			cell: ({ row }) => renderSnippet(nameCell, { name: row.original.name })
		},
		{ accessorKey: 'shortName', header: 'Краткое', meta: { title: 'Краткое' } },
		{ accessorKey: 'region', header: 'Регион', meta: { title: 'Регион' } },
		{
			accessorKey: 'kind',
			header: 'Тип',
			meta: { title: 'Тип' },
			cell: ({ row }) => renderSnippet(kindCell, { kind: row.original.kind })
		},
		{
			accessorKey: 'contacts',
			header: 'Контакты',
			meta: { title: 'Контакты', align: 'end' },
			cell: ({ row }) => formatNumber(row.original.contacts)
		},
		{
			accessorKey: 'updatedAt',
			header: 'Обновлено',
			meta: { title: 'Обновлено', align: 'end' },
			cell: ({ row }) => formatDate(row.original.updatedAt)
		},
		{
			id: 'route',
			header: 'Маршрут',
			meta: { title: 'Маршрут' },
			enableSorting: false,
			cell: ({ row }) => renderSnippet(routeCell, { route: row.original.route })
		}
	];

	const tones: StatusTone[] = ['neutral', 'accent', 'success', 'warning', 'danger', 'info'];
	const toneLabels: Record<StatusTone, string> = {
		neutral: 'Черновик',
		accent: 'В работе',
		success: 'Завершено',
		warning: 'Требует внимания',
		danger: 'Просрочено',
		info: 'На согласовании'
	};

	const stageStates: StageState[] = [
		'pending',
		'done',
		'current',
		'paused',
		'overdue',
		'blocked',
		'skipped'
	];
	const stateDemo: Stage[] = stageStates.map((state, index) => ({
		id: state,
		label: `Этап ${index + 1}`,
		state
	}));

	/**
	 * Цвет продукта — это цвет «Дизайн-системы Ростелекома»: у каждого нашего
	 * токена рядом стоит токен ДС, из которого он взят, — свой на светлую тему и
	 * свой на тёмную. Образец перекрашивается вместе с темой: он и есть проверка
	 * того, что у токена есть значение в обеих. Расшифровка целиком —
	 * docs/design.md.
	 */
	const swatches = [
		{ token: 'bg-canvas', label: 'canvas — фон приложения', light: 'bg-surface2', dark: 'bg-page' },
		{
			token: 'bg-surface',
			label: 'surface — панели и карточки',
			light: 'bg-page',
			dark: 'bg-surface1'
		},
		{
			token: 'bg-surface-muted',
			label: 'surface-muted — шапка таблицы',
			light: 'bg-surface3',
			dark: 'bg-surface3'
		},
		{ token: 'bg-primary', label: 'primary — акцент', light: 'accent-700', dark: 'accent-200' },
		{
			token: 'bg-primary-soft',
			label: 'primary-soft — мягкий акцент',
			light: 'accent-50',
			dark: 'accent-950'
		},
		{ token: 'bg-success', label: 'success', light: 'success-700', dark: 'success-200' },
		{ token: 'bg-warning', label: 'warning', light: 'warning-500', dark: 'warning-200' },
		{ token: 'bg-danger', label: 'danger', light: 'error-700', dark: 'error-200' },
		{ token: 'bg-info', label: 'info', light: 'info-500', dark: 'info-200' }
	];

	/** Шкала кеглей: имя утилиты, вариант ДС и то, где он в продукте встречается. */
	const typeScale = [
		{ size: 'text-2xl', source: 'heading-h1 — 28/32', usage: 'числа сводок' },
		{ size: 'text-xl', source: 'heading-h2 — 22/24', usage: 'заголовок страницы' },
		{ size: 'text-lg', source: 'body-l — 18/26', usage: 'заголовок диалога' },
		{ size: 'text-base', source: 'body-m — 16/24', usage: 'заголовок карточки' },
		{ size: 'text-sm', source: 'body-s — 14/20', usage: 'основной текст' },
		{ size: 'text-xs', source: 'description-l — 12/16', usage: 'подписи и сноски' }
	];

	let deleteOpen = $state(false);
	/** Витрина диалога с формой: длинное тело, прибитая панель, вопрос при вводе. */
	let formDialogOpen = $state(false);
	let dialogNote = $state('');
	let dialogStage = $state('Согласование условий');
	let switchOn = $state(true);
	let checkboxOn = $state(true);
	let selectedStage = $state<Stage | null>(null);

	function removeSelection(ids: string[]) {
		toast.success(`Снято с публикации: ${formatNumber(ids.length)}`);
	}
</script>

<svelte:head>
	<title>UI-кит — LCT CRM</title>
</svelte:head>

{#snippet nameCell({ name }: { name: string })}
	<span class="block max-w-72 truncate" title={name}>{name}</span>
{/snippet}

{#snippet kindCell({ kind }: { kind: OrganizationKind })}
	<StatusBadge tone={kindTone[kind]}>{ORGANIZATION_KINDS[kind]}</StatusBadge>
{/snippet}

{#snippet routeCell({ route }: { route: Stage[] })}
	<div class="w-32"><StageTimeline stages={route} compact now={SHOWCASE_NOW} /></div>
{/snippet}

<Header
	title="UI-кит"
	description="Все элементы интерфейса в одном месте: как они выглядят, как называются и в каких состояниях бывают."
>
	{#snippet actions()}
		<Button
			variant="outline"
			onclick={() => toast('Пример уведомления', { description: 'Так выглядит тост.' })}
		>
			Показать тост
		</Button>
		<Button>
			<PlusIcon aria-hidden="true" />
			Действие
		</Button>
	{/snippet}
</Header>

<Breadcrumbs items={[{ label: 'Главная', href: resolve('/') }, { label: 'UI-кит' }]} />

<div class="flex flex-col gap-8 p-4 sm:p-6">
	<section class="flex flex-col gap-3">
		<h2 class="text-sm font-semibold tracking-tight">Токены</h2>
		<InlineHint>
			Тема продукта собрана на токенах «Дизайн-системы Ростелекома»: имена наших токенов свои,
			значения — её. Тем две, светлая и тёмная; значения в них разные, имена одни и те же —
			переключите тему и посмотрите на эту же страницу. Полная таблица соответствия — в <code
				class="font-mono">docs/design.md</code
			>.
		</InlineHint>
		<div class="flex flex-wrap items-center gap-2">
			<span class="text-xs text-muted-foreground">Тема страницы:</span>
			<ThemeToggle />
		</div>
		<div class="grid gap-4 md:grid-cols-2">
			<Card.Root size="sm">
				<Card.Header>
					<Card.Title>Цвет</Card.Title>
					<Card.Description>
						Слева наш токен, справа — токен ДС под ним: светлая тема / тёмная.
					</Card.Description>
				</Card.Header>
				<Card.Content>
					<ul class="flex flex-col gap-2">
						{#each swatches as swatch (swatch.token)}
							<li class="flex items-center gap-2.5">
								<span class="size-5 shrink-0 rounded border border-border {swatch.token}"></span>
								<span class="min-w-0 flex-1 truncate text-xs text-muted-foreground"
									>{swatch.label}</span
								>
								<code class="shrink-0 font-mono text-xs text-faint"
									>{swatch.light} / {swatch.dark}</code
								>
							</li>
						{/each}
					</ul>
				</Card.Content>
			</Card.Root>

			<Card.Root size="sm">
				<Card.Header>
					<Card.Title>Типографика</Card.Title>
					<Card.Description>
						Гарнитура Rostelecom Basis, запасная — Inter Variable. Bold — заголовки, Medium —
						акцент, Regular — текст.
					</Card.Description>
				</Card.Header>
				<Card.Content>
					<ul class="flex flex-col gap-2">
						{#each typeScale as step (step.size)}
							<li class="flex items-baseline justify-between gap-3">
								<span class="{step.size} truncate font-semibold tracking-tight">{step.usage}</span>
								<code class="shrink-0 font-mono text-xs text-faint">{step.source}</code>
							</li>
						{/each}
					</ul>
					<p class="text-sm text-muted-foreground">Приглушённый текст</p>
					<p class="text-xs text-faint">Слабый текст</p>
					<p class="text-sm">Цифры моноширинные: 1 234 567 890 · 0.00 · 12.09.2026</p>
				</Card.Content>
			</Card.Root>

			<Card.Root size="sm" class="md:col-span-2">
				<Card.Header>
					<Card.Title>Плотность, радиусы и тени</Card.Title>
					<Card.Description>
						Высоты — размеры ДС (36px строка, 32px контрол), радиусы — её шкала, теней две ступени.
					</Card.Description>
				</Card.Header>
				<Card.Content class="gap-4">
					<div class="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
						<span class="flex h-control items-center rounded-md border border-border px-2"
							>контрол 32px</span
						>
						<span class="flex h-row items-center rounded-md border border-border px-2"
							>строка 36px</span
						>
					</div>
					<div class="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
						<span class="flex h-row items-center rounded-sm border border-border px-2"
							>sm — 4px</span
						>
						<span class="flex h-row items-center rounded-md border border-border px-2"
							>md — 6px</span
						>
						<span class="flex h-row items-center rounded-lg border border-border px-2"
							>lg — 8px</span
						>
						<span class="flex h-row items-center rounded-xl border border-border px-2"
							>xl — 12px</span
						>
						<span class="flex h-row items-center rounded-4xl border border-border px-3">пилюля</span
						>
					</div>
					<div class="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
						<span class="flex h-row items-center rounded-lg bg-surface px-3 shadow-xs"
							>на холсте — shadow-xs</span
						>
						<span class="flex h-row items-center rounded-lg bg-surface px-3 shadow-md"
							>поверх страницы — shadow-md</span
						>
					</div>
				</Card.Content>
			</Card.Root>
		</div>
	</section>

	<section class="flex flex-col gap-3">
		<h2 class="text-sm font-semibold tracking-tight">Кнопки</h2>
		<Card.Root size="sm">
			<Card.Content class="gap-4">
				<div class="flex flex-wrap items-center gap-2">
					<Button>Основная</Button>
					<Button variant="secondary">Вторичная</Button>
					<Button variant="outline">Контурная</Button>
					<Button variant="ghost">Призрачная</Button>
					<Button variant="destructive">Опасная</Button>
					<Button variant="link">Ссылка</Button>
				</div>
				<div class="flex flex-wrap items-center gap-2">
					<Button size="xs">xs</Button>
					<Button size="sm">sm</Button>
					<Button>default — 32px</Button>
					<Button size="lg">lg</Button>
					<Button size="icon" aria-label="Добавить"><PlusIcon aria-hidden="true" /></Button>
					<Button disabled>Отключена</Button>
				</div>
			</Card.Content>
		</Card.Root>
	</section>

	<section class="flex flex-col gap-3">
		<h2 class="text-sm font-semibold tracking-tight">Поля и переключатели</h2>
		<Card.Root size="sm">
			<Card.Content class="gap-4">
				<div class="grid gap-4 sm:grid-cols-2">
					<div class="flex flex-col gap-1.5">
						<Label for="kit-input">Обычное поле</Label>
						<Input id="kit-input" placeholder="Введите значение" />
					</div>
					<div class="flex flex-col gap-1.5">
						<Label for="kit-input-invalid">Поле с ошибкой</Label>
						<Input id="kit-input-invalid" value="не подходит" aria-invalid="true" />
						<p class="text-xs text-danger-soft-foreground">Значение не подходит</p>
					</div>
					<div class="flex flex-col gap-1.5">
						<Label for="kit-disabled">Отключённое поле</Label>
						<Input id="kit-disabled" value="Только чтение" disabled />
					</div>
					<div class="flex flex-col gap-1.5">
						<Label for="kit-textarea">Многострочное поле</Label>
						<Textarea id="kit-textarea" rows={2} placeholder="Комментарий" />
					</div>
					<div class="flex flex-col gap-1.5">
						<Label for="kit-date">Дата</Label>
						<!-- Дата пишется и читается как 12.09.2026 и выбирается тем же
							всплывающим слоем, что и остальные списки продукта: нативный
							`type="date"` рисовал бы её порядком полей локали браузера. -->
						<DateField id="kit-date" bind:value={kitDate} />
					</div>
				</div>
				<div class="flex flex-wrap items-center gap-6">
					<Label class="gap-2">
						<Checkbox bind:checked={checkboxOn} />
						Учитывать в отчёте
					</Label>
					<Label class="gap-2">
						<Switch bind:checked={switchOn} />
						Уведомлять по почте
					</Label>
					<Tooltip.Provider>
						<Tooltip.Root>
							<Tooltip.Trigger>
								{#snippet child({ props })}
									<Button {...props} variant="outline" size="sm">Наведите</Button>
								{/snippet}
							</Tooltip.Trigger>
							<Tooltip.Content>Подсказка по элементу</Tooltip.Content>
						</Tooltip.Root>
					</Tooltip.Provider>
				</div>
			</Card.Content>
		</Card.Root>
	</section>

	<section class="flex flex-col gap-3">
		<h2 class="text-sm font-semibold tracking-tight">Статусы и сроки</h2>
		<Card.Root size="sm">
			<Card.Content class="gap-4">
				<div class="flex flex-wrap items-center gap-2">
					{#each tones as tone (tone)}
						<StatusBadge {tone} dot>{toneLabels[tone]}</StatusBadge>
					{/each}
				</div>
				<div class="flex flex-wrap items-center gap-2">
					<SlaChip deadline="2026-09-30T00:00:00Z" now={SHOWCASE_NOW} />
					<SlaChip deadline="2026-09-14T00:00:00Z" now={SHOWCASE_NOW} />
					<SlaChip deadline="2026-09-12T00:00:00Z" now={SHOWCASE_NOW} />
					<SlaChip deadline="2026-09-07T00:00:00Z" now={SHOWCASE_NOW} />
				</div>
				<div class="flex flex-wrap items-center gap-2">
					<Badge>Базовый</Badge>
					<Badge variant="secondary">Вторичный</Badge>
					<Badge variant="outline">Контурный</Badge>
					<Badge variant="destructive">Опасный</Badge>
				</div>
			</Card.Content>
		</Card.Root>
	</section>

	<section class="flex flex-col gap-3">
		<h2 class="text-sm font-semibold tracking-tight">Обратная связь</h2>
		<div class="grid gap-4 md:grid-cols-2">
			<Card.Root size="sm">
				<Card.Header><Card.Title>Сообщения</Card.Title></Card.Header>
				<Card.Content class="gap-3">
					<Alert.Root>
						<InfoIcon aria-hidden="true" />
						<Alert.Title>Плановая выгрузка</Alert.Title>
						<Alert.Description>Отчёт формируется до конца дня.</Alert.Description>
					</Alert.Root>
					<Alert.Root variant="destructive">
						<Alert.Title>Не удалось отправить документ</Alert.Title>
						<Alert.Description>Проверьте адрес и повторите попытку.</Alert.Description>
					</Alert.Root>
					<InlineHint>Поля со звёздочкой обязательны.</InlineHint>
					<InlineHint tone="warning"
						>Организация не подтвердила контакты — срок под угрозой.</InlineHint
					>
					<div class="flex flex-wrap gap-2">
						<Button
							variant="outline"
							size="sm"
							onclick={() => toast.success('Изменения сохранены')}
						>
							Успех
						</Button>
						<Button variant="outline" size="sm" onclick={() => toast.error('Сервер недоступен')}>
							Ошибка
						</Button>
						<Button variant="outline" size="sm" onclick={() => (deleteOpen = true)}>
							Подтверждение
						</Button>
						<Button
							variant="outline"
							size="sm"
							onclick={() => {
								dialogNote = '';
								formDialogOpen = true;
							}}
						>
							Диалог с формой
						</Button>
					</div>
				</Card.Content>
			</Card.Root>

			<Card.Root size="sm">
				<Card.Header><Card.Title>Пустое, ошибка, загрузка</Card.Title></Card.Header>
				<Card.Content class="gap-3">
					<div class="rounded-md border border-border">
						<EmptyState
							title="Пока ничего нет"
							description="Здесь появятся взаимодействия, как только их заведут."
						>
							{#snippet action()}
								<Button size="sm">
									<PlusIcon aria-hidden="true" />
									Создать
								</Button>
							{/snippet}
						</EmptyState>
					</div>
					<div class="rounded-md border border-border">
						<ErrorState
							description="Сервис отчётов не ответил вовремя."
							requestId="7f3c1a20"
							onretry={() => toast('Повтор запроса')}
						/>
					</div>
					<div class="flex flex-col gap-2">
						<Skeleton class="h-3.5 w-2/3" />
						<Skeleton class="h-3.5 w-1/2" />
						<Progress value={64} class="mt-1" />
					</div>
				</Card.Content>
			</Card.Root>
		</div>
	</section>

	<section class="flex flex-col gap-3">
		<h2 class="text-sm font-semibold tracking-tight">Карточка записи</h2>
		<Card.Root>
			<Card.Header>
				<Card.Title>Санкт-Петербургский политехнический университет Петра Великого</Card.Title>
				<Card.Description>Взаимодействие № 2026-0147 · подготовка DevOps-инженеров</Card.Description
				>
				<Card.Action>
					<StatusBadge tone="accent" dot>В работе</StatusBadge>
				</Card.Action>
			</Card.Header>
			<Card.Content class="gap-5">
				<KeyValue>
					<KeyValueRow label="Регион" value="Москва" />
					<KeyValueRow label="Тип">
						<StatusBadge tone="accent">Вуз</StatusBadge>
					</KeyValueRow>
					<KeyValueRow label="Ответственный" value="Анна Ковалёва" />
					<KeyValueRow label="Контактов" value={formatNumber(12)} />
					<KeyValueRow label="Начало" value={formatDate('2026-04-02T00:00:00Z')} />
					<KeyValueRow label="Комментарий" value={null} />
				</KeyValue>

				<div class="flex flex-col gap-2">
					<div class="flex flex-wrap items-center justify-between gap-2">
						<h3 class="text-xs font-medium text-muted-foreground">Маршрут взаимодействия</h3>
						{#if selectedStage}
							<p class="text-xs text-muted-foreground">Выбран этап: {selectedStage.label}</p>
						{/if}
					</div>
					<StageTimeline
						stages={SHOWCASE_ROUTE}
						now={SHOWCASE_NOW}
						onselect={(stage) => (selectedStage = stage)}
					/>
				</div>
			</Card.Content>
		</Card.Root>

		<Card.Root size="sm">
			<Card.Header><Card.Title>Состояния этапов и компактный режим</Card.Title></Card.Header>
			<Card.Content class="gap-4">
				<StageTimeline stages={stateDemo} now={SHOWCASE_NOW} />
				<Tabs.Root value="compact">
					<Tabs.List>
						<Tabs.Trigger value="compact">Компактный</Tabs.Trigger>
						<Tabs.Trigger value="full">Полный</Tabs.Trigger>
					</Tabs.List>
					<Tabs.Content value="compact" class="pt-3">
						<div class="max-w-60">
							<StageTimeline stages={SHOWCASE_ROUTE} compact now={SHOWCASE_NOW} />
						</div>
					</Tabs.Content>
					<Tabs.Content value="full" class="pt-3">
						<StageTimeline stages={SHOWCASE_ROUTE} now={SHOWCASE_NOW} />
					</Tabs.Content>
				</Tabs.Root>
			</Card.Content>
		</Card.Root>
	</section>

	<section class="flex flex-col gap-3">
		<h2 class="text-sm font-semibold tracking-tight">Таблица</h2>
		<InlineHint>
			Сортировка, страница, размер страницы и поиск живут в адресе страницы — ссылку на список можно
			отправить коллеге. Клавиши: ↑/↓ или j/k — по строкам, Enter — открыть, / — поиск.
		</InlineHint>
		<DataTable
			{columns}
			rows={data.rows}
			total={data.total}
			getRowId={(organization) => organization.id}
			searchPlaceholder="Поиск по названию или региону"
			emptyTitle="Организации не найдены"
			emptyDescription="Под этот запрос и отбор не попало ни одной записи."
			emptyAction={resetShowcaseFilters}
			onopen={(organization) => toast(organization.name)}
		>
			{#snippet bulkActions({ ids, clear })}
				<Button
					variant="outline"
					size="sm"
					onclick={() => {
						removeSelection(ids);
						clear();
					}}
				>
					<TrashIcon aria-hidden="true" />
					Снять с публикации
				</Button>
			{/snippet}
		</DataTable>
	</section>

	<section class="flex flex-col gap-3">
		<h2 class="text-sm font-semibold tracking-tight">Форма</h2>
		<Card.Root size="sm" class="max-w-2xl">
			<Card.Header>
				<Card.Title>Организация</Card.Title>
				<Card.Description>
					Проверка на стороне браузера и на сервере — по одной и той же схеме.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<!-- The schema validates, in Russian, on both sides; browser bubbles would say
				     something else in a language the page does not control. -->
				<form method="POST" use:enhance novalidate class="flex flex-col gap-4">
					{#if $formMessage}
						<Alert.Root>
							<Alert.Title>{$formMessage}</Alert.Title>
						</Alert.Root>
					{/if}
					<FieldInput
						name="name"
						label="Название"
						description="Полное название, как в документах."
						required
						bind:value={$form.name}
						errors={$errors.name}
					/>
					<FieldInput
						name="shortName"
						label="Краткое название"
						placeholder="СевУПИ-1"
						bind:value={$form.shortName}
						errors={$errors.shortName}
					/>
					<FieldSelect
						name="region"
						label="Регион"
						required
						options={REGIONS.map((region) => ({ value: region, label: region }))}
						bind:value={$form.region}
						errors={$errors.region}
					/>
					<FieldInput
						name="site"
						label="Сайт"
						type="url"
						placeholder="https://example.org"
						required
						bind:value={$form.site}
						errors={$errors.site}
					/>
					<FieldInput
						name="email"
						label="E-mail контактного лица"
						type="email"
						placeholder="name@example.org"
						required
						bind:value={$form.email}
						errors={$errors.email}
					/>
					<FieldDate
						name="agreedOn"
						label="Дата подписания"
						description="Необязательно; пустое поле означает «не подписано»."
						bind:value={() => $form.agreedOn ?? '', (next) => ($form.agreedOn = next || null)}
						errors={$errors.agreedOn}
					/>
					<FieldTextarea
						name="comment"
						label="Комментарий"
						bind:value={$form.comment}
						errors={$errors.comment}
					/>
					<!-- Форма витрины ничего не отправляет, но контрол выбора файла должен
						быть виден рядом с остальными полями: он собран сам, а не отдан
						браузеру. -->
					<FileInput
						id="uiKitFile"
						label="Скан документа"
						description="PDF или изображение, до 25 МиБ."
						accept="application/pdf,image/png,image/jpeg"
					/>
					<FormActions
						submitting={$submitting}
						submitLabel="Сохранить организацию"
						oncancel={() => toast('Отменено')}
					/>
				</form>
			</Card.Content>
		</Card.Root>
	</section>
</div>

{#snippet resetShowcaseFilters()}
	<Button variant="outline" size="sm" onclick={() => toast('Фильтры сброшены')}>
		Сбросить фильтры
	</Button>
{/snippet}

<!-- Диалог с формой: тело прокручивается, панель кнопок прибита к низу, а
	закрытие с набранным текстом спрашивает подтверждение. -->
<FormDialog
	bind:open={formDialogOpen}
	width="lg"
	title="Перевести на следующую стадию"
	description="Витрина раскладки: длинная форма, прибитая панель кнопок и вопрос о несохранённом вводе."
	dirty={dialogNote.trim() !== ''}
>
	<form id="ui-kit-dialog-form" class="flex flex-col gap-4">
		<FieldInput name="uiKitDialogStage" label="Стадия" bind:value={dialogStage} />
		<FieldTextarea
			name="uiKitDialogNote"
			label="Комментарий"
			description="Наберите что-нибудь и нажмите Esc: диалог спросит, закрывать ли без сохранения."
			rows={4}
			bind:value={dialogNote}
		/>
		<FileInput
			id="uiKitDialogFile"
			label="Вложение"
			description="Панель кнопок остаётся на месте, сколько бы полей ни было выше."
		/>
		<InlineHint>
			Тело диалога прокручивается само, поэтому слой не вырастает выше окна, а кнопки не уезжают за
			его край.
		</InlineHint>
	</form>

	{#snippet footer({ close })}
		<FormActions
			form="ui-kit-dialog-form"
			submitLabel="Подтвердить"
			oncancel={close}
			class="border-t-0 pt-0"
		/>
	{/snippet}
</FormDialog>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Удалить взаимодействие?"
	description="Запись и её документы перестанут быть доступны. Действие необратимо."
	confirmLabel="Удалить взаимодействие"
	tone="danger"
	onconfirm={() => {
		toast.success('Взаимодействие удалено');
	}}
/>
