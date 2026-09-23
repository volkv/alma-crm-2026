/**
 * Пользователи системы: список, иерархия, включение и выключение.
 *
 * Заведения записи здесь нет. Кто такой человек и какая у него роль, знает
 * каталог учётных записей: запись появляется сама при первом входе, а роль
 * приводится к утверждению токена на каждом следующем (`./identity`). За CRM
 * остаются операционные данные, которых в каталоге нет и быть не должно:
 * руководитель сотрудника, признак демонстрационной записи и право работать
 * дальше.
 */
import { alias } from 'drizzle-orm/pg-core';
import { and, count, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm';
import type { UserView } from '$lib/contracts/auth';
import type { PageQuery, PageResult } from '$lib/contracts/common';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getConfig } from '../config';
import { getDb } from '../db';
import { roles, users, workspaces } from '../db/schema';
import { withTransaction } from '../db/transaction';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { requirePermission } from '../rbac';
import { workspaceAccessCondition } from '../rbac/workspaces';
import { revokeAllSessions } from './session';

/** Почта — ключ связывания с каталогом, поэтому хранится и сравнивается в одном виде. */
export function normalizeEmail(email: string): string {
	return email.trim().toLocaleLowerCase('en');
}

/** Руководитель сотрудника в выборках списка. */
const managers = alias(users, 'managers');

const userColumns = {
	id: users.id,
	email: users.email,
	fullName: users.fullName,
	roleId: users.roleId,
	roleName: roles.name,
	managerUserId: users.managerUserId,
	managerFullName: managers.fullName,
	isLinked: sql<boolean>`${users.externalSubject} is not null`,
	isActive: users.isActive,
	isDemo: users.isDemo,
	lastLoginAt: users.lastLoginAt,
	createdAt: users.createdAt
};

/** Состояние учётной записи, от которого зависит, можно ли её переключать. */
async function readAccountState(userId: string): Promise<{ isActive: boolean; isDemo: boolean }> {
	const [row] = await getDb()
		.select({ isActive: users.isActive, isDemo: users.isDemo })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);

	if (row === undefined) {
		throw new NotFoundError('Пользователь не найден');
	}

	return row;
}

/**
 * Выключает учётную запись и немедленно гасит её сессии: иначе уволенный
 * сотрудник доработал бы в системе до конца своего рабочего дня.
 *
 * Демонстрационные записи при включённом демо-режиме выключить нельзя. Ими
 * входят все, кто открыл стенд, и восстановить выключенную некому: раздел, где
 * её можно было бы включить обратно, закрыт для самой демонстрации. Одно
 * нажатие — и показывать нечего до следующего вмешательства в базу.
 */
export async function deactivateUser(ctx: ActorContext, userId: string): Promise<void> {
	await requirePermission(ctx, 'users.manage', {
		type: 'users.deactivated',
		subject: { type: 'user', id: userId }
	});

	if (ctx.user?.id === userId) {
		throw new ConflictError('Нельзя выключить собственную учётную запись');
	}

	const account = await readAccountState(userId);

	if (account.isDemo && getConfig().DEMO_MODE) {
		throw new ConflictError(
			'Демонстрационную учётную запись нельзя выключить, пока включён демо-режим'
		);
	}

	await withTransaction(ctx, async (tx) => {
		const [updated] = await tx
			.update(users)
			.set({ isActive: false, deactivatedAt: sql`now()`, updatedAt: sql`now()` })
			.where(eq(users.id, userId))
			.returning({ id: users.id });

		if (updated === undefined) {
			throw new NotFoundError('Пользователь не найден');
		}

		await recordAuditEvent(
			ctx,
			{ type: 'users.deactivated', outcome: 'success', subject: { type: 'user', id: userId } },
			tx
		);
	});

	await revokeAllSessions(userId);
}

