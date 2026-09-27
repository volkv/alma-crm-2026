import { getContext, setContext } from 'svelte';
import type { CardCommand } from './model';

/**
 * Разделы состава дела: стороны и то, что предлагаем, — программы и продукты.
 * Ключ раздела стоит и в адресе карточки (`?compose=parties`): по нему отказ
 * пакета документов ведёт прямо туда, где недостающую сторону добавляют.
 */
export const COMPOSITION_SECTIONS = ['parties', 'offering'] as const;

export type CompositionSection = (typeof COMPOSITION_SECTIONS)[number];

/**
 * Какой диалог карточки открыт сейчас.
 *
 * Одну и ту же команду начинают из разных мест: пункт меню «Ещё», кнопка у
 * условия перехода, кнопка панели контекста. Диалог у команды один, и открыт
 * в каждый момент не больше одного, — поэтому это одно общее состояние, а не
 * флаг в каждом компоненте, который умеет нажать кнопку.
 */
export class CardCommands {
	current = $state<CardCommand | null>(null);
	/**
	 * Открытый раздел диалога «Изменить состав»; `null` — диалог закрыт. Стоит
	 * рядом с `current`, а не внутри него: состав открывают из панелей
	 * контекста и по ссылке из отказа пакета, и открыт он, как любой диалог
	 * карточки, только один.
	 */
	composition = $state<CompositionSection | null>(null);

	open(command: CardCommand): void {
		this.composition = null;
		this.current = command;
	}

	openComposition(section: CompositionSection): void {
		this.current = null;
		this.composition = section;
	}

	close(): void {
		this.current = null;
		this.composition = null;
	}

	/** Открыт ли хоть один диалог: живая карточка тогда не перечитывает себя сама. */
	get busy(): boolean {
		return this.current !== null || this.composition !== null;
	}

	/** Открыт ли диалог этого вида; сама команда — в `current`. */
	is(kind: CardCommand['kind']): boolean {
		return this.current?.kind === kind;
	}
}

const CARD_COMMANDS_KEY = Symbol('card-commands');

/** Заводит состояние диалогов карточки: его читают кнопки и сами диалоги. */
export function setCardCommands(): CardCommands {
	return setContext(CARD_COMMANDS_KEY, new CardCommands());
}

export function getCardCommands(): CardCommands {
	const commands = getContext<CardCommands | undefined>(CARD_COMMANDS_KEY);

	if (commands === undefined) {
		throw new Error('Команды карточки доступны только внутри карточки взаимодействия');
	}

	return commands;
}
