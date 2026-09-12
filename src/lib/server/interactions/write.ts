/**
 * Заведение и правка взаимодействия.
 *
 * Взаимодействие не существует вне маршрута: оно создаётся сразу на первой
 * стадии, в той же транзакции. Запись без стадии — это запись, про которую
 * нельзя сказать, что с ней происходит, и появляться она не должна даже на
 * мгновение.
 *
 * Правка плана попадает в предметную историю (`interaction_changes`): сдвиг
 * сроков и смена ответственного — это решения, и они обязаны быть объяснимы
 * рядом с полем, а не только в журнале действий службы безопасности.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
	createInteractionSchema,
	updateInteractionSchema,
	type CreateInteractionInput,
	type InteractionView,
	type UpdateInteractionInput
} from '$lib/contracts/interactions';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import {
	affiliations,
	interactionChanges,
	interactionParties,
	interactionPartySites,
	interactionProducts,
	interactionPrograms,
	interactions,
	organizations,
	sites,
	stageRoutes,
	users
} from '../db/schema';
import { withTransaction, type Tx } from '../db/transaction';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { requirePermission, scopeFilter } from '../rbac';
import { startInteractionIn } from '../stages/commands';
import { interactionScopeFilter } from './access';
import { getInteraction } from './read';

/** Момент, который ставит база: часы приложения и базы могут расходиться. */
const now = sql`now()`;

type PartyInput = CreateInteractionInput['parties'][number];

function parseCreate(input: CreateInteractionInput): CreateInteractionInput {
	const parsed = createInteractionSchema.safeParse(input);

	if (!parsed.success) {
		throw new ValidationError(
			'Взаимодействие не прошло проверку',
			parsed.error.issues.map((issue) => issue.message)
		);
	}

	return parsed.data;
}

/**
 * Маршрут, на который можно поставить взаимодействие. Черновик нельзя: его
 * стадии ещё могут измениться, а слепок уже был бы сделан.
 */
async function assertRoutePublished(tx: Tx, routeId: string): Promise<void> {
	const [route] = await tx
		.select({ publishedAt: stageRoutes.publishedAt })
		.from(stageRoutes)
		.where(eq(stageRoutes.id, routeId))
		.limit(1);

	if (route === undefined) {
		throw new ValidationError('Маршрут стадий не найден', ['Выберите существующий маршрут']);
	}

	if (route.publishedAt === null) {
		throw new ConflictError('Маршрут ещё не опубликован: на него нельзя поставить взаимодействие');
	}
}

/** Все стороны — существующие организации из области доступа вызывающего. */
async function assertPartiesAllowed(
	ctx: ActorContext,
	tx: Tx,
	parties: PartyInput[]
): Promise<void> {
	const organizationIds = parties.map((party) => party.organizationId);

	const rows = await tx
		.select({ id: organizations.id })
		.from(organizations)
		.where(and(inArray(organizations.id, organizationIds), scopeFilter(ctx, organizations.id)));

	const found = new Set(rows.map((row) => row.id));
	const missing = organizationIds.filter((id) => !found.has(id));

	if (missing.length > 0) {
		// Организация вне области доступа неотличима от несуществующей: иначе
		// перебором идентификаторов можно узнать, что существует за её пределами.
		throw new NotFoundError('Организация-участник не найдена');
	}

	for (const party of parties) {
		if (party.contactAffiliationId !== null) {
			const [affiliation] = await tx
				.select({ organizationId: affiliations.organizationId })
				.from(affiliations)
				.where(eq(affiliations.id, party.contactAffiliationId))
				.limit(1);

			if (affiliation === undefined || affiliation.organizationId !== party.organizationId) {
				throw new ValidationError('Контактное лицо не относится к этой организации', [
					'Выберите контакт из ролей выбранной организации'
				]);
			}
		}

		if (party.siteIds.length > 0) {
			const siteRows = await tx
				.select({ id: sites.id })
				.from(sites)
				.where(
					and(inArray(sites.id, party.siteIds), eq(sites.organizationId, party.organizationId))
				);

			if (siteRows.length !== new Set(party.siteIds).size) {
				throw new ValidationError('Площадка не относится к этой организации', [
					'Выберите площадки выбранной организации'
				]);
			}
		}
	}
}

async function assertOwnerExists(tx: Tx, ownerUserId: string): Promise<void> {
	const [owner] = await tx
		.select({ id: users.id })
		.from(users)
		.where(and(eq(users.id, ownerUserId), eq(users.isActive, true)))
		.limit(1);

	if (owner === undefined) {
		throw new ValidationError('Ответственный не найден', [
			'Выберите действующего пользователя системы'
		]);
	}
}