/**
 * Включает выключенную учётную запись обратно.
 *
 * Вход при этом всё равно решает каталог: включение снимает только наш запрет.
 * Сессий у выключенной записи нет (их погасило выключение), поэтому включение
 * ничего не восстанавливает — оно открывает вход.
 */
export async function activateUser(ctx: ActorContext, userId: string): Promise<void> {
	await requirePermission(ctx, 'users.manage', {
		type: 'users.activated',
		subject: { type: 'user', id: userId }
	});

	const account = await readAccountState(userId);

	// Журнал — доказательство того, что произошло: записать включение того, что
	// и так работает, значит положить в него событие, которого не было.
	if (account.isActive) {
		throw new ConflictError('Учётная запись и так работает');
	}

	await withTransaction(ctx, async (tx) => {
		await tx
			.update(users)
			.set({ isActive: true, deactivatedAt: null, updatedAt: sql`now()` })
			.where(eq(users.id, userId));

		await recordAuditEvent(
			ctx,
			{ type: 'users.activated', outcome: 'success', subject: { type: 'user', id: userId } },
			tx
		);
	});
}

/**
 * Отвязывает учётную запись от каталога: стирает `external_subject`.
 *
 * Нужно ровно тогда, когда каталог перезавели — переимпортировали realm,
 * перенесли установку, подняли его заново, — и субъекты у тех же людей стали
 * другими. Вход по новому субъекту такую запись не узнаёт, а связаться по почте
 * не может: связывание принимает только запись **без** субъекта, и ослаблять
 * это правило нельзя — иначе чужой адрес в токене отдавал бы чужой портфель.
 * Поэтому решение остаётся за человеком: администратор отвязывает запись, и
 * следующий вход связывает её заново по подтверждённой почте — вместе со всем
 * портфелем, назначениями и следом в журнале.
 *
 * Сессии владельца гасятся: связь, по которой они открыты, больше не та.
 */
export async function unlinkFromDirectory(ctx: ActorContext, userId: string): Promise<void> {
	await requirePermission(ctx, 'users.manage', {
		type: 'users.updated',
		subject: { type: 'user', id: userId }
	});

	const [account] = await getDb()
		.select({ id: users.id, externalSubject: users.externalSubject })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);

	if (account === undefined) {
		throw new NotFoundError('Пользователь не найден');
	}

	// Журнал — доказательство того, что произошло: записать отвязку того, что и
	// так не связано, значит положить в него событие, которого не было.
	if (account.externalSubject === null) {
		throw new ConflictError('Учётная запись и так не связана с каталогом');
	}

	await withTransaction(ctx, async (tx) => {
		await tx
			.update(users)
			.set({ externalSubject: null, updatedAt: sql`now()` })
			.where(eq(users.id, userId));

		await recordAuditEvent(
			ctx,
			{
				type: 'users.updated',
				outcome: 'success',
				subject: { type: 'user', id: userId },
				details: { userId, changedFields: ['externalSubject'] }
			},
			tx
		);
	});

	await revokeAllSessions(userId);
}

/**
 * Назначает или снимает руководителя сотрудника.
 *
 * Иерархия — операционные данные CRM, а не каталога: на ней держится и область
 * доступа руководителя, и адрес эскалации зависшего взаимодействия. Смена
 * гасит сессии обоих затронутых: у подчинённого меняется, кому он виден, у
 * руководителя — что он видит, и донашивать прежнюю область до истечения
 * сессии нельзя.
 */
