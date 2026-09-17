/**
 * Ответственные за вуз.
 *
 * Назначение — строка `organization_responsibles`: вуз × пользователь ×
 * направление × период. Назначения не удаляются, а закрываются точной меткой
 * времени: две смены за один день обязаны выстроиться в историю, а отчёт за
 * прошлый период отвечает на вопрос «кто вёл вуз тогда», а не «кто ведёт
 * сейчас».
 *
 * На этих строках держится вся область доступа (`scopeFilter`), поэтому здесь
 * же живут её правила: один действующий ответственный на пару «вуз ×
 * направление», и общее назначение не сосуществует с назначениями по
 * направлениям. Второе уникальный индекс не выражает — `null` и значение для
 * него разные ключи, — поэтому правило держит сервис, и у него есть свой тест.
 *
 * Полностью — `docs/access-matrix.md`, раздел 2.
 */
import { alias } from 'drizzle-orm/pg-core';
import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getDb } from '../db';
import { directions, organizationResponsibles, organizations, users } from '../db/schema';
import { withTransaction } from '../db/transaction';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { requirePermission, scopeFilter } from '../rbac';

/** Назначение в том виде, в каком его показывает карточка вуза. */
export type ResponsibleView = {
	id: string;
	userId: string;
	userFullName: string;
	/** `null` — ответственный за вуз целиком. */
	directionId: string | null;
	directionName: string | null;
	validFrom: Date;
	/** `null` — назначение действует. */
	validTo: Date | null;
	assignedByFullName: string | null;
};

const assignedBy = alias(users, 'assigned_by_users');

const responsibleColumns = {
	id: organizationResponsibles.id,
	userId: organizationResponsibles.userId,
	userFullName: users.fullName,
	directionId: organizationResponsibles.directionId,
	directionName: directions.name,
	validFrom: organizationResponsibles.validFrom,
	validTo: organizationResponsibles.validTo,
	assignedByFullName: assignedBy.fullName
};

/**
 * Назначения вуза: сначала действующие, потом закрытые — от свежих к старым.
 *
 * Область здесь не применяется: список читают с карточки вуза, а карточку
 * область уже отфильтровала. Своё условие рядом с чужим означало бы два ответа
 * на вопрос «видно ли этот вуз».
 */
export async function listResponsibles(
	ctx: ActorContext,
	organizationId: string
): Promise<ResponsibleView[]> {
	requirePermission(ctx, 'organizations.read');

	return getDb()
		.select(responsibleColumns)
		.from(organizationResponsibles)
		.innerJoin(users, eq(users.id, organizationResponsibles.userId))
		.leftJoin(directions, eq(directions.id, organizationResponsibles.directionId))
		.leftJoin(assignedBy, eq(assignedBy.id, organizationResponsibles.assignedByUserId))
		.where(eq(organizationResponsibles.organizationId, organizationId))
		.orderBy(
			asc(sql`${organizationResponsibles.validTo} is not null`),
			desc(organizationResponsibles.validFrom)
		);
}

export type AssignResponsibleInput = {
	organizationId: string;
	userId: string;
	/** `null` — ответственный за вуз целиком. */
	directionId: string | null;
};

/**
 * Назначает ответственного: закрывает прежнее назначение на ту же пару «вуз ×
 * направление», если оно было, и открывает новое **тем же моментом**.
 *
 * Момент один на обе строки: иначе между ними осталась бы щель, в которую
 * попадает отчёт за период, и строка вуза оказалась бы ничьей.
 */
