/**
 * Отправки описания программ контактным лицам вуза из карточки дела.
 *
 * Строка — одно нажатие «Отправить контактам», которое ушло хотя бы одному
 * адресату: кто и когда отправил, на какой записи стадии, кому, какие
 * программы в каких версиях и какие файлы в каком виде. По ней закрывается
 * пункт чек-листа «Отправлено описание программ» (правило `offer_sent`) и ей
 * же отвечают на вопрос «что именно мы вузу отправили».
 *
 * Получатели — только идентификаторы роли и человека, без адреса и без ФИО:
 * персональные данные живут в `people`, зашифрованными, и обезличивание
 * человека не должно гоняться за копиями его адреса по таблицам отправок.
 * Файлы — идентификатор документа и его хеш: документ неизменяем, и хеш
 * доказывает, что ушёл именно этот файл, даже если материал с программы потом
 * сняли. Тестовое письмо себе сюда не пишется — оно остаётся в журнале.
 */
import { relations } from 'drizzle-orm';
import { index, jsonb, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { interactions, stageEntries } from './interactions';

export type ProgramOfferRecipient = { affiliationId: string; personId: string };
export type ProgramOfferProgram = { programId: string; programVersionId: string | null };
export type ProgramOfferDocument = { documentId: string; sha256: string };

export const programOfferSends = pgTable(
	'program_offer_sends',
	{
		id: uuid().primaryKey().defaultRandom(),
		interactionId: uuid()
			.notNull()
			.references(() => interactions.id, { onDelete: 'cascade' }),
		/** Открытая запись стадии в момент отправки; `null` — дело ни на какой стадии не стояло. */
		stageEntryId: uuid().references(() => stageEntries.id, { onDelete: 'set null' }),
		sentBy: uuid().references(() => users.id, { onDelete: 'set null' }),
		sentAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		/** Кому ушло: только те, чьё письмо сервер принял. */
		recipients: jsonb().$type<ProgramOfferRecipient[]>().notNull(),
		programs: jsonb().$type<ProgramOfferProgram[]>().notNull(),
		documents: jsonb().$type<ProgramOfferDocument[]>().notNull()
	},
	(table) => [
		// Правило пункта и карточка спрашивают последнюю отправку по делу.
		index('program_offer_sends_interaction_idx').on(table.interactionId, table.sentAt)
	]
);

export const programOfferSendsRelations = relations(programOfferSends, ({ one }) => ({
	interaction: one(interactions, {
		fields: [programOfferSends.interactionId],
		references: [interactions.id]
	}),
	stageEntry: one(stageEntries, {
		fields: [programOfferSends.stageEntryId],
		references: [stageEntries.id]
	}),
	sender: one(users, { fields: [programOfferSends.sentBy], references: [users.id] })
}));
