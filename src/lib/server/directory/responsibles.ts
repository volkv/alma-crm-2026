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
import { and, asc, desc, eq, exists, isNull, ne, sql } from 'drizzle-orm';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getDb } from '../db';
import {
	directions,
	interactionParties,
	interactionProducts,
	interactionPrograms,
	interactions,
	organizationResponsibles,
	organizations,
	productDirections,
	programs,
	users
} from '../db/schema';
import { withTransaction, type Tx } from '../db/transaction';

/** Кто выполняет запрос: транзакция вызывающего или общий пул. */
type Executor = Tx | ReturnType<typeof getDb>;
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { requirePermission, scopeFilter } from '../rbac';
import { setResponsible } from '../stages/commands';

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
	/**
	 * Передать новому ответственному незавершённые взаимодействия прежнего.
	 *
	 * Работает только при замене: при первом назначении передавать нечего, а
	 * снятие без замены (`releaseResponsible`) не двигает работу вовсе — некому.
	 * Требует права `interactions.reassign`, потому что это та же передача
	 * работы, что и с карточки взаимодействия, только списком.
	 */
	transferInteractions: boolean;
};

/**
 * Незавершённые взаимодействия, которые уходят вместе с вузом.
 *
 * Отбор узкий намеренно. **Основная сторона**, а не любая: оператор стоит
 * стороной почти везде, и по любой стороне передача унесла бы половину
 * продукта. **Прежний ответственный владельцем**: запись, которую вуз давно
 * передал кому-то третьему, ведёт он, и смена куратора вуза его работу не
 * трогает. **Только `active`**: завершённые и отменённые — история, у неё
 * владелец остаётся тот, кто её вёл.
 *
 * Назначение по направлению уносит только работу этого направления, а
 * принадлежность к направлению у взаимодействия та же, что в отчётах: по
 * продуктам (`product_directions`) или по программам (`programs.direction_id`).
 */
async function openInteractionsOf(
	tx: Tx,
	params: { organizationId: string; ownerUserId: string; directionId: string | null }
): Promise<string[]> {
	const conditions = [
		eq(interactions.status, 'active'),
		eq(interactions.ownerUserId, params.ownerUserId),
		exists(
			tx
				.select({ one: sql`1` })
				.from(interactionParties)
				.where(
					and(
						eq(interactionParties.interactionId, interactions.id),
						eq(interactionParties.isPrimary, true),
						eq(interactionParties.organizationId, params.organizationId)
					)
				)
		)
	];

	if (params.directionId !== null) {
		const byProduct = exists(
			tx
				.select({ one: sql`1` })
				.from(interactionProducts)
				.innerJoin(
					productDirections,
					eq(productDirections.productId, interactionProducts.productId)
				)
				.where(
					and(
						eq(interactionProducts.interactionId, interactions.id),
						eq(productDirections.directionId, params.directionId)
					)
				)
		);

		const byProgram = exists(
			tx
				.select({ one: sql`1` })
				.from(interactionPrograms)
				.innerJoin(programs, eq(programs.id, interactionPrograms.programId))
				.where(
					and(
						eq(interactionPrograms.interactionId, interactions.id),
						eq(programs.directionId, params.directionId)
					)
				)
		);

		conditions.push(sql`(${byProduct} or ${byProgram})`);
	}

	const rows = await tx
		.select({ id: interactions.id })
		.from(interactions)
		.where(and(...conditions))
		.orderBy(asc(interactions.id));

	return rows.map((row) => row.id);
}

/**
 * Назначает ответственного: закрывает прежнее назначение на ту же пару «вуз ×
 * направление», если оно было, и открывает новое **тем же моментом**.
 *
 * Момент один на обе строки: иначе между ними осталась бы щель, в которую
 * попадает отчёт за период, и строка вуза оказалась бы ничьей.
 *
 * При замене незавершённые взаимодействия прежнего ответственного передаются
 * новому — в той же транзакции, той же командой, что и передача с карточки
 * (`setResponsible`): иначе половина работы осталась бы у человека, который вуз
 * уже не ведёт, и передавать её пришлось бы поштучно.
 *
 * `tx` передаёт тот, кто уже держит транзакцию, — импорт каталога назначает
 * ответственного вместе с заведением вуза. Своей транзакции такой вызов не
 * начинает и своим соединением ничего не читает: вуз, заведённый секунду назад,
 * в общем пуле ещё не виден, а второе соединение под уже открытой транзакцией
 * запирает пул.
 */
