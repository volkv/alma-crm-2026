/**
 * Данные «Встреч» для карточки: то, что `load` в `card.server.ts` кладёт в
 * `data.moduleData.meetings`, а диалог приглашения читает. Тип живёт отдельно
 * от серверной части, чтобы диалог брал его, не касаясь серверного файла.
 */
import type { AffiliationView } from '$lib/contracts/directory';

export type MeetingsCardData = {
	/** Контакты основной стороны — чекбоксами в списке участников. */
	contacts: readonly AffiliationView[];
	/** Нет права видеть людей организации: список пуст поэтому, а не потому что их нет. */
	contactsDenied: boolean;
};
