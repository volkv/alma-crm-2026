/**
 * Членство сотрудников в пространствах — второе измерение области доступа.
 *
 * Здесь всё, что про членство знает база: из чего собирается набор
 * пространств вызывающего (`loadWorkspaceIds`), кто вообще может вести работу
 * в пространстве (`workspaceAccessCondition`, `assertMayWorkIn`) и настройка
 * состава (`listWorkspaceMemberships`, `addWorkspaceMember`,
 * `removeWorkspaceMember`). Само условие видимости строк — `workspaceFilter` в
 * `./index.ts`: оно читает уже собранный набор и в базу не ходит.
 *
 * Управляет составом право `users.manage`: включить сотрудника в пространство
 * — значит открыть ему работу направления, то есть выдать доступ, а это то же
 * самое, что сменить ему роль. Право `stages.configure` про устройство
 * процесса и доступа не выдаёт.
 */
import { and, asc, count, eq, isNull, notInArray, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import {
	addWorkspaceMemberSchema,
	removeWorkspaceMemberSchema,
	type AddWorkspaceMemberInput,
	type RemoveWorkspaceMemberInput,
	type WorkspaceMemberCandidate,
	type WorkspaceMembership
} from '$lib/contracts/interactions';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getDb } from '../db';
import { interactions, roles, users, workspaceMembers, workspaces } from '../db/schema';
import { withTransaction, type Tx } from '../db/transaction';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { requirePermission } from './index';

/**
 * Роли, область которых — всё: им членство не нужно и ничего не даёт.
 * Администратор видит все пространства по роли; машинный субъект обмена
 * приносит заявку по любому направлению, а входа у него нет.
 *
 * Список один на приложение: по нему собирается область при входе
 * (`auth/session.ts`) и по нему же решается, может ли сотрудник вести работу в
 * пространстве. Два списка однажды разошлись бы, и администратор оказался бы
 * «не в пространстве» для эскалации, оставаясь в нём для экранов.
 */
export const FULL_SCOPE_ROLE_IDS: readonly string[] = ['admin', 'service'];

export function hasFullScope(roleId: string): boolean {
	return FULL_SCOPE_ROLE_IDS.includes(roleId);
}

/** Действующие членства сотрудника: набор, который встаёт в его область. */
export async function loadWorkspaceIds(userId: string): Promise<ReadonlySet<string>> {
	const rows = await getDb()
		.select({ workspaceId: workspaceMembers.workspaceId })
		.from(workspaceMembers)
		.where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.validTo)));

	return new Set(rows.map((row) => row.workspaceId));
}

/**
 * Условие «этот сотрудник работает в этом пространстве» — про **другого**
 * человека, а не про вызывающего: кому уйдёт эскалация, кого можно поставить
 * ответственным. Вызывающего спрашивают через `workspaceFilter`: его набор уже
 * собран, и ходить за ним в базу второй раз незачем.
 *
 * Роль — столбец той же выборки: сотрудник с полной областью проходит без
 * членства, ровно как проходит он сам на своих экранах.
 */
export function workspaceAccessCondition(
	user: { id: PgColumn | SQL; roleId: PgColumn | SQL },
	workspaceId: PgColumn | SQL
): SQL {
	return sql`(${user.roleId} in (${sql.join(
		FULL_SCOPE_ROLE_IDS.map((roleId) => sql`${roleId}`),
		sql`, `
	)}) or exists (select 1 from ${workspaceMembers} where ${workspaceMembers.userId} = ${user.id} and ${workspaceMembers.workspaceId} = ${workspaceId} and ${workspaceMembers.validTo} is null))`;
}

type Executor = Tx | ReturnType<typeof getDb>;

/** Может ли сотрудник вести работу в пространстве: член или роль с полной областью. */
export async function mayWorkIn(
	executor: Executor,
	userId: string,
	workspaceId: string
): Promise<boolean> {
	const [row] = await executor
		.select({ id: users.id })
		.from(users)
		.where(
			and(
				eq(users.id, userId),
				workspaceAccessCondition({ id: users.id, roleId: users.roleId }, sql`${workspaceId}::uuid`)
			)
		)
		.limit(1);

	return row !== undefined;
}

