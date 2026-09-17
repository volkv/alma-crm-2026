/**
 * Заведение и правка взаимодействия.
 *
 * Взаимодействие не существует вне процесса: оно создаётся сразу на первой
 * стадии действующей редакции своей группы, в той же транзакции. Запись без
 * стадии — это запись, про которую нельзя сказать, что с ней происходит, и
 * появляться она не должна даже на мгновение.
 *
 * Группу человек не выбирает: она выводится из вида основной стороны по
 * единственной таблице соответствий. Редакция читается внутри транзакции под
 * разделяемой блокировкой группы — иначе запись, созданная в миллисекунду
 * публикации, встала бы на стадию редакции, которая уже не действует.
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
	users
} from '../db/schema';
import { withTransaction, type Tx } from '../db/transaction';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { requirePermission, scopeFilter } from '../rbac';
import { startInteractionIn } from '../stages/commands';
import { lockGroup, requireActiveRevision, resolveProcessGroup } from '../stages/process';
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
 * Основная сторона взаимодействия — та, с которой ведётся процесс.
 *
 * Схема контракта требует ровно одну такую сторону; здесь остаётся снять
 * неопределённость типа, и делается это в одном месте: от основной стороны
 * зависят и группа процесса, и область доступа, и разойтись в ответе на вопрос
 * «кто здесь основной» эти две проверки не должны.
 */
function requirePrimaryParty(parties: PartyInput[]): PartyInput {
	const primary = parties.find((party) => party.isPrimary);

	if (primary === undefined) {
		throw new ValidationError('У взаимодействия нет основной стороны', [
			'Отметьте организацию, с которой ведётся процесс'
		]);
	}

	return primary;
}

/**
 * Группа процесса взаимодействия — по виду основной стороны.
 *
 * Выбора из списка нет намеренно: ответ известен из данных, а список был бы
 * лишней возможностью ошибиться. Организация читается в той же транзакции, что
 * и запись, — вид основной стороны и группа обязаны совпасть.
 */
async function resolveGroupForParties(tx: Tx, parties: PartyInput[]): Promise<string> {
	const primary = requirePrimaryParty(parties);

	const [organization] = await tx
		.select({ kind: organizations.kind })
		.from(organizations)
		.where(eq(organizations.id, primary.organizationId))
		.limit(1);

	if (organization === undefined) {
		throw new NotFoundError('Организация-участник не найдена');
	}

	return (await resolveProcessGroup(tx, organization.kind)).id;
}

/**
 * Все стороны существуют, и основная из них — в области доступа вызывающего.
 *
 * Область спрашивается только с основной стороны — ровно так же, как считается
 * видимость записи (`docs/access-matrix.md`, раздел 1). Плательщик и
 * организация-оператор стоят сторонами почти везде, ответственного у них не
 * бывает вовсе, и потребовать их в области значило бы запретить менеджеру
 * завести запись по самому обычному образцу: вуз, заказчик, оператор.
 */
