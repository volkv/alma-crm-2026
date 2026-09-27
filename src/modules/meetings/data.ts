/**
 * Данные «Встреч» для карточки: то, что `load` в `card.server.ts` кладёт в
 * `data.moduleData.meetings`, а диалог приглашения читает. Тип живёт отдельно
 * от серверной части, чтобы диалог брал его, не касаясь серверного файла.
 */
import type { AffiliationView } from '$lib/contracts/directory';

/** Назначенная встреча, как её подставляет диалог: время — по Москве, для поля формы. */
export type SavedMeeting = {
	/** `YYYY-MM-DDTHH:mm` по Москве — значение поля `datetime-local`. */
	start: string;
	durationMinutes: number;
	location: string | null;
	/** Встреча ещё впереди: новое назначение её перенесёт, а не заведёт следующую. */
	upcoming: boolean;
};

export type MeetingsCardData = {
	/** Контакты основной стороны — чекбоксами в списке участников. */
	contacts: readonly AffiliationView[];
	/** Нет права видеть людей организации: список пуст поэтому, а не потому что их нет. */
	contactsDenied: boolean;
	/** Контактное лицо дела: в приглашение оно попадает по умолчанию. */
	defaultContactId: string | null;
	/** Последняя назначенная встреча; `null` — встреч по делу ещё не назначали. */
	meeting: SavedMeeting | null;
};