export async function setUserManager(
	ctx: ActorContext,
	input: { userId: string; managerUserId: string | null }
): Promise<void> {
	await requirePermission(ctx, 'users.manage', {
		type: 'users.updated',
		subject: { type: 'user', id: input.userId }
	});

	if (input.managerUserId === input.userId) {
		throw new ValidationError('Иерархия не изменена', [
			'Сотрудник не может быть руководителем самому себе'
		]);
	}

	const db = getDb();

	const [account] = await db
		.select({ id: users.id, managerUserId: users.managerUserId })
		.from(users)
		.where(eq(users.id, input.userId))
		.limit(1);

	if (account === undefined) {
		throw new NotFoundError('Пользователь не найден');
	}

	if (input.managerUserId !== null) {
		const [manager] = await db
			.select({ id: users.id, isActive: users.isActive, roleId: users.roleId })
			.from(users)
			.where(eq(users.id, input.managerUserId))
			.limit(1);

		if (manager === undefined || !manager.isActive) {
			throw new ValidationError('Иерархия не изменена', [
				'Руководитель не найден или его запись выключена'
			]);
		}

		if (manager.roleId === 'service') {
			throw new ValidationError('Иерархия не изменена', [
				'Машинный субъект не может быть руководителем: он не работает в системе'
			]);
		}

		// Цикл в иерархии остановил бы замыкание подчинённых только защитой
		// запроса; лучше не заводить его вовсе. Проверка — тем же обходом вверх,
		// каким считается эскалация.
		if (await reportsTo(input.managerUserId, input.userId)) {
			throw new ValidationError('Иерархия не изменена', [
				'Такой руководитель сам подчиняется этому сотруднику — получился бы круг'
			]);
		}
	}

	if (account.managerUserId === input.managerUserId) {
		return;
	}

	await withTransaction(ctx, async (tx) => {
		await tx
			.update(users)
			.set({ managerUserId: input.managerUserId, updatedAt: sql`now()` })
			.where(eq(users.id, input.userId));

		await recordAuditEvent(
			ctx,
			{
				type: 'users.updated',
				outcome: 'success',
				subject: { type: 'user', id: input.userId },
				details: { userId: input.userId, changedFields: ['managerUserId'] }
			},
			tx
		);
	});

	for (const affected of new Set(
		[input.userId, input.managerUserId, account.managerUserId].filter(
			(value): value is string => value !== null
		)
	)) {
		await revokeAllSessions(affected);
	}
}

/** Подчиняется ли `userId` (пусть и через несколько уровней) руководителю `managerId`. */
async function reportsTo(userId: string, managerId: string): Promise<boolean> {
	const rows = await getDb().execute<{ id: string }>(sql`
		with recursive chain(id, manager_user_id, depth) as (
			select u.id, u.manager_user_id, 0 from users u where u.id = ${userId}::uuid
			union all
			select u.id, u.manager_user_id, c.depth + 1
			from users u
			join chain c on u.id = c.manager_user_id
			where c.depth < 16
		) cycle id set is_cycle using path
		select id from chain where id = ${managerId}::uuid
	`);

	return rows.length > 0;
}

/** Страница списка пользователей и отбор в нём. */
export type UserListQuery = PageQuery & {
	/** Почта или имя целиком либо куском; пусто — весь штат. */
	q?: string | null;
};

/**
 * Список учётных записей: и действующих, и выключенных — раздел управления
 * доступом показывает штат целиком, включая машинных субъектов: ключи обмена
 * выпускаются на них, и не видеть их в списке значило бы не знать, кто владеет
 * ключом.
 *
 * Отбор идёт по почте и имени: это два способа назвать человека, и
 * администратор приходит сюда с одним из них.
 */
export async function listUsers(
	ctx: ActorContext,
	query: UserListQuery
): Promise<PageResult<UserView>> {
	await requirePermission(ctx, 'users.manage', { type: 'users.viewed' });

	const db = getDb();
	const q = query.q?.trim() ?? '';
	const where =
		q === '' ? undefined : or(ilike(users.email, `%${q}%`), ilike(users.fullName, `%${q}%`));

	const [items, totals] = await Promise.all([
		db
			.select(userColumns)
			.from(users)
			.innerJoin(roles, eq(roles.id, users.roleId))
			.leftJoin(managers, eq(managers.id, users.managerUserId))
			.where(where)
			.orderBy(users.email)
			.limit(query.pageSize)
			.offset((query.page - 1) * query.pageSize),
		db.select({ value: count() }).from(users).where(where)
	]);

	return { items, total: totals[0]?.value ?? 0, page: query.page, pageSize: query.pageSize };
}

