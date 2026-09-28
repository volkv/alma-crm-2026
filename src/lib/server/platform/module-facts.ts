/**
 * Факт модуля в истории дела: «встреча назначена на 12.10.2026 14:00».
 *
 * У модуля нет своих таблиц для таких мелочей, и заводить их ради одной даты
 * незачем: факт ложится строкой истории правок дела с полем `<модуль>:<факт>`,
 * готовой фразой и данными модуля в новом значении (`$lib/platform/module-fact`).
 * Так он сразу виден в ленте карточки, переживает перечитывание, рядом с
 * пунктом чек-листа, у которого стоит действие модуля, показывается последним
 * сохранённым (`model.ts`), а модуль по данным узнаёт свой факт обратно.
 *
 * Фраза и данные — не персональные данные: модуль кладёт сюда дату,
 * длительность и место, а не имена и контакты участников.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { AuditDetails, AuditEventType } from '$lib/contracts/audit';
import {
	readModuleFactValue,
	type ModuleFactData,
	type ModuleFactValue
} from '$lib/platform/module-fact';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getDb } from '../db';
import { interactionChanges, interactions } from '../db/schema';
import { withTransaction, type Tx } from '../db/transaction';
import { ForbiddenError, NotFoundError } from '../errors';
import { interactionScopeFilter } from '../interactions/access';
import { publishAfterCommit } from '../live/publish';
import { requirePermission } from '../rbac';

type FactInput = {
	interactionId: string;
	module: string;
	fact: string;
	/** Готовая фраза для ленты и пункта чек-листа. */
	text: string;
	/** Что модулю нужно, чтобы узнать факт обратно; без данных — пусто. */
	data?: ModuleFactData;
};

/** Последний сохранённый факт модуля по делу; `null` — такого факта ещё не было. */
export async function readModuleFact(
	executor: Tx | ReturnType<typeof getDb>,
	interactionId: string,
	module: string,
	fact: string
): Promise<(ModuleFactValue & { at: Date }) | null> {
	const [row] = await executor
		.select({ value: interactionChanges.newValue, at: interactionChanges.changedAt })
		.from(interactionChanges)
		.where(
			and(
				eq(interactionChanges.interactionId, interactionId),
				eq(interactionChanges.field, `${module}:${fact}`)
			)
		)
		.orderBy(desc(interactionChanges.changedAt))
		.limit(1);

	if (row === undefined) {
		return null;
	}

	const value = readModuleFactValue(row.value);

	if (value === null) {
		throw new Error(`Факт «${module}:${fact}» записан не в виде факта модуля`);
	}

	return { ...value, at: row.at };
}

/**
 * Факт модуля в транзакции вызывающего: строка истории с автором и сигнал
 * живой карточке. Автор истории — человек: фоновая правка остаётся в журнале
 * действий, как и у правки плана. Активность дела отмечает вызывающий — у
 * команды стадии она и так своя.
 */
export async function recordModuleFactIn(
	ctx: ActorContext,
	tx: Tx,
	input: FactInput
): Promise<void> {
	if (ctx.user === null) {
		throw new ForbiddenError('Это действие выполняет пользователь, а не фоновая задача');
	}

	const previous = await readModuleFact(tx, input.interactionId, input.module, input.fact);
	const value: ModuleFactValue = { text: input.text, data: input.data ?? {} };

	await tx.insert(interactionChanges).values({
		interactionId: input.interactionId,
		authorId: ctx.user.id,
		field: `${input.module}:${input.fact}`,
		oldValue: previous === null ? null : { text: previous.text, data: previous.data },
		newValue: value
	});

	publishAfterCommit(tx, input.interactionId, { type: 'interaction.changed' });
}

/**
 * Факт модуля своей транзакцией — под блокировкой дела и с событием журнала.
 * `auditDetails` дополняют подробности события — например, числом получателей.
 * `alongside` — что ещё должно лечь той же транзакцией: отмена встречи ставит
 * в ней письма об отмене в очередь, и откатиться они могут только вместе.
 */
export async function recordModuleFact(
	ctx: ActorContext,
	input: FactInput & {
		auditType: AuditEventType;
		auditDetails?: AuditDetails;
		alongside?: (tx: Tx) => Promise<void>;
	}
): Promise<void> {
	requirePermission(ctx, 'interactions.write');

	await withTransaction(ctx, async (tx) => {
		const [row] = await tx
			.select({ id: interactions.id })
			.from(interactions)
			.where(and(eq(interactions.id, input.interactionId), interactionScopeFilter(ctx)))
			.for('update');

		if (row === undefined) {
			throw new NotFoundError('Взаимодействие не найдено');
		}

		await recordModuleFactIn(ctx, tx, input);
		await tx
			.update(interactions)
			.set({ lastActivityAt: sql`now()`, updatedAt: sql`now()` })
			.where(eq(interactions.id, input.interactionId));

		await recordAuditEvent(
			ctx,
			{
				type: input.auditType,
				outcome: 'success',
				subject: { type: 'interaction', id: input.interactionId },
				details: { ...input.auditDetails, changedFields: [`${input.module}:${input.fact}`] }
			},
			tx
		);

		await input.alongside?.(tx);
	});
}
