/**
 * Запись справочников: организации и их площадки, люди и их роли, программы и
 * продукты.
 *
 * Три правила держат весь модуль. Первое: записи справочника не удаляются —
 * организация уходит в архив (`is_active = false`), роль человека закрывается
 * датой, программа получает новую версию. На них ссылаются взаимодействия и
 * документы, и задним числом «этого вуза у нас не было» быть не должно.
 * Второе: отказ по правам — это событие журнала, а не молчание. Третье:
 * уникальность проверяет база, а сервис переводит её нарушение в понятную
 * фразу — иначе гонка двух вкладок покажет человеку код PostgreSQL.
 */
import { and, eq, max, ne, sql } from 'drizzle-orm';
import type { AuditEventType } from '$lib/contracts/audit';
import type {
	AffiliationView,
	CreateAffiliationInput,
	CreateOrganizationInput,
	CreatePersonInput,
	CreateProductInput,
	CreateProgramInput,
	CreateProgramVersionInput,
	CreateSiteInput,
	EndAffiliationInput,
	OrganizationView,
	PersonView,
	ProductView,
	ProgramVersionView,
	ProgramView,
	SiteView,
	UpdateOrganizationInput,
	UpdatePersonInput,
	UpdateProductInput,
	UpdateProgramInput,
	UpdateSiteInput
} from '$lib/contracts/directory';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getDb } from '../db';
import {
	affiliations,
	organizations,
	people,
	products,
	programVersions,
	programs,
	sites
} from '../db/schema';
import { withTransaction, type Tx } from '../db/transaction';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { toPersonView } from '../people/serialize';
import { can, scopeFilter } from '../rbac';
import type { PermissionKey } from '../rbac/permissions';
import { findOrganizationByInn, getOrganization, getSite, toOrganizationView } from './read';

/**
 * Право на запись вместе со следом в журнале.
 *
 * Попытка изменить справочник без права — это то, о чём администратор должен
 * узнать: `requirePermission` бросил бы ошибку молча, а здесь отказ сначала
 * ложится в журнал. Пишется он отдельным соединением — транзакции ещё нет, и
 * начинать её ради записи об отказе незачем.
 */
async function requireWrite(
	ctx: ActorContext,
	permission: PermissionKey,
	type: AuditEventType,
	subject?: { type: string; id: string }
): Promise<void> {
	if (can(ctx, permission)) {
		return;
	}

	await recordAuditEvent(ctx, { type, outcome: 'denied', subject });

	throw new ForbiddenError(`Недостаточно прав: требуется «${permission}»`);
}

/** Поля, значение которых изменилось: их список идёт в журнал вместо значений. */
function changedFields<TRow extends object>(before: TRow, after: Partial<TRow>): string[] {
	return Object.keys(after).filter((key) => before[key as keyof TRow] !== after[key as keyof TRow]);
}

const UNIQUE_VIOLATION = '23505';

/**
 * Что человек должен прочитать вместо кода ограничения. Словарь закрыт: новое
 * ограничение уникальности заводится вместе со строкой отсюда, иначе гонка
 * покажет пятисотую вместо объяснения.
 */
const CONFLICT_BY_CONSTRAINT: Record<string, string> = {
	organizations_inn_key: 'Организация с таким ИНН уже заведена',
	organizations_external_ref_key: 'Эта запись внешней системы уже связана с другой организацией',
	sites_organization_name_key: 'У организации уже есть площадка с таким названием',
	sites_external_ref_key: 'Эта запись внешней системы уже связана с другой площадкой',
	programs_code_unique: 'Программа с таким кодом уже заведена',
	programs_external_ref_key: 'Эта запись внешней системы уже связана с другой программой',
	program_versions_program_version_key: 'Такая версия программы уже создана',
	products_code_unique: 'Продукт с таким кодом уже заведён',
	products_external_ref_key: 'Эта запись внешней системы уже связана с другим продуктом'
};

/** Имя нарушенного ограничения уникальности, если запрос упал именно на нём. */
function uniqueViolation(error: unknown): string | undefined {
	let current: unknown = error;

	while (current instanceof Error) {
		const candidate = current as { code?: unknown; constraint_name?: unknown };
		if (candidate.code === UNIQUE_VIOLATION && typeof candidate.constraint_name === 'string') {
			return candidate.constraint_name;
		}
		current = current.cause;
	}

	return undefined;
}

/**
 * Нарушение уникальности — это конфликт состояний, а не сбой: запись успела
 * появиться в соседней вкладке. Всё остальное летит дальше нетронутым.
 */
