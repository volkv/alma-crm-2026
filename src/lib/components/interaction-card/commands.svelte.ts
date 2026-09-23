import { getContext, setContext } from 'svelte';
import type { CardCommand } from './model';

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

	open(command: CardCommand): void {
		this.current = command;
	}

	close(): void {
		this.current = null;
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
