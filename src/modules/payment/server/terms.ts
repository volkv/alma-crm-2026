/**
 * Коммерческие условия дела — стоимость. Ведёт их модуль «Оплата»: стоимость
 * нужна там же, где отмечают оплату, и видна в шапке у лица и компании.
 *
 * Своя строка на дело со своей версией: правка стоимости не двигает версию
 * плана и не спорит с правкой сроков в соседней вкладке, а две правки самой
 * стоимости ловит версия условий.
 */
import { and, eq } from 'drizzle-orm';
import type { InteractionTermsView, SetInteractionTermsInput } from '$lib/contracts/terms';
import {
	assertInteractionVisible,
	ConflictError,
	getDb,
	interactionTerms,
	recordAuditEvent,
	requirePermission,
	users,
	withTransaction,
	type ActorContext
} from '$lib/platform/core.server';

const NONE: InteractionTermsView = {
	priceKopecks: null,
	version: 0,
	updatedAt: null,
	updatedByName: null
};

/** Условия дела; не записывали — пустые с версией `0`. */
export async function readInteractionTerms(
	ctx: ActorContext,
	interactionId: string
): Promise<InteractionTermsView> {
	requirePermission(ctx, 'interactions.read');
	await assertInteractionVisible(ctx, interactionId);

	const [row] = await getDb()
		.select({
			priceKopecks: interactionTerms.priceKopecks,
			version: interactionTerms.version,
			updatedAt: interactionTerms.updatedAt,
			updatedByName: users.fullName
		})
		.from(interactionTerms)
		.leftJoin(users, eq(users.id, interactionTerms.updatedBy))
		.where(eq(interactionTerms.interactionId, interactionId));

	return row ?? NONE;
}

const STALE = 'Стоимость уже изменили в другой вкладке — обновите карточку и повторите';

/**
 * Назвать или снять стоимость. Версия из формы должна совпасть с записанной:
 * иначе чужая правка молча затёрлась бы. Та же стоимость — не правка: версия
 * и журнал не трогаются.
 */
export async function setInteractionTerms(
	ctx: ActorContext,
	input: SetInteractionTermsInput
): Promise<InteractionTermsView> {
	requirePermission(ctx, 'interactions.write');
	await assertInteractionVisible(ctx, input.interactionId);

	await withTransaction(ctx, async (tx) => {
		const [current] = await tx
			.select({ priceKopecks: interactionTerms.priceKopecks, version: interactionTerms.version })
			.from(interactionTerms)
			.where(eq(interactionTerms.interactionId, input.interactionId))
			.for('update');

		if ((current?.version ?? 0) !== input.version) {
			throw new ConflictError(STALE);
		}

		if ((current?.priceKopecks ?? null) === input.price) {
			return;
		}

		const now = new Date();
		const by = ctx.user?.id ?? null;

		if (current === undefined) {
			// Две первые записи наперегонки: вторая наткнётся на первичный ключ,
			// и отвечать ей надо тем же «уже изменили», а не ошибкой базы.
			const inserted = await tx
				.insert(interactionTerms)
				.values({ interactionId: input.interactionId, priceKopecks: input.price, updatedBy: by })
				.onConflictDoNothing()
				.returning({ version: interactionTerms.version });

			if (inserted.length === 0) {
				throw new ConflictError(STALE);
			}
		} else {
			await tx
				.update(interactionTerms)
				.set({
					priceKopecks: input.price,
					version: current.version + 1,
					updatedBy: by,
					updatedAt: now
				})
				.where(
					and(
						eq(interactionTerms.interactionId, input.interactionId),
						eq(interactionTerms.version, current.version)
					)
				);
		}

		await recordAuditEvent(
			ctx,
			{
				type: 'interactions.updated',
				outcome: 'success',
				subject: { type: 'interaction', id: input.interactionId },
				details: { changedFields: ['price'] }
			},
			tx
		);
	});

	return readInteractionTerms(ctx, input.interactionId);
}
