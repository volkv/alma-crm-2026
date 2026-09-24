/**
 * Отметки по документу: согласован, утверждён, вступил в силу.
 *
 * Это три независимых факта, а не стадии одного статуса: документ бывает
 * согласован и не утверждён, а дата вступления в силу вообще приходит из
 * договора. Каждый факт фиксируется один раз — задним числом его можно
 * поставить (`at`), переставить нельзя: отметка о согласовании, которую можно
 * переписать, ничего не доказывает.
 */
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { moscowDay } from '$lib/contracts/calendar';
import {
	markDayBounds,
	markDayIssue,
	TRANSFERRED_STATUS,
	type DocumentStatusFact,
	type DocumentView
} from '$lib/contracts/documents';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { contractItems, documentContractItems, documents } from '../db/schema';
import { withTransaction, type Tx } from '../db/transaction';
import { publishAfterCommit } from '../live/publish';
import { bumpContractsOfItems } from '../directory/contracts';
import { ConflictError, ValidationError } from '../errors';
import { editorOf, type Editor } from '../interactions/edit-version';
import { requirePermission } from '../rbac';
import { applyDocumentMark, touchInteraction } from '../stages/commands';
import { MARK_MOMENT_COLUMNS } from './evidence';
import { assertDocumentAccessible, selectDocumentRow, toDocumentView } from './read';

type FactDefinition = {
	/** Столбец с моментом факта; он же признак «уже отмечено». */
	at: PgColumn;
	/** Как факт называется в сообщении об отказе. */
	label: string;
	/** Значения, которые проставляются при отметке. */
	values: (
		at: Date,
		userId: string | null,
		note: string | null
	) => Partial<typeof documents.$inferInsert>;
};

const FACTS: Record<DocumentStatusFact, FactDefinition> = {
	agreed: {
		at: MARK_MOMENT_COLUMNS.agreed,
		label: 'согласован',
		values: (at, userId, note) => ({ agreedAt: at, agreedBy: userId, agreedNote: note })
	},
	approved: {
		at: MARK_MOMENT_COLUMNS.approved,
		label: 'утверждён',
		values: (at, userId, note) => ({ approvedAt: at, approvedBy: userId, approvedNote: note })
	},
	in_effect: {
		at: MARK_MOMENT_COLUMNS.in_effect,
		label: 'введён в действие',
		values: (at, userId, note) => ({ inEffectAt: at, inEffectBy: userId, inEffectNote: note })
	}
};

/**
 * Подписанный акт передачи — это и есть факт передачи: позиции договора,
 * которые называет редакция, получают статус «передан» той же транзакцией, что
 * и отметка «Утверждён» (подписанный сторонами экземпляр). Возвращает, сколько
 * позиций переведено. Позиция, уже помеченная «передан», не переписывается.
 */
async function markItemsTransferred(tx: Tx, documentId: string, editor: Editor): Promise<number> {
	const linked = tx
		.select({ id: documentContractItems.contractItemId })
		.from(documentContractItems)
		.where(eq(documentContractItems.documentId, documentId));

	const pending = await tx
		.select({ id: contractItems.id })
		.from(contractItems)
		.where(
			and(inArray(contractItems.id, linked), ne(contractItems.transferStatus, TRANSFERRED_STATUS))
		);

	if (pending.length === 0) {
		return 0;
	}

	const ids = pending.map((row) => row.id);

	// Статус передачи — поле позиции: открытая форма договора после этого
	// получит отказ, а не вернёт «ожидает передачи». Версия договора — раньше
	// позиций, тем же порядком, что у формы договора.
	await bumpContractsOfItems(tx, ids, editor);

	const updated = await tx
		.update(contractItems)
		.set({ transferStatus: TRANSFERRED_STATUS, updatedAt: new Date() })
		.where(
			and(inArray(contractItems.id, ids), ne(contractItems.transferStatus, TRANSFERRED_STATUS))
		)
		.returning({ id: contractItems.id });

	return updated.length;
}

/**
 * Ставит отметку по документу.
 *
 * `at` позволяет записать факт, случившийся раньше, чем до него дошли руки в
 * системе; по умолчанию — текущий момент. Задним числом — да, вперёд — нет, и
 * не раньше дня, когда документ появился в системе: до этого дня согласовывать
 * в системе было нечего. Правило берётся из контракта, тот же самый, которым
 * форма выставляет границы календаря.
 */
export async function markDocument(
	ctx: ActorContext,
	documentId: string,
	fact: DocumentStatusFact,
	at?: Date,
	note: string | null = null
): Promise<DocumentView> {
	requirePermission(ctx, 'documents.write');

	const existing = await selectDocumentRow(documentId);
	await assertDocumentAccessible(ctx, existing);

	const now = new Date();
	const moment = at ?? now;
	const issue = markDayIssue(moscowDay(moment), markDayBounds(existing.createdAt, now));

	if (issue !== null) {
		throw new ValidationError(issue);
	}

	const definition = FACTS[fact];
	const values = definition.values(moment, ctx.user?.id ?? null, note);

	return withTransaction(ctx, async (tx) => {
		// Условие `is null` в самом UPDATE, а не проверка перед ним: между
		// чтением и записью отметку мог поставить кто-то другой, и тогда мы
		// затёрли бы чужую дату.
		const [row] = await tx
			.update(documents)
			.set({ ...values, updatedAt: new Date() })
			.where(and(eq(documents.id, existing.id), isNull(definition.at)))
			.returning();

		if (row === undefined) {
			throw new ConflictError(`Документ уже ${definition.label}`);
		}

		if (row.interactionId !== null) {
			// Отметка — это ещё и доказательство исполнения стадии: стадия, которая
			// её ждёт, подтверждается здесь же, в одной транзакции с самой
			// отметкой. «Отметили, а подтверждение потеряли» — не то состояние, в
			// котором система имеет право оказаться.
			await applyDocumentMark(ctx, tx, {
				interactionId: row.interactionId,
				// Шаблон решает, та ли это бумага: «Утверждён» на соглашении не
				// закрывает стадию, которая ждёт подписанного акта передачи.
				templateKey: row.templateKey,
				evidence: {
					documentId: row.id,
					title: row.title,
					mark: fact,
					markedAt: moment.toISOString()
				}
			});

			await touchInteraction(tx, row.interactionId);
			publishAfterCommit(tx, row.interactionId, { type: 'interaction.changed' });
		}

		const transferredItemCount =
			fact === 'approved' ? await markItemsTransferred(tx, row.id, editorOf(ctx)) : 0;

		await recordAuditEvent(
			ctx,
			{
				type: 'documents.status_changed',
				outcome: 'success',
				subject: { type: 'document', id: row.id },
				// Взаимодействие — в подробностях: по отметке спрашивают «в каком
				// деле это было», и ответ не должен требовать второго запроса.
				// Комментарий к отметке сюда не попадает и попасть не может: это
				// текст, который писал человек, а подробности события принимают
				// только имена полей и ссылки на записи (`validateAuditDetails`).
				details: {
					changedFields: Object.keys(values),
					...(transferredItemCount === 0 ? {} : { transferredItemCount }),
					...(row.interactionId === null ? {} : { interactionId: row.interactionId })
				}
			},
			tx
		);

		return toDocumentView(row);
	});
}
