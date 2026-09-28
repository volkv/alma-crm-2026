/**
 * Данные «Встреч» для карточки: то, что `load` в `card.server.ts` кладёт в
 * `data.moduleData.meetings`, а диалог приглашения читает, и исход отправки,
 * который диалог получает от действия. Тип живёт отдельно от серверной части,
 * чтобы диалог брал его, не касаясь серверного файла.
 *
 * Адресов почты здесь нет: контакты и коллеги видны именем, отметка уходит
 * идентификатором, а адрес подставляет сервер.
 */

/** Назначенная встреча, как её подставляет диалог: время — по Москве, для поля формы. */
export type SavedMeeting = {
	/** `YYYY-MM-DDTHH:mm` по Москве — значение поля `datetime-local`. */
	start: string;
	durationMinutes: number;
	location: string | null;
	/** Встреча ещё впереди и не отменена: новое назначение её перенесёт, а не заведёт следующую. */
	upcoming: boolean;
	/** Встречу отменили — поля диалога заводятся чистыми. */
	cancelled: boolean;
	/** Сколько участников получили последнее письмо; `0` — встречу назначали без писем. */
	invitedCount: number;
};

/** Контакт основной стороны в списке участников. */
export type MeetingContactView = {
	id: string;
	name: string;
	position: string;
	/** Контактное лицо дела: отмечено по умолчанию. */
	isCaseContact: boolean;
	/** Почему письмо ему не придёт; `null` — придёт. В файле он всё равно останется по имени. */
	unavailableReason: string | null;
};

/** Коллега — сотрудник, который видит дело: его можно позвать на встречу. */
export type MeetingColleagueView = { userId: string; name: string };

/** Политика почты установки: диалог показывает её заранее, а не отказом после нажатия. */
export type MeetingMailPolicyView = { allowed: boolean; sandboxed: boolean; reason: string | null };

export type MeetingsCardData = {
	/** Контакты основной стороны — чекбоксами в списке участников. */
	contacts: readonly MeetingContactView[];
	/** Нет права видеть людей организации: список пуст поэтому, а не потому что их нет. */
	contactsDenied: boolean;
	/** Контактное лицо дела: в приглашение оно попадает по умолчанию. */
	defaultContactId: string | null;
	/** Коллеги, кроме ответственного: он участвует всегда. */
	colleagues: readonly MeetingColleagueView[];
	policy: MeetingMailPolicyView;
	/** Последняя назначенная встреча; `null` — встреч по делу ещё не назначали. */
	meeting: SavedMeeting | null;
};

/** Кому не ушло или не уйдёт письмо — именем и причиной словами. */
export type MeetingMissedRecipient = { name: string; reason: string };

/** Исход «Назначить и отправить», «Тест себе» и «Отменить встречу». */
export type MeetingSendOutcome =
	| {
			status: 'sent';
			/** Что ушло: приглашение, обновление после переноса, отмена. */
			kind: 'invite' | 'update' | 'cancel';
			test: boolean;
			sentCount: number;
			/** Кому не ушло: сервер не принял письмо. */
			failed: MeetingMissedRecipient[];
			/** Кому не отправляли: нет открытой почты, контакт больше не у стороны. */
			skipped: MeetingMissedRecipient[];
	  }
	| {
			/** `refused` — до соединения (песочница, не настроен сервер), `failed` — сервер не принял ни одного. */
			status: 'refused' | 'failed';
			kind: 'invite' | 'update' | 'cancel';
			test: boolean;
			error: string;
			/** Отмена записана в деле, даже если письма не ушли. */
			recorded: boolean;
	  };
