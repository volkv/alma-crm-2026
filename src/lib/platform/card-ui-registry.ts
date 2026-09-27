/**
 * Реестр карточных частей модулей: панели, факты шапки и диалоги, собранные из
 * `card.ts` установленных модулей.
 *
 * Импорт жадный и статический: сервер рисует панели модулей в первом же ответе,
 * а ленивая загрузка оставила бы «Контекст» пустым до гидратации. Часть модуля,
 * которого нет в `crm.config.ts`, отбрасывается — без строки в конфиге модуля
 * как будто нет, даже если папка на месте.
 *
 * Полноту проверяет сама загрузка реестра: панель или факт шапки из манифеста
 * без компонента роняют сборку, а не оставляют дыру в карточке у сотрудника.
 */
import type { Component } from 'svelte';
import type { CardDialogProps, CardPanelProps, CardUiPart, HeaderFactProps } from './card-ui';
import type { CounterpartyShape } from './define';
import {
	INSTALLED_MODULES,
	headerFactSpecs,
	isModuleKey,
	panelOwner,
	type ModuleKey
} from './registry';

const found = import.meta.glob<{ default: CardUiPart }>(
	['/src/modules/*/card.ts', '/src/modules/custom/*/card.ts'],
	{ eager: true }
);

const PARTS = new Map<ModuleKey, CardUiPart>();

for (const [file, loaded] of Object.entries(found)) {
	const part = loaded.default;

	if (!isModuleKey(part.key)) {
		continue;
	}

	if (PARTS.has(part.key)) {
		throw new Error(`Карточная часть модуля «${part.key}» объявлена дважды (${file})`);
	}

	PARTS.set(part.key, part);
}

for (const module of INSTALLED_MODULES) {
	const part = PARTS.get(module.key);
	const missing = [
		...module.panels
			.filter((panel) => part?.ui.panels[panel.key] === undefined)
			.map((panel) => `панель «${panel.key}»`),
		...module.headerFacts
			.filter((fact) => part?.ui.headerFacts[fact.key] === undefined)
			.map((fact) => `факт шапки «${fact.key}»`)
	];

	if (missing.length > 0) {
		throw new Error(
			`Модуль «${module.key}» объявил в манифесте, но не нарисовал в card.ts: ${missing.join(', ')}`
		);
	}
}

/** Компонент панели модуля; `null` — панель ядра или такой панели в установке нет. */
export function cardPanelComponent(panel: string): Component<CardPanelProps> | null {
	const owner = panelOwner(panel);

	if (owner === null || owner === undefined) {
		return null;
	}

	return PARTS.get(owner)?.ui.panels[panel] ?? null;
}

/** Факты шапки для контрагента этого вида от действующих модулей, в порядке конфига. */
export function headerFactsFor(
	modules: readonly string[],
	shape: CounterpartyShape
): { module: ModuleKey; key: string; label: string; component: Component<HeaderFactProps> }[] {
	return headerFactSpecs(modules, shape).flatMap((spec) => {
		const component = PARTS.get(spec.module)?.ui.headerFacts[spec.key];

		return component === undefined
			? []
			: [{ module: spec.module, key: spec.key, label: spec.label, component }];
	});
}

/** Диалоги действующих модулей, в порядке конфига. */
export function cardDialogs(
	modules: readonly string[]
): { module: ModuleKey; component: Component<CardDialogProps> }[] {
	return INSTALLED_MODULES.flatMap((module) => {
		const dialogs = PARTS.get(module.key)?.ui.dialogs ?? null;

		return modules.includes(module.key) && dialogs !== null
			? [{ module: module.key, component: dialogs }]
			: [];
	});
}
