/**
 * Каталог установленных модулей: всё, что ядро знает о модулях, оно узнаёт
 * отсюда. Чистый файл — без Svelte и без `import.meta.glob`, — потому что через
 * состав карточки (`$lib/contracts/process-card`) его читают миграция и сид в
 * обычном процессе Node.
 *
 * Модуль бывает в трёх состояниях относительно пространства: установлен (есть
 * в `crm.config.ts`), включён (строка `workspace_modules`) и действует
 * (включён или нужен стадии действующей редакции). Здесь — чистые функции над
 * этими множествами; чтение из базы — `$lib/server/platform/workspace-modules`.
 */
import config from '../../../crm.config.ts';
import {
	DOCUMENT_TEMPLATE_KEYS,
	DOCUMENT_TEMPLATE_LABELS,
	documentKindLabel,
	type DocumentTemplateKey
} from '$lib/contracts/documents';
import { CORE_PANELS } from './core-panels';
import type {
	CardActionSpec,
	CounterpartyShape,
	HeaderFactSpec,
	PanelSpec,
	StageRuleInput
} from './define';

export type InstalledModule = (typeof config)['modules'][number];
export type ModuleKey = InstalledModule['key'];
export type CorePanelKey = (typeof CORE_PANELS)[number]['key'];
export type PanelKey = CorePanelKey | InstalledModule['panels'][number]['key'];

/** Панель каталога вместе с владельцем; у панелей ядра владельца нет. */
export type PanelEntry = PanelSpec<PanelKey> & {
	module: ModuleKey | null;
	moduleLabel: string | null;
};

export const INSTALLED_MODULES: readonly InstalledModule[] = config.modules;

const MODULES_BY_KEY = new Map<string, InstalledModule>(
	INSTALLED_MODULES.map((module) => [module.key, module])
);

/**
 * Панели ядра и всех установленных модулей в порядке экрана. Порядок `sort`
 * устойчив, поэтому при равном `order` раньше стоит ядро, затем модули в
 * порядке конфига.
 */
export const PANEL_CATALOG: readonly PanelEntry[] = [
	...CORE_PANELS.map((panel): PanelEntry => ({ ...panel, module: null, moduleLabel: null })),
	...INSTALLED_MODULES.flatMap((module) =>
		module.panels.map((panel): PanelEntry => ({
			...panel,
			module: module.key,
			moduleLabel: module.label
		}))
	)
].sort((left, right) => left.order - right.order);

/** Ключи каталога — непустой кортеж: панели ядра есть в любой установке. */
export const PANEL_KEYS = PANEL_CATALOG.map((panel) => panel.key) as unknown as readonly [
	PanelKey,
	...PanelKey[]
];

const PANEL_OWNERS = new Map<string, ModuleKey | null>(
	PANEL_CATALOG.map((panel) => [panel.key, panel.module])
);

export function moduleByKey(key: string): InstalledModule | undefined {
	return MODULES_BY_KEY.get(key);
}

export function isModuleKey(key: string): key is ModuleKey {
	return MODULES_BY_KEY.has(key);
}

/**
 * Владелец панели: ключ модуля, `null` — ядро, `undefined` — такой панели в
 * установке нет (например, модуль убрали из конфига, а процесс её помнит).
 */
export function panelOwner(panel: string): ModuleKey | null | undefined {
	return PANEL_OWNERS.get(panel);
}

/**
 * Панели, которые карточка рисует: выбранные процессом, принадлежащие ядру или
 * действующему модулю, в порядке каталога. Незнакомый ключ молча выпадает —
 * процесс мог запомнить панель модуля, которого в установке больше нет, и
 * отказ из-за неё оставил бы человека без карточки.
 */
export function visiblePanels(chosen: readonly string[], active: Iterable<string>): PanelKey[] {
	const activeSet = new Set(active);
	const chosenSet = new Set(chosen);

	return PANEL_CATALOG.filter(
		(panel) => chosenSet.has(panel.key) && (panel.module === null || activeSet.has(panel.module))
	).map((panel) => panel.key);
}

/**
 * Модули, без которых стадии не закрыть: модуль → названия стадий, которым он
 * нужен. Модуль без правила (`requiredByStage: null`) сюда не попадает никогда.
 */
export function requiredModules(stages: readonly StageRuleInput[]): Map<ModuleKey, string[]> {
	const required = new Map<ModuleKey, string[]>();

	for (const module of INSTALLED_MODULES) {
		const rule = module.requiredByStage;

		if (rule === null) {
			continue;
		}

		const names = stages.filter((stage) => rule(stage)).map((stage) => stage.name);

		if (names.length > 0) {
			required.set(module.key, names);
		}
	}

	return required;
}