/** Стороны, программы и продукты одного взаимодействия — списками целиком. */
async function writeRelations(
	tx: Tx,
	interactionId: string,
	input: CreateInteractionInput
): Promise<void> {
	for (const party of input.parties) {
		const [row] = await tx
			.insert(interactionParties)
			.values({
				interactionId,
				organizationId: party.organizationId,
				partyRole: party.partyRole,
				isPrimary: party.isPrimary,
				contactAffiliationId: party.contactAffiliationId
			})
			.returning({ id: interactionParties.id });

		if (party.siteIds.length > 0) {
			await tx
				.insert(interactionPartySites)
				.values(party.siteIds.map((siteId) => ({ partyId: row.id, siteId })));
		}
	}

	if (input.programs.length > 0) {
		await tx.insert(interactionPrograms).values(
			input.programs.map((program) => ({
				interactionId,
				programId: program.programId,
				programVersionId: program.programVersionId
			}))
		);
	}

	if (input.productIds.length > 0) {
		await tx
			.insert(interactionProducts)
			.values(input.productIds.map((productId) => ({ interactionId, productId })));
	}
}

export async function createInteraction(
	ctx: ActorContext,
	input: CreateInteractionInput
): Promise<InteractionView> {
	requirePermission(ctx, 'interactions.write');

	const definition = parseCreate(input);

	const interactionId = await withTransaction(ctx, async (tx) => {
		await assertRoutePublished(tx, definition.routeId);
		await assertPartiesAllowed(ctx, tx, definition.parties);
		await assertOwnerExists(tx, definition.ownerUserId);

		const [created] = await tx
			.insert(interactions)
			.values({
				title: definition.title,
				routeId: definition.routeId,
				agreementPeriodStart: definition.agreementPeriodStart,
				agreementPeriodEnd: definition.agreementPeriodEnd,
				academicPeriodStart: definition.academicPeriodStart,
				academicPeriodEnd: definition.academicPeriodEnd,
				ownerUserId: definition.ownerUserId,
				externalSource: definition.externalSource,
				externalId: definition.externalId
			})
			.returning({ id: interactions.id, routeId: interactions.routeId });

		await writeRelations(tx, created.id, definition);

		await recordAuditEvent(
			ctx,
			{
				type: 'interactions.created',
				outcome: 'success',
				subject: { type: 'interaction', id: created.id },
				details: { routeId: definition.routeId }
			},
			tx
		);

		// Взаимодействие начинает путь сразу: запись, которая ни на какой стадии
		// не стоит, не отвечает на вопрос «что с ней происходит».
		await startInteractionIn(ctx, tx, {
			id: created.id,
			routeId: created.routeId,
			ownerUserId: definition.ownerUserId
		});

		return created.id;
	});

	return getInteraction(ctx, interactionId);
}

/** Что поменялось в плане: имя поля контракта и два значения. */
type FieldChange = { field: string; oldValue: unknown; newValue: unknown };

function scalarChanges(
	before: typeof interactions.$inferSelect,
	after: UpdateInteractionInput
): FieldChange[] {
	const candidates: FieldChange[] = [
		{ field: 'title', oldValue: before.title, newValue: after.title },
		{
			field: 'agreementPeriodStart',
			oldValue: before.agreementPeriodStart,
			newValue: after.agreementPeriodStart
		},
		{
			field: 'agreementPeriodEnd',
			oldValue: before.agreementPeriodEnd,
			newValue: after.agreementPeriodEnd
		},
		{
			field: 'academicPeriodStart',
			oldValue: before.academicPeriodStart,
			newValue: after.academicPeriodStart
		},
		{
			field: 'academicPeriodEnd',
			oldValue: before.academicPeriodEnd,
			newValue: after.academicPeriodEnd
		},
		{ field: 'ownerUserId', oldValue: before.ownerUserId, newValue: after.ownerUserId }
	];

	return candidates.filter((change) => change.oldValue !== change.newValue);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
	const a = [...left].sort();
	const b = [...right].sort();

	return a.length === b.length && a.every((value, index) => value === b[index]);
}