async function withUniqueConflicts<TResult>(run: () => Promise<TResult>): Promise<TResult> {
	try {
		return await run();
	} catch (error) {
		const constraint = uniqueViolation(error);
		const message = constraint === undefined ? undefined : CONFLICT_BY_CONSTRAINT[constraint];

		if (message === undefined) {
			throw error;
		}

		throw new ConflictError(message);
	}
}

/**
 * ИНН — ключ сверки с внешними справочниками, поэтому дубль по нему
 * отвергается до записи и с объяснением, какая организация его уже занимает.
 * Проверка идёт по всей базе, а не по области доступа: уникальный индекс тоже
 * не знает про области. А вот название чужой организации в ответ не попадает —
 * иначе перебором ИНН можно собрать справочник, закрытый областью доступа.
 */
async function assertInnIsFree(
	ctx: ActorContext,
	inn: string | null,
	exceptId?: string
): Promise<void> {
	if (inn === null) {
		return;
	}

	const db = getDb();
	const conditions = [eq(organizations.inn, inn)];

	if (exceptId !== undefined) {
		conditions.push(ne(organizations.id, exceptId));
	}

	const [clash] = await db
		.select({ id: organizations.id })
		.from(organizations)
		.where(and(...conditions))
		.limit(1);

	if (clash === undefined) {
		return;
	}

	const visible = await findOrganizationByInn(ctx, inn);

	throw new ConflictError(
		visible === null
			? `ИНН ${inn} уже занят другой организацией`
			: `ИНН ${inn} уже указан у организации «${visible.label}»`
	);
}

export async function createOrganization(
	ctx: ActorContext,
	input: CreateOrganizationInput
): Promise<OrganizationView> {
	await requireWrite(ctx, 'organizations.write', 'organizations.created');
	await assertInnIsFree(ctx, input.inn);

	return withUniqueConflicts(() =>
		withTransaction(ctx, async (tx) => {
			const [row] = await tx.insert(organizations).values(input).returning();

			await recordAuditEvent(
				ctx,
				{
					type: 'organizations.created',
					outcome: 'success',
					subject: { type: 'organization', id: row.id }
				},
				tx
			);

			return toOrganizationView(row);
		})
	);
}

export async function updateOrganization(
	ctx: ActorContext,
	input: UpdateOrganizationInput
): Promise<OrganizationView> {
	await requireWrite(ctx, 'organizations.write', 'organizations.updated', {
		type: 'organization',
		id: input.id
	});

	// Организация вне области доступа отдаётся как «не найдена» — тем же путём,
	// что и в чтении, чтобы перебор идентификаторов ничего не рассказывал.
	const before = await getOrganization(ctx, input.id);
	const { id, ...fields } = input;

	await assertInnIsFree(ctx, fields.inn, id);

	return withUniqueConflicts(() =>
		withTransaction(ctx, async (tx) => {
			const [row] = await tx
				.update(organizations)
				.set({ ...fields, updatedAt: sql`now()` })
				.where(eq(organizations.id, id))
				.returning();

			await recordAuditEvent(
				ctx,
				{
					type: 'organizations.updated',
					outcome: 'success',
					subject: { type: 'organization', id },
					details: { changedFields: changedFields(before, fields) }
				},
				tx
			);

			return toOrganizationView(row);
		})
	);
}

/**
 * Организация уходит в архив, а не удаляется: на неё ссылаются взаимодействия,
 * документы и роли людей, и «этого вуза у нас никогда не было» — неправда.
 */
export async function archiveOrganization(
	ctx: ActorContext,
	id: string
): Promise<OrganizationView> {
	await requireWrite(ctx, 'organizations.write', 'organizations.deactivated', {
		type: 'organization',
		id
	});

	const before = await getOrganization(ctx, id);

	if (!before.isActive) {
		throw new ConflictError('Организация уже в архиве');
	}

	return withTransaction(ctx, async (tx) => {
		const [row] = await tx
			.update(organizations)
			.set({ isActive: false, updatedAt: sql`now()` })
			.where(eq(organizations.id, id))
			.returning();

		await recordAuditEvent(
			ctx,
			{
				type: 'organizations.deactivated',
				outcome: 'success',
				subject: { type: 'organization', id }
			},
			tx
		);

		return toOrganizationView(row);
	});
}