async function assertPartiesAllowed(
	ctx: ActorContext,
	tx: Tx,
	parties: PartyInput[]
): Promise<void> {
	const organizationIds = parties.map((party) => party.organizationId);
	const primary = requirePrimaryParty(parties);

	const rows = await tx
		.select({ id: organizations.id })
		.from(organizations)
		.where(inArray(organizations.id, organizationIds));

	const found = new Set(rows.map((row) => row.id));
	const missing = organizationIds.filter((id) => !found.has(id));

	if (missing.length > 0) {
		throw new NotFoundError('Организация-участник не найдена');
	}

	const [primaryInScope] = await tx
		.select({ id: organizations.id })
		.from(organizations)
		.where(and(eq(organizations.id, primary.organizationId), scopeFilter(ctx, organizations.id)))
		.limit(1);

	if (primaryInScope === undefined) {
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

/**
 * Заведение взаимодействия внутри уже открытой транзакции. Возвращает
 * идентификатор, а не представление: собрать представление можно только после
 * фиксации — до неё записи нет ни для одного другого соединения.
 *
 * Отдельной функцией по тому же образцу, что `startInteractionIn`: транзакцию
 * открывает тот, кто отвечает за операцию целиком, а заявка с сайта заводит
 * организацию, человека, его роль и взаимодействие одной операцией.
 */
export async function createInteractionIn(
	ctx: ActorContext,
	tx: Tx,
	input: CreateInteractionInput
): Promise<string> {
	requirePermission(ctx, 'interactions.write');

	const definition = parseCreate(input);

	await assertPartiesAllowed(ctx, tx, definition.parties);
	await assertOwnerExists(tx, definition.ownerUserId);

	const groupId = await resolveGroupForParties(tx, definition.parties);
	// Разделяемая блокировка группы: пока публикация держит исключительную,
	// создание ждёт, — и наоборот. Так первая стадия берётся из той редакции,
	// которая действует после обеих операций, а не между ними.
	const group = await lockGroup(tx, groupId, 'share');
	const revision = await requireActiveRevision(tx, group);

	const [created] = await tx
		.insert(interactions)
		.values({
			title: definition.title,
			processGroupId: group.id,
			agreementPeriodStart: definition.agreementPeriodStart,
			agreementPeriodEnd: definition.agreementPeriodEnd,
			academicPeriodStart: definition.academicPeriodStart,
			academicPeriodEnd: definition.academicPeriodEnd,
			ownerUserId: definition.ownerUserId,
			externalSource: definition.externalSource,
			externalId: definition.externalId
		})
		.returning({ id: interactions.id, processGroupId: interactions.processGroupId });

	await writeRelations(tx, created.id, definition);

	await recordAuditEvent(
		ctx,
		{
			type: 'interactions.created',
			outcome: 'success',
			subject: { type: 'interaction', id: created.id },
			details: { processGroupKey: group.key, revisionId: revision.id }
		},
		tx
	);

	// Взаимодействие начинает путь сразу: запись, которая ни на какой стадии
	// не стоит, не отвечает на вопрос «что с ней происходит».
	await startInteractionIn(
		ctx,
		tx,
		{
			id: created.id,
			processGroupId: created.processGroupId,
			ownerUserId: definition.ownerUserId
		},
		revision
	);

	return created.id;
}

export async function createInteraction(
	ctx: ActorContext,
	input: CreateInteractionInput
): Promise<InteractionView> {
	const interactionId = await withTransaction(ctx, (tx) => createInteractionIn(ctx, tx, input));

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

		await assertPartiesAllowed(ctx, tx, definition.parties);
		await assertOwnerExists(tx, definition.ownerUserId);

		// Группа выводится из вида основной стороны и меняется только вместе с
		// ней; смена группы у идущего взаимодействия — это начало другого
		// процесса, и такое взаимодействие закрывают, а не переписывают.
		const groupId = await resolveGroupForParties(tx, definition.parties);

		if (groupId !== before.processGroupId) {
			throw new ConflictError(
				'Смена основной стороны меняет процесс: закройте это взаимодействие и заведите новое'
			);
		}

		// Передать чужую работу себе — не то же самое, что вести свою: смену
		// владельца разрешает отдельное право, и проверяется оно во всех
		// командах, которые её делают, а не только в той, что названа «передать».
		if (before.ownerUserId !== definition.ownerUserId) {
			requirePermission(ctx, 'interactions.reassign');
		}

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

		// Смена владельца отмечается своим событием, а не строкой в списке
		// изменённых полей: «кто отвечает за эту работу» ищут по коду события.
		if (before.ownerUserId !== definition.ownerUserId) {
			await recordAuditEvent(
				ctx,
				{
					type: 'interactions.owner_changed',
					outcome: 'success',
					subject: { type: 'interaction', id: definition.id },
					details: { userId: definition.ownerUserId }
				},
				tx
			);
		}
	});

	return getInteraction(ctx, definition.id);
}
