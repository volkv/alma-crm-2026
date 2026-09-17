/**
 * Кем человек из каталога становится в системе.
 *
 * Здесь — вся работа с нашей таблицей пользователей при входе: поиск записи,
 * связывание с субъектом каталога, заведение новой, приведение имени, почты и
 * роли к тому, что сказал токен. Ничего про протокол: токен уже проверен
 * (`./oidc`), роль уже отображена (`./roles`).
 *
 * Правила и обоснование — `docs/access-matrix.md`, раздел 6.
 */
import { eq, sql } from 'drizzle-orm';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getDb } from '../db';
import { users } from '../db/schema';
import { withTransaction, type Tx } from '../db/transaction';
import type { IdentityClaims } from './oidc';
import { mapRealmRoles } from './roles';
import { createSession, loadSessionUser, markSignedIn, revokeAllSessions } from './session';
import type { SessionUser } from './types';
import { normalizeEmail } from './users';

export type SignInOutcome =
	| { ok: true; sessionId: string; user: SessionUser }
	/**
	 * Каталог человека знает, а система — нет: ни одной известной роли realm за
	 * ним не числится. Локальная запись при этом не заводится — пользователь без
	 * роли нам не сотрудник.
	 */
	| { ok: false; reason: 'no_role' }
	/**
	 * Почта токена занята машинным субъектом. Такая запись не входит никогда: её
	 * права принадлежат ключам обмена, и отдать их живому человеку значило бы
	 * отдать ему чужую систему.
	 */
	| { ok: false; reason: 'service_account' }
	/** Запись выключена администратором. Включить её может только он же. */
	| { ok: false; reason: 'inactive' }
	/**
	 * Почта токена уже числится за записью, которая связана с **другим**
	 * субъектом каталога, или пришла неподтверждённой. Завести рядом вторую
	 * запись с тем же адресом нельзя — почта уникальна, — а отдать чужую значило
	 * бы отдать чужой портфель.
	 */
	| { ok: false; reason: 'email_taken' };

/**
 * Вход по проверенным утверждениям токена.
 *
 * Отказ — обычный исход, а не сбой, поэтому возвращается результат: страница
 * входа обязана решить, что показать. Каждый отказ пишется в журнал событием
 * `auth.login` с исходом `denied`: попытка войти без роли — это то, о чём
 * администратор должен узнать.
 */
export async function signInWithClaims(
	ctx: ActorContext,
	claims: IdentityClaims,
	idToken: string
): Promise<SignInOutcome> {
	const roleId = mapRealmRoles(claims.realmRoles);

	if (roleId === null) {
		// Роль могли не выдать вовсе, а могли отозвать у того, кто уже работал.
		// Второе — это увольнение: запись не удаляется (на неё ссылаются журнал,
		// назначения и взаимодействия), но выключается, и её сессии гасятся тем
		// же действием. Ждать, пока администратор заметит, нельзя.
		const [known] = await getDb()
			.select({ id: users.id, isActive: users.isActive })
			.from(users)
			.where(eq(users.externalSubject, claims.subject))
			.limit(1);

		if (known !== undefined && known.isActive) {
			await deactivateByDirectory(ctx, known.id);
		}

		await recordAuditEvent(ctx, {
			type: 'auth.login',
			outcome: 'denied',
			details: known === undefined ? {} : { userId: known.id }
		});

		return { ok: false, reason: 'no_role' };
	}

	const resolved = await resolveAccount(ctx, claims, roleId);

	if (!resolved.ok) {
		await recordAuditEvent(ctx, {
			type: 'auth.login',
			outcome: 'denied',
			details: resolved.userId === undefined ? {} : { userId: resolved.userId }
		});

		return resolved;
	}

	const user = await loadSessionUser(resolved.userId);

	if (user === null) {
		// Запись выключили между обновлением и этой строкой: заводить сессию уже
		// не на кого.
		await recordAuditEvent(ctx, {
			type: 'auth.login',
			outcome: 'denied',
			details: { userId: resolved.userId }
		});

		return { ok: false, reason: 'inactive' };
	}

	const actor: ActorContext = { ...ctx, user, scope: user.scope };

	await markSignedIn(user.id);
	await recordAuditEvent(actor, {
		type: 'auth.login',
		outcome: 'success',
		subject: { type: 'user', id: user.id },
		details: user.isDemo ? { userId: user.id, demo: true } : { userId: user.id }
	});

	return {
		ok: true,
		user,
		sessionId: await createSession(user.id, { ip: ctx.ip, userAgent: ctx.userAgent, idToken })
	};
}

type ResolveOutcome =
	| { ok: true; userId: string }
	| { ok: false; reason: 'service_account' | 'inactive' | 'email_taken'; userId?: string };

/**
 * Запись, которой человек входит: найденная по субъекту, связанная по
 * подтверждённой почте или заведённая заново.
 *
 * Порядок именно такой. Связывание по почте нужно потому, что пользователи в
 * базе уже есть: без него у каждого появился бы двойник, а взаимодействия,
 * назначения, ключи и след в журнале остались бы за записью, в которую уже
 * никто не войдёт. Неподтверждённая почта в связывании не участвует — иначе
 * чужой адрес в токене отдавал бы чужой портфель.
 */