function toSiteView(row: typeof sites.$inferSelect): SiteView {
	return {
		id: row.id,
		organizationId: row.organizationId,
		kind: row.kind,
		name: row.name,
		address: row.address,
		region: row.region
	};
}

export async function createSite(ctx: ActorContext, input: CreateSiteInput): Promise<SiteView> {
	await requireWrite(ctx, 'organizations.write', 'organizations.site_created', {
		type: 'organization',
		id: input.organizationId
	});

	await getOrganization(ctx, input.organizationId);

	return withUniqueConflicts(() =>
		withTransaction(ctx, async (tx) => {
			const [row] = await tx.insert(sites).values(input).returning();

			await recordAuditEvent(
				ctx,
				{
					type: 'organizations.site_created',
					outcome: 'success',
					subject: { type: 'site', id: row.id },
					details: { organizationId: row.organizationId }
				},
				tx
			);

			return toSiteView(row);
		})
	);
}

export async function updateSite(ctx: ActorContext, input: UpdateSiteInput): Promise<SiteView> {
	await requireWrite(ctx, 'organizations.write', 'organizations.site_updated', {
		type: 'site',
		id: input.id
	});

	const before = await getSite(ctx, input.id);
	const { id, ...fields } = input;

	// Площадку не переносят между организациями: на пару «площадка + её
	// организация» ссылаются роли людей, и перенос сделал бы эти ссылки ложью.
	if (fields.organizationId !== before.organizationId) {
		throw new ValidationError('Площадку нельзя перенести в другую организацию', [
			'Заведите площадку в нужной организации и закройте прежнюю'
		]);
	}

	return withUniqueConflicts(() =>
		withTransaction(ctx, async (tx) => {
			const [row] = await tx
				.update(sites)
				.set({ ...fields, updatedAt: sql`now()` })
				.where(eq(sites.id, id))
				.returning();

			await recordAuditEvent(
				ctx,
				{
					type: 'organizations.site_updated',
					outcome: 'success',
					subject: { type: 'site', id },
					details: {
						organizationId: row.organizationId,
						changedFields: changedFields(before, fields)
					}
				},
				tx
			);

			return toSiteView(row);
		})
	);
}

export async function createPerson(
	ctx: ActorContext,
	input: CreatePersonInput
): Promise<PersonView> {
	await requireWrite(ctx, 'people.write', 'people.created');

	return withTransaction(ctx, async (tx) => {
		const [row] = await tx.insert(people).values(input).returning();

		await recordAuditEvent(
			ctx,
			{ type: 'people.created', outcome: 'success', subject: { type: 'person', id: row.id } },
			tx
		);

		// Даже автор записи получает её обратно через сериализатор: право на
		// запись и право видеть контакты — разные права.
		return toPersonView(ctx, row);
	});
}

/**
 * Изменение человека переписывает запись целиком, поэтому требует и права
 * видеть контакты: иначе тот, кому они показаны замаскированными, сохранил бы
 * в базу «i***@vuz.ru» вместо адреса и стёр бы настоящий.
 */
export async function updatePerson(
	ctx: ActorContext,
	input: UpdatePersonInput
): Promise<PersonView> {
	await requireWrite(ctx, 'people.write', 'people.updated', { type: 'person', id: input.id });
	await requireWrite(ctx, 'people.read_pii', 'people.updated', { type: 'person', id: input.id });

	const { id, ...fields } = input;
	const db = getDb();

	const [before] = await db.select().from(people).where(eq(people.id, id)).limit(1);

	if (before === undefined) {
		throw new NotFoundError('Человек не найден');
	}

	return withTransaction(ctx, async (tx) => {
		const [row] = await tx
			.update(people)
			.set({ ...fields, updatedAt: sql`now()` })
			.where(eq(people.id, id))
			.returning();

		await recordAuditEvent(
			ctx,
			{
				type: 'people.updated',
				outcome: 'success',
				subject: { type: 'person', id },
				// В журнал попадают только имена изменённых полей: значения здесь —
				// персональные данные, а журнал неизменяем.
				details: { changedFields: changedFields(before, fields) }
			},
			tx
		);

		return toPersonView(ctx, row);
	});
}

async function toAffiliationView(
	ctx: ActorContext,
	tx: Tx,
	row: typeof affiliations.$inferSelect
): Promise<AffiliationView> {
	const [person] = await tx.select().from(people).where(eq(people.id, row.personId)).limit(1);

	if (person === undefined) {
		throw new NotFoundError('Человек не найден');
	}

	return {
		id: row.id,
		person: toPersonView(ctx, person),
		organizationId: row.organizationId,
		siteId: row.siteId,
		position: row.position,
		roleKind: row.roleKind,
		isPrimary: row.isPrimary,
		validFrom: row.validFrom,
		validTo: row.validTo,
		channel: row.channel
	};
}