export async function assignResponsible(
	ctx: ActorContext,
	input: AssignResponsibleInput
): Promise<void> {
	await requirePermission(ctx, 'responsibles.manage', {
		type: 'directory.responsible_assigned',
		subject: { type: 'organization', id: input.organizationId }
	});

	await assertOrganizationAssignable(ctx, input.organizationId);
	await assertAssignable(ctx, input.userId);

	const db = getDb();

	if (input.directionId !== null) {
		const [direction] = await db
			.select({ id: directions.id })
			.from(directions)
			.where(eq(directions.id, input.directionId))
			.limit(1);

		if (direction === undefined) {
			throw new ValidationError('Ответственный не назначен', ['Направление не найдено']);
		}
	}

	const current = await db
		.select({
			id: organizationResponsibles.id,
			userId: organizationResponsibles.userId,
			directionId: organizationResponsibles.directionId
		})
		.from(organizationResponsibles)
		.where(
			and(
				eq(organizationResponsibles.organizationId, input.organizationId),
				isNull(organizationResponsibles.validTo)
			)
		);

	// Общее назначение и назначения по направлениям на одном вузе не
	// сосуществуют: пока есть строка без направления, по DevOps ответственных
	// стало бы двое, и правило «один действующий на направление» перестало бы
	// что-либо значить.
	const general = current.find((row) => row.directionId === null);

	if (input.directionId === null && current.some((row) => row.directionId !== null)) {
		throw new ConflictError(
			'У вуза есть ответственные по направлениям: снимите их, прежде чем назначать ответственного за вуз целиком'
		);
	}

	if (input.directionId !== null && general !== undefined) {
		throw new ConflictError(
			'У вуза есть ответственный за весь вуз: снимите его, прежде чем назначать по направлениям'
		);
	}

	const replaced = current.find((row) => row.directionId === input.directionId);

	if (replaced !== undefined && replaced.userId === input.userId) {
		throw new ConflictError('Этот сотрудник уже отвечает за вуз по этому направлению');
	}

	await withTransaction(ctx, async (tx) => {
		// Момент операции считает база: у неё и у приложения часы разные, а две
		// строки истории обязаны сойтись символ в символ. Значение возвращается
		// текстом и уходит обратно приведением: у драйвера для `now()` своего
		// разбора нет, а точность метки — микросекунды, которых у Date нет.
		const [{ at }] = await tx.execute<{ at: string }>(sql`select now()::text as at`);
		const moment = sql`${at}::timestamptz`;

		if (replaced !== undefined) {
			await tx
				.update(organizationResponsibles)
				.set({ validTo: moment, updatedAt: sql`now()` })
				.where(eq(organizationResponsibles.id, replaced.id));
		}

		await tx.insert(organizationResponsibles).values({
			organizationId: input.organizationId,
			userId: input.userId,
			directionId: input.directionId,
			validFrom: moment,
			assignedByUserId: ctx.user?.id ?? null
		});

		await recordAuditEvent(
			ctx,
			{
				type:
					replaced === undefined
						? 'directory.responsible_assigned'
						: 'directory.responsible_reassigned',
				outcome: 'success',
				subject: { type: 'organization', id: input.organizationId },
				details: {
					organizationId: input.organizationId,
					userId: input.userId,
					...(input.directionId === null ? {} : { directionId: input.directionId }),
					...(replaced === undefined ? {} : { previousUserId: replaced.userId })
				}
			},
			tx
		);
	});
}

/**
 * Снимает назначение без замены. Доступ прежнего ответственного пропадает в ту
 * же секунду: область считается подзапросом по действующим назначениям, а не
 * списком, собранным при входе.
 */
export async function releaseResponsible(ctx: ActorContext, responsibleId: string): Promise<void> {
	const db = getDb();

	const [row] = await db
		.select({
			id: organizationResponsibles.id,
			organizationId: organizationResponsibles.organizationId,
			userId: organizationResponsibles.userId,
			directionId: organizationResponsibles.directionId,
			validTo: organizationResponsibles.validTo
		})
		.from(organizationResponsibles)
		.where(eq(organizationResponsibles.id, responsibleId))
		.limit(1);

	if (row === undefined) {
		throw new NotFoundError('Назначение не найдено');
	}

	await requirePermission(ctx, 'responsibles.manage', {
		type: 'directory.responsible_released',
		subject: { type: 'organization', id: row.organizationId }
	});

	await assertOrganizationAssignable(ctx, row.organizationId);

	if (row.validTo !== null) {
		throw new ConflictError('Назначение уже закрыто');
	}

	await withTransaction(ctx, async (tx) => {
		await tx
			.update(organizationResponsibles)
			.set({ validTo: sql`now()`, updatedAt: sql`now()` })
			.where(eq(organizationResponsibles.id, row.id));

		await recordAuditEvent(
			ctx,
			{
				type: 'directory.responsible_released',
				outcome: 'success',
				subject: { type: 'organization', id: row.organizationId },
				details: {
					organizationId: row.organizationId,
					userId: row.userId,
					...(row.directionId === null ? {} : { directionId: row.directionId })
				}
			},
			tx
		);
	});
}