async function resolveAccount(
	ctx: ActorContext,
	claims: IdentityClaims,
	roleId: string
): Promise<ResolveOutcome> {
	const email = claims.email === null ? null : normalizeEmail(claims.email);

	return withTransaction(ctx, async (tx) => {
		const [bySubject] = await tx
			.select({ id: users.id, roleId: users.roleId, isActive: users.isActive })
			.from(users)
			.where(eq(users.externalSubject, claims.subject))
			.limit(1);

		if (bySubject !== undefined) {
			if (bySubject.roleId === 'service') {
				return { ok: false, reason: 'service_account', userId: bySubject.id };
			}

			if (!bySubject.isActive) {
				return { ok: false, reason: 'inactive', userId: bySubject.id };
			}

			await applyClaims(ctx, tx, bySubject.id, {
				email,
				fullName: claims.fullName,
				roleId,
				previousRoleId: bySubject.roleId
			});

			return { ok: true, userId: bySubject.id };
		}

		if (email !== null) {
			const [byEmail] = await tx
				.select({
					id: users.id,
					roleId: users.roleId,
					isActive: users.isActive,
					externalSubject: users.externalSubject
				})
				.from(users)
				.where(sql`lower(${users.email}) = ${email}`)
				.limit(1);

			// Почта занята, а связаться с этой записью нельзя: либо она уже за
			// другим субъектом каталога, либо каталог не подтвердил владение
			// адресом. Заводить рядом вторую запись с тем же адресом база не даст,
			// и падать ошибкой уникальности на входе — не ответ: человек должен
			// получить понятный отказ, а администратор — строку в журнале.
			if (byEmail !== undefined && (!claims.emailVerified || byEmail.externalSubject !== null)) {
				return { ok: false, reason: 'email_taken', userId: byEmail.id };
			}

			if (byEmail !== undefined && claims.emailVerified) {
				if (byEmail.roleId === 'service') {
					return { ok: false, reason: 'service_account', userId: byEmail.id };
				}

				if (!byEmail.isActive) {
					return { ok: false, reason: 'inactive', userId: byEmail.id };
				}

				await tx
					.update(users)
					.set({ externalSubject: claims.subject, updatedAt: sql`now()` })
					.where(eq(users.id, byEmail.id));

				await applyClaims(ctx, tx, byEmail.id, {
					email,
					fullName: claims.fullName,
					roleId,
					previousRoleId: byEmail.roleId
				});

				await recordAuditEvent(
					ctx,
					{
						type: 'users.updated',
						outcome: 'success',
						subject: { type: 'user', id: byEmail.id },
						details: { userId: byEmail.id, changedFields: ['externalSubject'] }
					},
					tx
				);

				return { ok: true, userId: byEmail.id };
			}
		}

		const [created] = await tx
			.insert(users)
			.values({
				email: email ?? `${claims.subject}@external.invalid`,
				fullName: claims.fullName ?? email ?? claims.subject,
				roleId,
				externalSubject: claims.subject
			})
			.returning({ id: users.id });

		await recordAuditEvent(
			ctx,
			{
				type: 'users.created',
				outcome: 'success',
				subject: { type: 'user', id: created.id },
				details: { userId: created.id, roleId }
			},
			tx
		);

		return { ok: true, userId: created.id };
	});
}

/**
 * Приводит запись к тому, что сказал каталог: почта, имя и роль. Источник
 * истины о человеке — каталог, а не наша база; иерархия (`manager_user_id`) и
 * назначения на вузы источником истины в каталоге **не** являются — это
 * операционные данные CRM.
 *
 * Смена роли гасит сессии владельца: иначе область осталась бы прежней до
 * истечения сессии, а отозванное право — действующим.
 */
async function applyClaims(
	ctx: ActorContext,
	tx: Tx,
	userId: string,
	next: { email: string | null; fullName: string | null; roleId: string; previousRoleId: string }
): Promise<void> {
	await tx
		.update(users)
		.set({
			...(next.email === null ? {} : { email: next.email }),
			...(next.fullName === null ? {} : { fullName: next.fullName }),
			roleId: next.roleId,
			updatedAt: sql`now()`
		})
		.where(eq(users.id, userId));

	if (next.previousRoleId !== next.roleId) {
		await recordAuditEvent(
			ctx,
			{
				type: 'users.role_changed',
				outcome: 'success',
				subject: { type: 'user', id: userId },
				details: { userId, roleId: next.roleId }
			},
			tx
		);

		await revokeAllSessions(userId);
	}
}

/**
 * Запись, которую каталог перестал знать: роль отозвали, и вход отклонён.
 * Отдельная функция, потому что деактивация по этой причине — не действие
 * администратора, а следствие чужого решения, и сессии она гасит сама.
 */
async function deactivateByDirectory(ctx: ActorContext, userId: string): Promise<void> {
	await withTransaction(ctx, async (tx) => {
		await tx
			.update(users)
			.set({ isActive: false, deactivatedAt: sql`now()`, updatedAt: sql`now()` })
			.where(eq(users.id, userId));

		await recordAuditEvent(
			ctx,
			{ type: 'users.deactivated', outcome: 'success', subject: { type: 'user', id: userId } },
			tx
		);
	});

	await revokeAllSessions(userId);
}