/**
 * Роль человека в организации. Принадлежность площадки той же организации
 * проверяет составной внешний ключ — здесь она переводится в понятную фразу,
 * потому что выбрать чужую площадку легко, а код `23503` ничего не объясняет.
 */
export async function createAffiliation(
	ctx: ActorContext,
	input: CreateAffiliationInput
): Promise<AffiliationView> {
	await requireWrite(ctx, 'people.write', 'people.affiliation_created', {
		type: 'organization',
		id: input.organizationId
	});

	await getOrganization(ctx, input.organizationId);

	if (input.siteId !== null) {
		const site = await getSite(ctx, input.siteId);

		if (site.organizationId !== input.organizationId) {
			throw new ValidationError('Роль не сохранена', ['Площадка принадлежит другой организации']);
		}
	}

	return withTransaction(ctx, async (tx) => {
		const [row] = await tx.insert(affiliations).values(input).returning();

		await recordAuditEvent(
			ctx,
			{
				type: 'people.affiliation_created',
				outcome: 'success',
				subject: { type: 'affiliation', id: row.id },
				details: { personId: row.personId, organizationId: row.organizationId }
			},
			tx
		);

		return toAffiliationView(ctx, tx, row);
	});
}

/**
 * Закрытие периода полномочий. Роль остаётся в базе: взаимодействия, где этот
 * человек был контактом, обязаны помнить, кем он тогда был.
 */
export async function endAffiliation(
	ctx: ActorContext,
	input: EndAffiliationInput
): Promise<AffiliationView> {
	await requireWrite(ctx, 'people.write', 'people.affiliation_updated', {
		type: 'affiliation',
		id: input.id
	});

	const db = getDb();

	const [before] = await db
		.select()
		.from(affiliations)
		.where(and(eq(affiliations.id, input.id), scopeFilter(ctx, affiliations.organizationId)))
		.limit(1);

	if (before === undefined) {
		throw new NotFoundError('Роль не найдена');
	}

	if (before.validTo !== null) {
		throw new ConflictError(`Полномочия уже закрыты ${before.validTo}`);
	}

	if (input.validTo < before.validFrom) {
		throw new ValidationError('Полномочия не закрыты', [
			'Дата окончания не может быть раньше даты начала полномочий'
		]);
	}

	return withTransaction(ctx, async (tx) => {
		const [row] = await tx
			.update(affiliations)
			.set({ validTo: input.validTo, updatedAt: sql`now()` })
			.where(eq(affiliations.id, input.id))
			.returning();

		await recordAuditEvent(
			ctx,
			{
				type: 'people.affiliation_updated',
				outcome: 'success',
				subject: { type: 'affiliation', id: row.id },
				details: {
					personId: row.personId,
					organizationId: row.organizationId,
					changedFields: ['validTo']
				}
			},
			tx
		);

		return toAffiliationView(ctx, tx, row);
	});
}

function toProgramView(row: typeof programs.$inferSelect): ProgramView {
	return {
		id: row.id,
		code: row.code,
		name: row.name,
		level: row.level,
		directionCode: row.directionCode,
		status: row.status
	};
}

export async function createProgram(
	ctx: ActorContext,
	input: CreateProgramInput
): Promise<ProgramView> {
	await requireWrite(ctx, 'programs.write', 'programs.created');

	return withUniqueConflicts(() =>
		withTransaction(ctx, async (tx) => {
			const [row] = await tx.insert(programs).values(input).returning();

			await recordAuditEvent(
				ctx,
				{
					type: 'programs.created',
					outcome: 'success',
					subject: { type: 'program', id: row.id }
				},
				tx
			);

			return toProgramView(row);
		})
	);
}