/**
 * Действующие модули: включённые явно или нужные стадиям, в порядке конфига.
 * Ключ, которого нет в установке, отбрасывается: строка в базе могла пережить
 * модуль.
 */
export function activeModules(
	enabled: Iterable<string>,
	required: ReadonlyMap<string, readonly string[]>
): ModuleKey[] {
	const enabledSet = new Set(enabled);

	return INSTALLED_MODULES.filter(
		(module) => enabledSet.has(module.key) || required.has(module.key)
	).map((module) => module.key);
}

const TEMPLATE_OWNERS = new Map<string, ModuleKey>(
	INSTALLED_MODULES.flatMap((module) =>
		module.documents.templates.map((template): [string, ModuleKey] => [template, module.key])
	)
);

const KIND_OWNERS = new Map<string, ModuleKey>(
	INSTALLED_MODULES.flatMap((module) =>
		module.documents.kinds.map((kind): [string, ModuleKey] => [kind, module.key])
	)
);

/**
 * Владелец шаблона документа: ключ модуля или `null` — шаблон ядра. Каталог
 * шаблонов закрыт в ядре (`DOCUMENT_TEMPLATE_KEYS`), модуль только объявляет,
 * какие из них его: на каталоге держатся публичное API и снимок стадии.
 */
export function templateOwner(template: string): ModuleKey | null {
	return TEMPLATE_OWNERS.get(template) ?? null;
}

/** Владелец вида документа: ключ модуля или `null` — вид ядра. */
export function kindOwner(kind: string): ModuleKey | null {
	return KIND_OWNERS.get(kind) ?? null;
}

/**
 * Шаблоны, которые дело может собрать: выбранные процессом, принадлежащие ядру
 * или действующему модулю, в порядке каталога. Как и у панелей, выбор процесса
 * не пропадает при выключенном модуле — шаблон вернётся, когда модуль снова
 * подключат.
 */
export function offeredTemplates(
	chosen: readonly string[],
	active: Iterable<string>
): DocumentTemplateKey[] {
	const activeSet = new Set(active);

	return DOCUMENT_TEMPLATE_KEYS.filter((template) => {
		const owner = templateOwner(template);

		return chosen.includes(template) && (owner === null || activeSet.has(owner));
	});
}

/** Название шаблона; ключ вне каталога печатается как записан. */
function templateLabel(template: string): string {
	return template in DOCUMENT_TEMPLATE_LABELS
		? DOCUMENT_TEMPLATE_LABELS[template as DocumentTemplateKey]
		: template;
}

function activeInstalled(active: readonly string[]): InstalledModule[] {
	return INSTALLED_MODULES.filter((module) => active.includes(module.key));
}

/** Действия карточки от действующих модулей, в порядке конфига. */
export function cardActionSpecs(
	active: readonly string[]
): (CardActionSpec & { module: ModuleKey })[] {
	return activeInstalled(active).flatMap((module) =>
		module.cardActions.map((action) => ({ ...action, module: module.key }))
	);
}

/** Факты шапки для контрагента этого вида от действующих модулей. */
export function headerFactSpecs(
	active: readonly string[],
	shape: CounterpartyShape
): (HeaderFactSpec & { module: ModuleKey })[] {
	return activeInstalled(active).flatMap((module) =>
		module.headerFacts
			.filter((fact) => (fact.shapes as readonly CounterpartyShape[]).includes(shape))
			.map((fact) => ({ ...fact, module: module.key }))
	);
}

/**
 * Что модуль даёт пространству — словами, для настроек: администратор решает,
 * включать ли модуль, по тому, что появится у сотрудников, а не по ключу.
 */
export function moduleContributions(key: ModuleKey): string[] {
	const module = moduleByKey(key);

	if (module === undefined) {
		return [];
	}

	return [
		...module.panels.map((panel) => `Панель «${panel.label}»`),
		...module.headerFacts.map((fact) => `Факт в шапке «${fact.label}»`),
		...module.cardActions.map((action) => `Действие «${action.label}»`),
		...module.sections.map((section) => `Пункт меню «${section.label}»`),
		...module.documents.templates.map((template) => `Шаблон «${templateLabel(template)}»`),
		...module.documents.kinds.map((kind) => `Вид документа «${documentKindLabel(kind)}»`)
	];
}
