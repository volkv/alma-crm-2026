/**
 * Факт модуля в истории дела: «встреча назначена на 12.10.2026 14:00».
 *
 * У модуля нет своих таблиц для таких мелочей, и заводить их ради одной даты
 * незачем: факт ложится строкой истории правок дела с полем `<модуль>:<факт>`
 * и готовой фразой в новом значении. Так он сразу виден в ленте карточки,
 * переживает перечитывание и рядом с пунктом чек-листа, у которого стоит
 * действие модуля, показывается последним сохранённым (`model.ts`).
 *
 * Фраза — не персональные данные: модуль кладёт сюда дату, длительность и
 * место, а не имена и контакты участников.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { AuditEventType } from '$lib/contracts/audit';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { interactionChanges, interactions } from '../db/schema';
import { withTransaction } from '../db/transaction';
import { ForbiddenError, NotFoundError } from '../errors';
import { interactionScopeFilter } from '../interactions/access';
import { publishAfterCommit } from '../live/publish';
import { requirePermission } from '../rbac';
import { touchInteraction } from '../stages/commands';

export async function recordModuleFact(
	ctx: ActorContext,
	input: {
		interactionId: string;
		module: string;
		fact: string;
		/** Готовая фраза для ленты и пункта чек-листа. */
		text: string;
		auditType: AuditEventType;
	}
): Promise<void> {
	requirePermission(ctx, 'interactions.write');

	if (ctx.user === null) {
		throw new ForbiddenError('Это действие выполняет пользователь, а не фоновая задача');
	}

	const authorId = ctx.user.id;
	const field = `${input.module}:${input.fact}`;

	await withTransaction(ctx, async (tx) => {
		const [row] = await tx
			.select({ id: interactions.id })
			.from(interactions)
			.where(and(eq(interactions.id, input.interactionId), interactionScopeFilter(ctx)))
			.for('update');

		if (row === undefined) {
			throw new NotFoundError('Взаимодействие не найдено');
		}

		const [previous] = await tx
			.select({ value: interactionChanges.newValue })
			.from(interactionChanges)
			.where(
				and(
					eq(interactionChanges.interactionId, input.interactionId),
					eq(interactionChanges.field, field)
				)
			)
			.orderBy(desc(interactionChanges.changedAt))
			.limit(1);

		await tx.insert(interactionChanges).values({
			interactionId: input.interactionId,
			authorId,
			field,
			oldValue: previous?.value ?? null,
			newValue: input.text
		});

		await touchInteraction(tx, input.interactionId);
		publishAfterCommit(tx, input.interactionId, { type: 'interaction.changed' });

		await recordAuditEvent(
			ctx,
			{
				type: input.auditType,
				outcome: 'success',
				subject: { type: 'interaction', id: input.interactionId },
				details: { changedFields: [field] }
			},
			tx
		);
	});
}
