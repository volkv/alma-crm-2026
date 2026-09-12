/**
 * Вход в систему.
 *
 * Отказ — обычный исход, а не сбой, поэтому функция возвращает результат, а не
 * бросает исключение: вызывающий обязан решить, что показать. Причина отказа
 * наружу не уточняется — «нет такого пользователя», «пароль не подошёл» и
 * «учётная запись выключена» дают один и тот же текст, иначе форма входа
 * превращается в справочник заведённых адресов.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { DemoAccount, LoginInput } from '$lib/contracts/auth';
import { pluralize } from '$lib/format';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getConfig } from '../config';
import { getDb } from '../db';
import { roles, users } from '../db/schema';
import { ConflictError, NotFoundError } from '../errors';
import { DEFAULT_ROLES } from '../rbac/permissions';
import { getSetting } from '../settings';
import {
	clearAddressAttempts,
	clearLoginFailures,
	lockoutState,
	registerLoginFailure,
	UNKNOWN_ADDRESS
} from './lockout';
import { verifyPassword } from './password';
import { createSession, loadSessionUser, markSignedIn } from './session';
import { normalizeEmail } from './users';

/** Один текст на все причины отказа: он не должен ничего сообщать о чужих учётных записях. */
const REFUSED = 'Неверная почта или пароль';

export type LoginOutcome =
	{ ok: true; sessionId: string } | { ok: false; reason: 'invalid' | 'locked'; message: string };

function lockedMessage(remainingSeconds: number): string {
	const minutes = Math.max(1, Math.ceil(remainingSeconds / 60));

	return `Слишком много неудачных попыток. Вход в эту учётную запись закрыт ещё ${pluralize(minutes, ['минуту', 'минуты', 'минут'])}`;
}

export async function login(ctx: ActorContext, input: LoginInput): Promise<LoginOutcome> {
	const email = normalizeEmail(input.email);
	const ip = ctx.ip ?? UNKNOWN_ADDRESS;

	const [account] = await getDb()
		.select({
			id: users.id,
			passwordHash: users.passwordHash,
			isActive: users.isActive,
			isDemo: users.isDemo
		})
		.from(users)
		.where(sql`lower(${users.email}) = ${email}`)
		.limit(1);

	// Публичная демонстрация: её учётной записью пользуются десятки незнакомых
	// друг с другом людей, и чужая опечатка не должна закрывать вход остальным.
	const exempt = getConfig().DEMO_MODE && account?.isDemo === true;
	const policy = await getSetting('lockout_policy');

	if (!exempt) {
		const state = await lockoutState(email, ip);

		if (state.failures >= policy.attempts && state.remainingSeconds > 0) {
			await recordAuditEvent(ctx, {
				type: 'auth.locked',
				outcome: 'denied',
				details: account === undefined ? {} : { userId: account.id }
			});

			return { ok: false, reason: 'locked', message: lockedMessage(state.remainingSeconds) };
		}
	}

	const matches = await verifyPassword(account?.passwordHash ?? null, input.password);

	if (account === undefined || !matches || !account.isActive) {
		if (!exempt) {
			await registerLoginFailure(email, ip, policy.minutes);
		}

		await recordAuditEvent(ctx, {
			type: 'auth.login_failed',
			outcome: 'failure',
			details: account === undefined ? {} : { userId: account.id }
		});

		return { ok: false, reason: 'invalid', message: REFUSED };
	}

	await clearLoginFailures(email, ip);

	// Лимит по адресу считает перебор: верный пароль его снимает, иначе десяток
	// человек за одним NAT выбирает общий счётчик обычной работой. Снимается он
	// только здесь: демонстрационный вход пароля не спрашивает, и снимать им
	// счётчик значило бы отдать обход лимита каждому, кто открыл страницу.
	await clearAddressAttempts(ip);

	return { ok: true, sessionId: await startSession(ctx, account.id) };
}

/**
 * Вход в публичную демонстрацию: учётная запись с этой ролью, помеченная
 * `is_demo`, впускается без пароля. Вне демо-режима такой записи для приложения
 * не существует — и маршрута тоже.
 */
export async function demoLogin(ctx: ActorContext, roleId: string): Promise<string> {
	if (!getConfig().DEMO_MODE) {
		throw new NotFoundError('Демонстрационный вход выключен');
	}

	const [account] = await getDb()
		.select({ id: users.id })
		.from(users)
		.where(and(eq(users.roleId, roleId), eq(users.isDemo, true), eq(users.isActive, true)))
		.orderBy(users.email)
		.limit(1);

	if (account === undefined) {
		throw new NotFoundError('Демонстрационная учётная запись с этой ролью не заведена');
	}

	return startSession(ctx, account.id);
}

async function startSession(ctx: ActorContext, userId: string): Promise<string> {
	// Форму входа заполняет ещё анонимный посетитель, но удачный вход — действие
	// самого владельца учётной записи: в журнале на этой строке должен стоять
	// он, иначе «кто вошёл» отвечается только по подробностям события. Тот же
	// пользователь собирается на каждом следующем запросе хуком сессии.
	const user = await loadSessionUser(userId);

	if (user === null) {
		// Учётную запись выключили между проверкой пароля и этой строкой: заводить
		// сессию уже не на кого.
		throw new ConflictError('Учётная запись недоступна');
	}

	const actor: ActorContext = { ...ctx, user, scope: user.scope };

	await markSignedIn(userId);

	await recordAuditEvent(actor, {
		type: 'auth.login',
		outcome: 'success',
		subject: { type: 'user', id: userId },
		// Признак берётся у собранной сессии, а не у того, по кнопке пришли или
		// по паролю: демонстрационная запись остаётся общей при любом входе, и
		// журнал должен помечать сессию, а не способ её открыть.
		details: user.isDemo ? { userId, demo: true } : { userId }
	});

	return createSession(userId, { ip: ctx.ip, userAgent: ctx.userAgent });
}

/** Порядок ролей на странице входа — тот же, что в каталоге ролей. */
const ROLE_ORDER = new Map(DEFAULT_ROLES.map((role, index) => [role.id, index]));

/**
 * Демонстрационные учётные записи, для которых страница входа рисует кнопки.
 * Список строится по базе: кнопка без учётной записи за ней бесполезна.
 */
export async function listDemoAccounts(): Promise<DemoAccount[]> {
	if (!getConfig().DEMO_MODE) {
		return [];
	}

	const rows = await getDb()
		.selectDistinct({ roleId: users.roleId, roleName: roles.name })
		.from(users)
		.innerJoin(roles, eq(roles.id, users.roleId))
		.where(and(eq(users.isDemo, true), eq(users.isActive, true)));

	return rows.sort(
		(left, right) =>
			(ROLE_ORDER.get(left.roleId) ?? Number.MAX_SAFE_INTEGER) -
			(ROLE_ORDER.get(right.roleId) ?? Number.MAX_SAFE_INTEGER)
	);
}
