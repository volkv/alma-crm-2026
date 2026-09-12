/**
 * Пользователи системы: заведение, деактивация, список, смена пароля.
 *
 * Интерфейс управления доступом живёт в настройках и зовёт эти функции; здесь
 * нет ничего про HTTP и формы. Пароль наружу не выходит никогда — ни в списке,
 * ни в журнале: в базе лежит только хеш.
 */
import { and, count, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { UserView } from '$lib/contracts/auth';
import type { PageQuery, PageResult } from '$lib/contracts/common';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getDb } from '../db';
import { roles, users } from '../db/schema';
import { withTransaction } from '../db/transaction';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { requirePermission } from '../rbac';
import { getSetting } from '../settings';
import { hashPassword, validatePassword, verifyPassword } from './password';
import { revokeAllSessions } from './session';

/** Почта — ключ входа, поэтому хранится и сравнивается в одном виде. */
export function normalizeEmail(email: string): string {
	return email.trim().toLocaleLowerCase('en');
}

export type CreateUserInput = {
	email: string;
	fullName: string;
	roleId: string;
	password: string;
	/** Учётная запись публичной демонстрации: входит без пароля при `DEMO_MODE`. */
	isDemo?: boolean;
};

const userColumns = {
	id: users.id,
	email: users.email,
	fullName: users.fullName,
	roleId: users.roleId,
	roleName: roles.name,
	isActive: users.isActive,
	isDemo: users.isDemo,
	lastLoginAt: users.lastLoginAt,
	createdAt: users.createdAt
};

export async function createUser(ctx: ActorContext, input: CreateUserInput): Promise<UserView> {
	requirePermission(ctx, 'users.manage');

	const email = normalizeEmail(input.email);
	const fullName = input.fullName.trim();

	if (fullName === '') {
		throw new ValidationError('Данные пользователя не прошли проверку', ['Укажите имя и фамилию']);
	}

	const policy = await getSetting('password_policy');
	const issues = validatePassword(policy, input.password);

	if (issues.length > 0) {
		throw new ValidationError('Пароль не отвечает политике', issues);
	}

	const db = getDb();

	// Роль обязана существовать: пользователь без роли не получает прав вообще, а
	// внешний ключ сказал бы об этом кодом PostgreSQL вместо понятной фразы.
	const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.id, input.roleId));

	if (role === undefined) {
		throw new ValidationError('Данные пользователя не прошли проверку', [
			`Роль «${input.roleId}» не заведена`
		]);
	}

	const [existing] = await db
		.select({ id: users.id })
		.from(users)
		.where(sql`lower(${users.email}) = ${email}`)
		.limit(1);

	if (existing !== undefined) {
		throw new ConflictError('Пользователь с такой почтой уже заведён');
	}

	const passwordHash = await hashPassword(input.password);

	return withTransaction(ctx, async (tx) => {
		const [created] = await tx
			.insert(users)
			.values({
				email,
				fullName,
				roleId: input.roleId,
				passwordHash,
				isDemo: input.isDemo ?? false
			})
			.returning({ id: users.id, createdAt: users.createdAt });

		await recordAuditEvent(
			ctx,
			{
				type: 'users.created',
				outcome: 'success',
				subject: { type: 'user', id: created.id },
				details: { roleId: input.roleId }
			},
			tx
		);

		const [view] = await tx
			.select(userColumns)
			.from(users)
			.innerJoin(roles, eq(roles.id, users.roleId))
			.where(eq(users.id, created.id));

		return view;
	});
}

/**
 * Выключает учётную запись и немедленно гасит её сессии: иначе уволенный
 * сотрудник доработал бы в системе до конца своего рабочего дня.
 */
