/**
 * Части карточки, которые рисует модуль: панели, факты шапки и диалоги. Модуль
 * объявляет их в своём `card.ts` через `defineCardUi`, реестр
 * (`card-ui-registry.ts`) собирает их со всех установленных модулей.
 *
 * Пропсы у всех панелей одни и те же: карточка не знает, что нужно конкретной
 * панели, и отдаёт всем исходные данные (`source`) и модель (`model`), а панель
 * берёт своё. Связь с манифестом проверяет компилятор: у каждой панели и факта
 * шапки из манифеста должен быть компонент, лишний ключ — ошибка.
 *
 * Здесь нет `import.meta.glob`: объявление живёт отдельно от реестра, иначе
 * `card.ts` модуля и реестр импортировали бы друг друга.
 */
import type { Component } from 'svelte';
import type { DocumentSupersession } from '$lib/contracts/documents';
import type { CardModel, CardSource } from './card';
import type { ModuleManifest } from './define';

/** Пропсы панели модуля в «Контексте» карточки. */
export type CardPanelProps = {
	source: CardSource;
	model: CardModel;
	/** Что человеку можно в этой записи; недоступные кнопки панель не рисует. */
	can: { edit: boolean; upload: boolean; generate: boolean };
	supersessions: readonly DocumentSupersession[];
	/** Данные, которые модуль загрузил для карточки сам; `undefined` — не загружал. */
	data: unknown;
};

/**
 * Пропсы факта в шапке карточки. Факт рисует свой блок целиком — подпись и
 * значение; `hide` — классы, которыми шапка прячет его на узком экране.
 */
export type HeaderFactProps = {
	model: CardModel;
	label: string;
	hide: string;
};

/** Пропсы диалогов модуля: они стоят на странице карточки рядом с диалогами ядра. */
export type CardDialogProps = {
	source: CardSource;
	model: CardModel;
	data: unknown;
	workspaceKey: string;
};

export type CardUi<M extends ModuleManifest> = {
	panels: { [K in M['panels'][number]['key']]: Component<CardPanelProps> };
	headerFacts: { [K in M['headerFacts'][number]['key']]: Component<HeaderFactProps> };
	/** Все диалоги модуля одним компонентом; `null` — диалогов нет. */
	dialogs: Component<CardDialogProps> | null;
};

/** Карточная часть модуля — то, что `card.ts` модуля отдаёт по умолчанию. */
export type CardUiPart<M extends ModuleManifest = ModuleManifest> = {
	key: M['key'];
	ui: CardUi<M>;
};

export function defineCardUi<const M extends ModuleManifest>(
	manifest: M,
	ui: CardUi<M>
): CardUiPart<M> {
	return Object.freeze({ key: manifest.key, ui });
}