export async function updateInteraction(
	ctx: ActorContext,
	input: UpdateInteractionInput
): Promise<InteractionView> {
	requirePermission(ctx, 'interactions.write');

	const parsed = updateInteractionSchema.safeParse(input);

	if (!parsed.success) {
		throw new ValidationError(
			'Взаимодействие не прошло проверку',
			parsed.error.issues.map((issue) => issue.message)
		);
	}

	const definition = parsed.data;
	const authorId = ctx.user?.id ?? null;

	await withTransaction(ctx, async (tx) => {
		const [before] = await tx
			.select()
			.from(interactions)
			.where(and(eq(interactions.id, definition.id), interactionScopeFilter(ctx)))
			.for('update');

		if (before === undefined) {
			throw new NotFoundError('Взаимодействие не найдено');
		}

		// Маршрут менять нельзя: пройденные стадии ссылаются на его версию, и
		// подмена маршрута превратила бы историю в набор чужих записей.
		if (before.routeId !== definition.routeId) {
			throw new ConflictError('Маршрут взаимодействия изменить нельзя');
		}

		await assertPartiesAllowed(ctx, tx, definition.parties);
		await assertOwnerExists(tx, definition.ownerUserId);

		const previousParties = await tx
			.select({
				organizationId: interactionParties.organizationId,
				partyRole: interactionParties.partyRole
			})
			.from(interactionParties)
			.where(eq(interactionParties.interactionId, definition.id));

		const previousPrograms = await tx
			.select({ programId: interactionPrograms.programId })
			.from(interactionPrograms)
			.where(eq(interactionPrograms.interactionId, definition.id));

		const previousProducts = await tx
			.select({ productId: interactionProducts.productId })
			.from(interactionProducts)
			.where(eq(interactionProducts.interactionId, definition.id));

		const changes = scalarChanges(before, definition);

		if (
			!sameSet(
				previousParties.map((party) => party.organizationId),
				definition.parties.map((party) => party.organizationId)
			)
		) {
			changes.push({
				field: 'parties',
				oldValue: previousParties,
				newValue: definition.parties.map((party) => ({
					organizationId: party.organizationId,
					partyRole: party.partyRole
				}))
			});
		}

		if (
			!sameSet(
				previousPrograms.map((program) => program.programId),
				definition.programs.map((program) => program.programId)
			)
		) {
			changes.push({
				field: 'programs',
				oldValue: previousPrograms.map((program) => program.programId),
				newValue: definition.programs.map((program) => program.programId)
			});
		}

		if (
			!sameSet(
				previousProducts.map((product) => product.productId),
				definition.productIds
			)
		) {
			changes.push({
				field: 'products',
				oldValue: previousProducts.map((product) => product.productId),
				newValue: definition.productIds
			});
		}

		await tx
			.update(interactions)
			.set({
				title: definition.title,
				agreementPeriodStart: definition.agreementPeriodStart,
				agreementPeriodEnd: definition.agreementPeriodEnd,
				academicPeriodStart: definition.academicPeriodStart,
				academicPeriodEnd: definition.academicPeriodEnd,
				ownerUserId: definition.ownerUserId,
				externalSource: definition.externalSource,
				externalId: definition.externalId,
				lastActivityAt: now,
				updatedAt: now
			})
			.where(eq(interactions.id, definition.id));

		// Стороны, программы и продукты переписываются целиком: точечная правка
		// связующих таблиц из формы, которая присылает итоговый список, — это
		// вторая модель того же состояния. Площадки сторон уходят каскадом.
		await tx.delete(interactionParties).where(eq(interactionParties.interactionId, definition.id));
		await tx
			.delete(interactionPrograms)
			.where(eq(interactionPrograms.interactionId, definition.id));
		await tx
			.delete(interactionProducts)
			.where(eq(interactionProducts.interactionId, definition.id));

		await writeRelations(tx, definition.id, definition);

		// У записи истории есть автор, и это человек: фоновая правка (импорт,
		// миграция данных) остаётся в журнале действий, но в предметную историю
		// плана не попадает — приписывать её «системе» значило бы утверждать,
		// что решение принял кто-то, кого не существует.
		if (changes.length > 0 && authorId !== null) {
			await tx.insert(interactionChanges).values(
				changes.map((change) => ({
					interactionId: definition.id,
					authorId,
					field: change.field,
					oldValue: change.oldValue,
					newValue: change.newValue,
					reason: definition.reason
				}))
			);
		}

		await recordAuditEvent(
			ctx,
			{
				type: 'interactions.updated',
				outcome: 'success',
				subject: { type: 'interaction', id: definition.id },
				details: { changedFields: changes.map((change) => change.field) }
			},
			tx
		);
	});

	return getInteraction(ctx, definition.id);
}
