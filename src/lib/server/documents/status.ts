/**
 * Отметки по документу: согласован, утверждён, вступил в силу.
 *
 * Это три независимых факта, а не стадии одного статуса: документ бывает
 * согласован и не утверждён, а дата вступления в силу вообще приходит из
 * договора. Каждый факт фиксируется один раз — задним числом его можно
 * поставить (`at`), переставить нельзя: отметка о согласовании, которую можно
 * переписать, ничего не доказывает.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { DocumentStatusFact, DocumentView } from '$lib/contracts/documents';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { documents } from '../db/schema';
import { withTransaction } from '../db/transaction';
import { ConflictError } from '../errors';
import { requirePermission } from '../rbac';
import { assertDocumentAccessible, selectDocumentRow, toDocumentView } from './read';

type FactDefinition = {
	/** Столбец с моментом факта; он же признак «уже отмечено». */
	at: PgColumn;
	/** Как факт называется в сообщении об отказе. */
	label: string;
	/** Значения, которые проставляются при отметке. */
	values: (at: Date, userId: string | null) => Partial<typeof documents.$inferInsert>;
};

const FACTS: Record<DocumentStatusFact, FactDefinition> = {
	agreed: {
		at: documents.agreedAt,
		label: 'согласован',
		values: (at, userId) => ({ agreedAt: at, agreedBy: userId })
	},
	approved: {
		at: documents.approvedAt,
		label: 'утверждён',
		values: (at, userId) => ({ approvedAt: at, approvedBy: userId })
	},
	in_effect: {
		at: documents.inEffectAt,
		label: 'введён в действие',
		values: (at, userId) => ({ inEffectAt: at, inEffectBy: userId })
	}
};

/**
 * Ставит отметку по документу.
 *
 * `at` позволяет записать факт, случившийся раньше, чем до него дошли руки в
 * системе; по умолчанию — текущий момент.
 */
export async function markDocument(
	ctx: ActorContext,
	documentId: string,
	fact: DocumentStatusFact,
	at?: Date
): Promise<DocumentView> {
	requirePermission(ctx, 'documents.write');

	const existing = await selectDocumentRow(documentId);
	await assertDocumentAccessible(ctx, existing);

	const definition = FACTS[fact];
	const values = definition.values(at ?? new Date(), ctx.user?.id ?? null);

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

		await recordAuditEvent(
			ctx,
			{
				type: 'documents.status_changed',
				outcome: 'success',
				subject: { type: 'document', id: row.id },
				details: { changedFields: Object.keys(values) }
			},
			tx
		);

		return toDocumentView(row);
	});
}