export async function assignResponsible(
	ctx: ActorContext,
	input: AssignResponsibleInput,
	tx?: Tx
): Promise<void> {
	await requirePermission(ctx, 'responsibles.manage', {
		type: 'directory.responsible_assigned',
		subject: { type: 'organization', id: input.organizationId }
	});

	// Передача — та же смена владельца, что и с карточки взаимодействия, поэтому
	// и право то же. Проверяется до первой записи и независимо от того, нашлась
	// ли работа: отказ не должен зависеть от содержимого чужого портфеля.
	if (input.transferInteractions) {
		requirePermission(ctx, 'interactions.reassign');
	}

	const executor: Executor = tx ?? getDb();

	await assertOrganizationAssignable(ctx, input.organizationId, executor);
	await assertAssignable(ctx, input.userId, executor);

	if (input.directionId !== null) {
		const [direction] = await executor
			.select({ id: directions.id, isActive: directions.isActive })
			.from(directions)
			.where(eq(directions.id, input.directionId))
			.limit(1);

		if (direction === undefined) {
			throw new ValidationError('Ответственный не назначен', ['Направление не найдено']);
		}

		// Спрятать архивное направление из подсказки мало: адрес и тело запроса
		// набирают руками, а назначение — это ещё и право видеть вуз.
		if (!direction.isActive) {
			throw new ValidationError('Ответственный не назначен', [
				'Направление в архиве: по нему больше не назначают'
			]);
		}
	}

	const current = await executor
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

	const write = async (executing: Tx): Promise<void> => {
		// Момент операции считает база: у неё и у приложения часы разные, а две
		// строки истории обязаны сойтись символ в символ. Значение возвращается
		// текстом и уходит обратно приведением: у драйвера для `clock_timestamp()`
		// своего разбора нет, а точность метки — микросекунды, которых у Date нет.
		//
		// Часы, а не `now()`: `now()` — это момент начала транзакции, и назначение,
		// прежняя строка которого записана этой же транзакцией (импорт каталога
		// заводит вуз и тут же отдаёт его менеджеру из файла), закрылось бы тем же
		// мгновением, в которое открылось. Такую строку база и не принимает —
		// `organization_responsibles_period_ordered` требует, чтобы конец был
		// строго позже начала.
		const [{ at }] = await executing.execute<{ at: string }>(
			sql`select clock_timestamp()::text as at`
		);
		const moment = sql`${at}::timestamptz`;

		if (replaced !== undefined) {
			await executing
				.update(organizationResponsibles)
				.set({ validTo: moment, updatedAt: sql`now()` })
				.where(eq(organizationResponsibles.id, replaced.id));
		}

		await executing.insert(organizationResponsibles).values({
			organizationId: input.organizationId,
			userId: input.userId,
			directionId: input.directionId,
			validFrom: moment,
			assignedByUserId: ctx.user?.id ?? null
		});

		// Передача идёт после того, как назначение записано: область доступа
		// считается подзапросом по действующим назначениям, и до этой строки вуз
		// новому ответственному ещё не принадлежит.
		const candidates =
			replaced === undefined || !input.transferInteractions
				? []
				: await openInteractionsOf(executing, {
						organizationId: input.organizationId,
						ownerUserId: replaced.userId,
						directionId: input.directionId
					});

		const transferred =
			candidates.length === 0
				? 0
				: await setResponsible(
						ctx,
						{ interactionIds: candidates, userId: input.userId },
						executing
					);

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
					...(replaced === undefined
						? {}
						: { previousUserId: replaced.userId, transferredCount: transferred })
				}
			},
			executing
		);
	};

	await (tx === undefined ? withTransaction(ctx, write) : write(tx));
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
	organizationId: string,
	executor: Executor = getDb()
): Promise<void> {
	const [row] = await executor
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
async function assertAssignable(
	ctx: ActorContext,
	userId: string,
	executor: Executor = getDb()
): Promise<void> {
	const [account] = await executor
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
 *
 * Архивных здесь нет: назначать ответственного по направлению, по которому
 * больше не работают, незачем, а уже заведённые назначения на нём остаются —
 * то же правило, что у архивной организации в подборе форм
 * (`docs/directory.md`).
 */
export async function listDirectionOptions(ctx: ActorContext): Promise<DirectionOption[]> {
	requirePermission(ctx, 'directions.read');

	return getDb()
		.select({ id: directions.id, name: directions.name })
		.from(directions)
		.where(eq(directions.isActive, true))
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