/**
 * То же, но отказ — `ValidationError`.
 *
 * Ответственный, не состоящий в пространстве, своего взаимодействия не видит:
 * запись уходит из виду в ту же секунду, как её заводят. Поэтому ставить его
 * ответственным нельзя — отказ с объяснением лучше записи, которую никто не
 * ведёт.
 */
export async function assertMayWorkIn(
	executor: Executor,
	userId: string,
	workspace: { id: string; name: string }
): Promise<void> {
	if (!(await mayWorkIn(executor, userId, workspace.id))) {
		throw new ValidationError('Ответственный не работает в этом пространстве', [
			`Сотрудник не включён в пространство «${workspace.name}» и не увидит запись, которую ему поручают. Включите его в разделе «Настройки → Пространства» или выберите другого`
		]);
	}
}

/**
 * Составы всех пространств и те, кого можно включить.
 *
 * Число взаимодействий у каждого — незавершённые записи пространства, за
 * которые он отвечает: именно их он перестанет видеть, если его исключить.
 */
export async function listWorkspaceMemberships(ctx: ActorContext): Promise<{
	workspaces: WorkspaceMembership[];
	candidates: WorkspaceMemberCandidate[];
}> {
	await requirePermission(ctx, 'users.manage', { type: 'users.viewed' });

	const db = getDb();

	const [places, members, owned, candidates] = await Promise.all([
		db
			.select({ id: workspaces.id, key: workspaces.key, name: workspaces.name })
			.from(workspaces)
			.orderBy(asc(workspaces.position)),
		db
			.select({
				workspaceId: workspaceMembers.workspaceId,
				userId: users.id,
				fullName: users.fullName,
				roleName: roles.name,
				isActive: users.isActive,
				since: workspaceMembers.validFrom
			})
			.from(workspaceMembers)
			.innerJoin(users, eq(users.id, workspaceMembers.userId))
			.innerJoin(roles, eq(roles.id, users.roleId))
			.where(isNull(workspaceMembers.validTo))
			.orderBy(asc(users.fullName)),
		db
			.select({
				workspaceId: interactions.workspaceId,
				userId: interactions.ownerUserId,
				value: count()
			})
			.from(interactions)
			.where(eq(interactions.status, 'active'))
			.groupBy(interactions.workspaceId, interactions.ownerUserId),
		db
			.select({
				userId: users.id,
				fullName: users.fullName,
				roleName: roles.name,
				managerUserId: users.managerUserId
			})
			.from(users)
			.innerJoin(roles, eq(roles.id, users.roleId))
			.where(and(eq(users.isActive, true), notInArray(users.roleId, [...FULL_SCOPE_ROLE_IDS])))
			.orderBy(asc(users.fullName))
	]);

	const ownedBy = new Map(owned.map((row) => [`${row.workspaceId}:${row.userId}`, row.value]));

	return {
		workspaces: places.map((place) => ({
			...place,
			members: members
				.filter((member) => member.workspaceId === place.id)
				.map((member) => ({
					userId: member.userId,
					fullName: member.fullName,
					roleName: member.roleName,
					isActive: member.isActive,
					since: member.since,
					ownedActive: ownedBy.get(`${place.id}:${member.userId}`) ?? 0
				}))
		})),
		candidates
	};
}

async function readWorkspace(
	tx: Tx,
	key: string
): Promise<{ id: string; key: string; name: string }> {
	const [row] = await tx
		.select({ id: workspaces.id, key: workspaces.key, name: workspaces.name })
		.from(workspaces)
		.where(eq(workspaces.key, key))
		.limit(1);

	if (row === undefined) {
		throw new NotFoundError('Пространство не найдено');
	}

	return row;
}