/**
 * Вуз, которым вызывающему разрешено распоряжаться.
 *
 * Руководитель раздаёт только вузы своей области — те, что уже ведут он или
 * его люди. Ответственного у организации-оператора и у вендоров не бывает
 * вовсе: назначить его им значило бы отдать кому-то все взаимодействия
 * продукта разом, потому что оператор стоит стороной почти везде.
 */
async function assertOrganizationAssignable(
	ctx: ActorContext,
	organizationId: string
): Promise<void> {
	const [row] = await getDb()
		.select({ id: organizations.id, kind: organizations.kind })
		.from(organizations)
		.where(and(eq(organizations.id, organizationId), scopeFilter(ctx, organizations.id)))
		.limit(1);

	// «Нет в области» и «нет вовсе» отвечаются одинаково: разный ответ выдал бы
	// существование чужого вуза.
	if (row === undefined) {
		throw new NotFoundError('Организация не найдена');
	}

	// Организация-оператор стоит стороной почти в каждом взаимодействии:
	// назначить на неё ответственного значило бы отдать ему все записи продукта
	// разом. Вендоры отдельным видом не заведены — им просто никогда не
	// назначают ответственного, и в область они не попадают именно поэтому.
	if (row.kind === 'operator') {
		throw new ValidationError('Ответственный не назначен', [
			'У организации-оператора ответственного не бывает: она сторона почти каждой записи'
		]);
	}
}

/**
 * Кого вызывающему разрешено назначать.
 *
 * Руководитель назначает своих подчинённых и себя — иначе он раздавал бы вузы
 * людям, работу которых потом не увидит. Область у него как раз и есть «я и
 * мои подчинённые», поэтому проверка сводится к ней. Администратор не ограничен
 * ничем.
 */
async function assertAssignable(ctx: ActorContext, userId: string): Promise<void> {
	const [account] = await getDb()
		.select({ id: users.id, isActive: users.isActive, roleId: users.roleId })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);

	if (account === undefined || !account.isActive) {
		throw new ValidationError('Ответственный не назначен', [
			'Сотрудник не найден или его запись выключена'
		]);
	}

	if (account.roleId === 'service') {
		throw new ValidationError('Ответственный не назначен', [
			'Машинный субъект не ведёт вузы: от его имени работают ключи обмена'
		]);
	}

	if (ctx.scope.kind === 'all') {
		return;
	}

	if (!ctx.scope.userIds.has(userId)) {
		throw new ForbiddenError(
			'Назначать можно себя и своих подчинённых: работу остальных вы всё равно не увидите'
		);
	}
}

/** Направление в выпадающем списке назначения. */
export type DirectionOption = { id: string; name: string };

/**
 * Направления для формы назначения. Каталог общий и областью не сужается:
 * направление — это разрез работы, а не чьё-то имущество.
 */
export async function listDirectionOptions(ctx: ActorContext): Promise<DirectionOption[]> {
	requirePermission(ctx, 'directions.read');

	return getDb()
		.select({ id: directions.id, name: directions.name })
		.from(directions)
		.orderBy(asc(directions.position));
}

/** Сотрудник в выпадающем списке назначения. */
export type AssignableUser = { id: string; fullName: string };

/**
 * Кого вызывающий может назначить: себя и своих подчинённых, а администратор —
 * весь штат. Список собирается по той же области, по которой потом откажет
 * {@link assignResponsible}: предлагать в форме то, что сервис не примет, —
 * значит обещать доступ, которого нет.
 */
export async function listAssignableUsers(ctx: ActorContext): Promise<AssignableUser[]> {
	requirePermission(ctx, 'responsibles.manage');

	const conditions = [eq(users.isActive, true), ne(users.roleId, 'service')];

	if (ctx.scope.kind !== 'all') {
		const ids = [...ctx.scope.userIds];

		if (ids.length === 0) {
			return [];
		}

		conditions.push(sql`${users.id} = any(${sql.param(ids)}::uuid[])`);
	}

	return getDb()
		.select({ id: users.id, fullName: users.fullName })
		.from(users)
		.where(and(...conditions))
		.orderBy(asc(users.fullName));
}
