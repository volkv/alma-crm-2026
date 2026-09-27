/**
 * Смена контактного лица стороны из карточки взаимодействия.
 *
 * Контакт выбирают при заведении, но на стадии поиска контактных лиц его и
 * находят: человек, с которым говорили вначале, уходит, на его место
 * приходит другой. Правка плана переписывает стороны целиком по форме плана,
 * а здесь меняется одно поле одной стороны — поэтому команда своя.
 *
 * Правило то же, что у правки плана: право на запись взаимодействия, область
 * доступа (чужая запись — «не найдено»), версия правки под блокировкой строки,
 * строка предметной истории с причиной и событие журнала. Новый контакт —
 * действующая роль организации этой стороны: роль другой организации или
 * закончившаяся роль — отказ, а не тихая запись.
 */
import { and, eq, sql } from 'drizzle-orm';
import {
	changeInteractionContactSchema,
	type ChangeInteractionContactDraft
} from '$lib/contracts/interactions';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { affiliations, interactionChanges, interactionParties, interactions } from '../db/schema';
import { withTransaction } from '../db/transaction';
import { currentAffiliationFilter } from '../directory/affiliation-current';
import { NotFoundError, ValidationError } from '../errors';
import { publishAfterCommit } from '../live/publish';
import { requirePermission } from '../rbac';
import { interactionScopeFilter } from './access';
import { assertEditVersion, editorOf, nextEdit } from './edit-version';

/** Момент, который ставит база: часы приложения и базы могут расходиться. */
const now = sql`now()`;

export async function changeInteractionContact(
	ctx: ActorContext,
	input: ChangeInteractionContactDraft
): Promise<void> {
	// То же право, что даёт карточке действие «изменить».
	requirePermission(ctx, 'interactions.write');

	const parsed = changeInteractionContactSchema.safeParse(input);

	if (!parsed.success) {
		throw new ValidationError(
			'Контактное лицо не прошло проверку',
			parsed.error.issues.map((issue) => issue.message)
		);
	}

	const command = parsed.data;
	const authorId = ctx.user?.id ?? null;

	await withTransaction(ctx, async (tx) => {
		const [interaction] = await tx
			.select()
			.from(interactions)
			.where(and(eq(interactions.id, command.interactionId), interactionScopeFilter(ctx)))
			.for('update');

		if (interaction === undefined) {
			throw new NotFoundError('Взаимодействие не найдено');
		}

		await assertEditVersion(tx, interaction, command.editVersion);

		const [party] = await tx
			.select({
				id: interactionParties.id,
				organizationId: interactionParties.organizationId,
				contactAffiliationId: interactionParties.contactAffiliationId
			})
			.from(interactionParties)
			.where(
				and(
					eq(interactionParties.id, command.partyId),
					eq(interactionParties.interactionId, command.interactionId)
				)
			)
			.limit(1);

		if (party === undefined) {
			throw new NotFoundError('Сторона взаимодействия не найдена');
		}

		if (command.contactAffiliationId !== null) {
			// Действующая — без даты окончания или с ещё не прошедшей: так же «текущие» и «прежние»
			// роли делит карточка организации.
			const [affiliation] = await tx
				.select({ id: affiliations.id })
				.from(affiliations)
				.where(
					and(
						eq(affiliations.id, command.contactAffiliationId),
						eq(affiliations.organizationId, party.organizationId),
						currentAffiliationFilter()
					)
				)
				.limit(1);

			if (affiliation === undefined) {
				throw new ValidationError('Контактное лицо не относится к этой организации', [
					'Выберите человека из действующих ролей организации'
				]);
			}
		}

		// Тот же контакт — не правка: версия не сдвигается, и коллега с
		// открытой формой плана не получит отказа из-за пустого действия.
		if (party.contactAffiliationId === command.contactAffiliationId) {
			return;
		}

		await tx
			.update(interactionParties)
			.set({ contactAffiliationId: command.contactAffiliationId, updatedAt: now })
			.where(eq(interactionParties.id, party.id));

		await tx
			.update(interactions)
			.set({
				...nextEdit(interactions.editVersion, editorOf(ctx)),
				lastActivityAt: now,
				updatedAt: now
			})
			.where(eq(interactions.id, interaction.id));

		// Автор истории — человек, как у правки плана: правка без него остаётся
		// только в журнале действий.
		if (authorId !== null) {
			await tx.insert(interactionChanges).values({
				interactionId: interaction.id,
				authorId,
				field: 'contact',
				oldValue: party.contactAffiliationId,
				newValue: command.contactAffiliationId,
				reason: command.reason
			});
		}

		await recordAuditEvent(
			ctx,
			{
				type: 'interactions.contact_changed',
				outcome: 'success',
				subject: { type: 'interaction', id: interaction.id },
				// Снятый контакт — событие без `affiliationId`: пустых ссылок
				// журнал не принимает.
				details:
					command.contactAffiliationId === null
						? { partyId: party.id }
						: { partyId: party.id, affiliationId: command.contactAffiliationId }
			},
			tx
		);

		publishAfterCommit(tx, interaction.id, { type: 'interaction.changed' });
	});
}
