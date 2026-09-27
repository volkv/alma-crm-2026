/**
 * Фасад карточки взаимодействия для модулей: типы модели карточки, контекст
 * команд и общие куски разметки панелей.
 *
 * Модуль не лезет во внутренности карточки (`$lib/components/interaction-card`)
 * напрямую: всё, чем он пользуется, названо здесь, и карточку можно
 * перекладывать, не ломая модули, пока этот список держится.
 */
export type { CounterpartyShape } from './define';
export type {
	CardCommand,
	CardExchange,
	CardModel,
	CardPayment,
	CardSource
} from '$lib/components/interaction-card/model';
export {
	describeUncountedGroup,
	purposeCountingStages
} from '$lib/components/interaction-card/model';
export { getCardCommands } from '$lib/components/interaction-card/commands.svelte';
export { default as ContactLine } from '$lib/components/interaction-card/contact-line.svelte';
export { default as ContextSection } from '$lib/components/interaction-card/context-section.svelte';
export { default as OfferingList } from '$lib/components/interaction-card/offering-list.svelte';