/** Сколько сотрудников попадает в выпадающий список за раз. */
const LOOKUP_LIMIT = 100;

/** Сотрудник в выпадающем списке «кому подчиняется». */
export type ManagerOption = { id: string; fullName: string };

/**
 * Кого можно поставить руководителем: весь действующий штат, кроме машинного
 * субъекта.
 *
 * Собирается отдельным запросом, а не из строк текущей страницы: раздел
 * пользователей листается и ищется, и список вариантов, собранный из найденного,
 * под отбором по одной почте схлопывался бы до пустого — выбранный руководитель
 * пропадал бы с экрана вместе с возможностью его поменять.
 */
export async function listManagerOptions(ctx: ActorContext): Promise<ManagerOption[]> {
	requirePermission(ctx, 'users.manage');

	return getDb()
		.select({ id: users.id, fullName: users.fullName })
		.from(users)
		.where(and(eq(users.isActive, true), ne(users.roleId, 'service')))
		.orderBy(users.fullName)
		.limit(LOOKUP_LIMIT);
}

/** Сотрудник в выпадающем списке: кого можно назначить ответственным. */
export type UserLookupItem = {
	id: string;
	fullName: string;
	roleId: string;
	roleName: string;
};

/**
 * Сотрудники для выбора ответственного.
 *
 * Право здесь `interactions.write`, а не `users.manage`: назначать
 * ответственного за стадию — работа менеджера, и штат ему для этого нужен
 * весь, а вот выключать учётные записи он не может. Поэтому наружу идут только
 * имя и роль: почты, состояния и отметок о последнем входе для выпадающего
 * списка не нужно, а видит его куда более широкий круг, чем раздел
 * пользователей.
 *
 * Выключенные записи не показываются — назначить работу на уволенного нельзя.
 * Машинный субъект не показывается тоже: он не работает, от его имени ходят
 * ключи обмена, и поручить ему стадию значило бы поручить её никому.
 *
 * `workspaceKey` сужает список до тех, кто работает в пространстве: поручить
 * запись сотруднику вне него значит поручить то, чего он не увидит. Отбор идёт
 * в запросе, а не после него, — иначе потолок списка отрезал бы членов
 * пространства раньше, чем до них дошла бы очередь.
 */
export async function lookupUsers(
	ctx: ActorContext,
	input: { q?: string; roleIds?: readonly string[]; workspaceKey?: string } = {}
): Promise<UserLookupItem[]> {
	requirePermission(ctx, 'interactions.write');

	const conditions = [eq(users.isActive, true), ne(users.roleId, 'service')];

	if (input.workspaceKey !== undefined) {
		conditions.push(
			workspaceAccessCondition(
				{ id: users.id, roleId: users.roleId },
				sql`(select ${workspaces.id} from ${workspaces} where ${workspaces.key} = ${input.workspaceKey})`
			)
		);
	}
	const q = input.q?.trim() ?? '';

	if (q !== '') {
		conditions.push(ilike(users.fullName, `%${q}%`));
	}

	if (input.roleIds !== undefined) {
		// Пустой список ролей — это «ни одна роль не подходит», а не «любая»:
		// молча расширять запрос до всего штата нельзя.
		if (input.roleIds.length === 0) {
			return [];
		}

		conditions.push(inArray(users.roleId, [...input.roleIds]));
	}

	return getDb()
		.select({
			id: users.id,
			fullName: users.fullName,
			roleId: users.roleId,
			roleName: roles.name
		})
		.from(users)
		.innerJoin(roles, eq(roles.id, users.roleId))
		.where(and(...conditions))
		.orderBy(users.fullName)
		.limit(LOOKUP_LIMIT);
}