export async function deactivateUser(ctx: ActorContext, userId: string): Promise<void> {
	requirePermission(ctx, 'users.manage');

	if (ctx.user?.id === userId) {
		throw new ConflictError('Нельзя выключить собственную учётную запись');
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

/** Страница списка пользователей и отбор в нём. */
export type UserListQuery = PageQuery & {
	/** Почта или имя целиком либо куском; пусто — весь штат. */
	q?: string | null;
};

/**
 * Список учётных записей: и действующих, и выключенных — раздел управления
 * доступом показывает штат целиком.
 *
 * Отбор идёт по почте и имени: это два способа назвать человека, и
 * администратор приходит сюда с одним из них. Поиск по подстроке без учёта
 * регистра — как в справочниках, иначе на четвёртой сотне записей найти
 * заведённого вчера сотрудника можно только перелистыванием.
 */
export async function listUsers(
	ctx: ActorContext,
	query: UserListQuery
): Promise<PageResult<UserView>> {
	requirePermission(ctx, 'users.manage');

	const db = getDb();
	const q = query.q?.trim() ?? '';
	const where =
		q === '' ? undefined : or(ilike(users.email, `%${q}%`), ilike(users.fullName, `%${q}%`));

	const [items, totals] = await Promise.all([
		db
			.select(userColumns)
			.from(users)
			.innerJoin(roles, eq(roles.id, users.roleId))
			.where(where)
			.orderBy(users.email)
			.limit(query.pageSize)
			.offset((query.page - 1) * query.pageSize),
		db.select({ value: count() }).from(users).where(where)
	]);

	return { items, total: totals[0]?.value ?? 0, page: query.page, pageSize: query.pageSize };
}

/** Сотрудник в выпадающем списке: кого можно назначить ответственным. */
export type UserLookupItem = {
	id: string;
	fullName: string;
	roleId: string;
	roleName: string;
};

/** Сколько сотрудников попадает в выпадающий список за раз. */
const LOOKUP_LIMIT = 100;

/**
 * Сотрудники для выбора ответственного.
 *
 * Право здесь `interactions.write`, а не `users.manage`: назначать
 * ответственного — работа менеджера, и штат ему для этого нужен весь, а вот
 * заводить и выключать учётные записи он не может. Поэтому наружу идут только
 * имя и роль: почты, состояния и отметок о последнем входе для выпадающего
 * списка не нужно, а видит его куда более широкий круг, чем раздел
 * пользователей. Выключенные записи не показываются — назначить работу на
 * уволенного нельзя.
 */
export async function lookupUsers(
	ctx: ActorContext,
	input: { q?: string; roleIds?: readonly string[] } = {}
): Promise<UserLookupItem[]> {
	requirePermission(ctx, 'interactions.write');

	const conditions = [eq(users.isActive, true)];
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

/**
 * Смена собственного пароля. Гасит все сессии владельца, включая текущую: если
 * пароль меняют потому, что старый мог утечь, чужая открытая вкладка не должна
 * пережить смену.
 */
export async function changePassword(
	ctx: ActorContext,
	input: { current: string; next: string }
): Promise<void> {
	const actor = ctx.user;

	if (actor === null) {
		throw new ForbiddenError('Сменить пароль может только вошедший пользователь');
	}

	const [account] = await getDb()
		.select({ passwordHash: users.passwordHash })
		.from(users)
		.where(eq(users.id, actor.id))
		.limit(1);

	if (account === undefined) {
		throw new NotFoundError('Пользователь не найден');
	}

	if (!(await verifyPassword(account.passwordHash, input.current))) {
		throw new ValidationError('Пароль не изменён', ['Текущий пароль указан неверно']);
	}

	if (input.next === input.current) {
		throw new ValidationError('Пароль не изменён', ['Новый пароль совпадает с текущим']);
	}

	const policy = await getSetting('password_policy');
	const issues = validatePassword(policy, input.next);

	if (issues.length > 0) {
		throw new ValidationError('Пароль не отвечает политике', issues);
	}

	const passwordHash = await hashPassword(input.next);

	await withTransaction(ctx, async (tx) => {
		await tx
			.update(users)
			.set({ passwordHash, passwordChangedAt: sql`now()`, updatedAt: sql`now()` })
			.where(eq(users.id, actor.id));

		await recordAuditEvent(
			ctx,
			{
				type: 'auth.password_changed',
				outcome: 'success',
				subject: { type: 'user', id: actor.id }
			},
			tx
		);
	});

	await revokeAllSessions(actor.id);
}