/** Включить сотрудника в пространство. */
export async function addWorkspaceMember(
	ctx: ActorContext,
	input: AddWorkspaceMemberInput
): Promise<void> {
	await requirePermission(ctx, 'users.manage', {
		type: 'users.workspace_granted',
		subject: { type: 'user', id: input.userId }
	});

	const parsed = addWorkspaceMemberSchema.parse(input);

	await withTransaction(ctx, async (tx) => {
		const workspace = await readWorkspace(tx, parsed.key);

		const [user] = await tx
			.select({ id: users.id, roleId: users.roleId, isActive: users.isActive })
			.from(users)
			.where(eq(users.id, parsed.userId))
			.limit(1);

		if (user === undefined) {
			throw new NotFoundError('Пользователь не найден');
		}

		if (!user.isActive) {
			throw new ValidationError('Сотрудник выключен', [
				'Включать в пространство выключенную учётную запись незачем: войти она не может'
			]);
		}

		if (hasFullScope(user.roleId)) {
			throw new ValidationError('Членство этой роли ничего не даёт', [
				'Администратор видит все пространства по роли, а внешняя система в интерфейс не входит'
			]);
		}

		// Действующее членство одно на пару: второе не даёт ничего, кроме
		// ложной строки в журнале о выданном доступе.
		const [created] = await tx
			.insert(workspaceMembers)
			.values({
				workspaceId: workspace.id,
				userId: user.id,
				grantedByUserId: ctx.user?.id ?? null
			})
			.onConflictDoNothing()
			.returning({ id: workspaceMembers.id });

		if (created === undefined) {
			throw new ConflictError('Сотрудник уже в этом пространстве');
		}

		await recordAuditEvent(
			ctx,
			{
				type: 'users.workspace_granted',
				outcome: 'success',
				subject: { type: 'user', id: user.id },
				details: { workspaceId: workspace.id, workspaceKey: workspace.key }
			},
			tx
		);
	});
}

/**
 * Исключить сотрудника из пространства.
 *
 * Доступ гаснет со следующего запроса: набор пространств собирается при
 * сборке пользователя на каждом запросе, а ключи кэша несут его отпечаток
 * (`scopeFingerprint`), поэтому собранное при членстве уже не найдётся.
 *
 * Если он отвечает за незавершённые взаимодействия пространства, команда
 * без подтверждения отказывает и называет их число: исключённый перестаёт их
 * видеть, и такая потеря должна быть решением, а не побочным эффектом. Записи
 * при этом остаются за ним — передать их другому можно и до, и после.
 */
export async function removeWorkspaceMember(
	ctx: ActorContext,
	input: RemoveWorkspaceMemberInput
): Promise<{ ownedActive: number }> {
	await requirePermission(ctx, 'users.manage', {
		type: 'users.workspace_revoked',
		subject: { type: 'user', id: input.userId }
	});

	const parsed = removeWorkspaceMemberSchema.parse(input);

	return withTransaction(ctx, async (tx) => {
		const workspace = await readWorkspace(tx, parsed.key);

		const [membership] = await tx
			.select({ id: workspaceMembers.id })
			.from(workspaceMembers)
			.where(
				and(
					eq(workspaceMembers.workspaceId, workspace.id),
					eq(workspaceMembers.userId, parsed.userId),
					isNull(workspaceMembers.validTo)
				)
			)
			.for('update');

		if (membership === undefined) {
			throw new NotFoundError('Сотрудник не состоит в этом пространстве');
		}

		const [owned] = await tx
			.select({ value: count() })
			.from(interactions)
			.where(
				and(
					eq(interactions.workspaceId, workspace.id),
					eq(interactions.ownerUserId, parsed.userId),
					eq(interactions.status, 'active')
				)
			);
		const ownedActive = owned?.value ?? 0;

		if (ownedActive > 0 && !parsed.confirmOwned) {
			throw new ConflictError(
				`Сотрудник отвечает за незавершённые взаимодействия пространства «${workspace.name}»: ${ownedActive}. После исключения он перестанет их видеть. Передайте их другому ответственному или подтвердите исключение`
			);
		}

		await tx
			.update(workspaceMembers)
			.set({ validTo: sql`now()`, updatedAt: sql`now()` })
			.where(eq(workspaceMembers.id, membership.id));

		await recordAuditEvent(
			ctx,
			{
				type: 'users.workspace_revoked',
				outcome: 'success',
				subject: { type: 'user', id: parsed.userId },
				details: {
					workspaceId: workspace.id,
					workspaceKey: workspace.key,
					ownedCount: ownedActive
				}
			},
			tx
		);

		return { ownedActive };
	});
}