export async function updateProgram(
	ctx: ActorContext,
	input: UpdateProgramInput
): Promise<ProgramView> {
	await requireWrite(ctx, 'programs.write', 'programs.updated', {
		type: 'program',
		id: input.id
	});

	const { id, ...fields } = input;
	const db = getDb();

	const [before] = await db.select().from(programs).where(eq(programs.id, id)).limit(1);

	if (before === undefined) {
		throw new NotFoundError('Программа не найдена');
	}

	// Уход в архив — отдельное событие журнала: по нему отвечают на вопрос
	// «когда программу перестали предлагать», а не листают все правки подряд.
	const archived = fields.status === 'archived' && before.status !== 'archived';

	return withUniqueConflicts(() =>
		withTransaction(ctx, async (tx) => {
			const [row] = await tx
				.update(programs)
				.set({ ...fields, updatedAt: sql`now()` })
				.where(eq(programs.id, id))
				.returning();

			await recordAuditEvent(
				ctx,
				{
					type: archived ? 'programs.archived' : 'programs.updated',
					outcome: 'success',
					subject: { type: 'program', id },
					details: { changedFields: changedFields(before, fields) }
				},
				tx
			);

			return toProgramView(row);
		})
	);
}

/**
 * Новая версия программы. Номер считается внутри транзакции по строке
 * программы, взятой `for update`: без блокировки две одновременные версии
 * получили бы один номер и разошлись бы только на уникальном индексе.
 */
export async function addProgramVersion(
	ctx: ActorContext,
	input: CreateProgramVersionInput
): Promise<ProgramVersionView> {
	await requireWrite(ctx, 'programs.write', 'programs.version_created', {
		type: 'program',
		id: input.programId
	});

	return withUniqueConflicts(() =>
		withTransaction(ctx, async (tx) => {
			const [program] = await tx
				.select({ id: programs.id })
				.from(programs)
				.where(eq(programs.id, input.programId))
				.for('update')
				.limit(1);

			if (program === undefined) {
				throw new NotFoundError('Программа не найдена');
			}

			const [current] = await tx
				.select({ value: max(programVersions.version) })
				.from(programVersions)
				.where(eq(programVersions.programId, input.programId));

			const [row] = await tx
				.insert(programVersions)
				.values({
					programId: input.programId,
					version: (current?.value ?? 0) + 1,
					summary: input.summary,
					effectiveFrom: input.effectiveFrom,
					createdBy: ctx.user?.id ?? null
				})
				.returning();

			await recordAuditEvent(
				ctx,
				{
					type: 'programs.version_created',
					outcome: 'success',
					subject: { type: 'program_version', id: row.id },
					details: { programId: row.programId }
				},
				tx
			);

			return {
				id: row.id,
				programId: row.programId,
				version: row.version,
				summary: row.summary,
				effectiveFrom: row.effectiveFrom,
				createdAt: row.createdAt
			};
		})
	);
}

function toProductView(row: typeof products.$inferSelect): ProductView {
	return {
		id: row.id,
		code: row.code,
		name: row.name,
		vendorOrganizationId: row.vendorOrganizationId,
		description: row.description,
		status: row.status
	};
}

export async function createProduct(
	ctx: ActorContext,
	input: CreateProductInput
): Promise<ProductView> {
	await requireWrite(ctx, 'products.write', 'products.created');

	if (input.vendorOrganizationId !== null) {
		await getOrganization(ctx, input.vendorOrganizationId);
	}

	return withUniqueConflicts(() =>
		withTransaction(ctx, async (tx) => {
			const [row] = await tx.insert(products).values(input).returning();

			await recordAuditEvent(
				ctx,
				{
					type: 'products.created',
					outcome: 'success',
					subject: { type: 'product', id: row.id }
				},
				tx
			);

			return toProductView(row);
		})
	);
}

export async function updateProduct(
	ctx: ActorContext,
	input: UpdateProductInput
): Promise<ProductView> {
	await requireWrite(ctx, 'products.write', 'products.updated', {
		type: 'product',
		id: input.id
	});

	const { id, ...fields } = input;
	const db = getDb();

	const [before] = await db.select().from(products).where(eq(products.id, id)).limit(1);

	if (before === undefined) {
		throw new NotFoundError('Продукт не найден');
	}

	if (fields.vendorOrganizationId !== null) {
		await getOrganization(ctx, fields.vendorOrganizationId);
	}

	const archived = fields.status === 'archived' && before.status !== 'archived';

	return withUniqueConflicts(() =>
		withTransaction(ctx, async (tx) => {
			const [row] = await tx
				.update(products)
				.set({ ...fields, updatedAt: sql`now()` })
				.where(eq(products.id, id))
				.returning();

			await recordAuditEvent(
				ctx,
				{
					type: archived ? 'products.archived' : 'products.updated',
					outcome: 'success',
					subject: { type: 'product', id },
					details: { changedFields: changedFields(before, fields) }
				},
				tx
			);

			return toProductView(row);
		})
	);
}
