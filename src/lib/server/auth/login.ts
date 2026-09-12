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
import { mfaRequired } from './mfa';
import { verifyPassword } from './password';
import { completeMfa, createSession, loadSessionUser, markSignedIn } from './session';
import type { SessionUser } from './types';
import { normalizeEmail } from './users';

/** Один текст на все причины отказа: он не должен ничего сообщать о чужих учётных записях. */
const REFUSED = 'Неверная почта или пароль';

export type LoginOutcome =
	| {
			ok: true;
			sessionId: string;
			/**
			 * Пароль приняли, но по политике нужен второй фактор: сессия заведена
			 * неполной, и страница входа обязана увести человека на второй шаг, а не
			 * в приложение.
			 */
			mfaPending: boolean;
	  }
	| { ok: false; reason: 'invalid' | 'locked'; message: string };

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

	return { ok: true, ...(await startSession(ctx, account.id)) };
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

	// Второго фактора демонстрационный вход не спрашивает никогда: учётная
	// запись общая, прав у неё меньше, а регистрировать фактор на неё было бы
	// то же самое, что отдать вход одному телефону из всех зрителей стенда.
	return (await startSession(ctx, account.id)).sessionId;
}

/**
 * Заводит сессию после того, как вызывающий доказал право войти.
 *
 * Здесь же решается, полная она или неполная. Неполная — это пароль без
 * второго фактора: `auth.login` по ней не пишется и отметка о последнем входе
 * не ставится, потому что входом это ещё не стало. И то и другое поставит
 * `finishSecondFactor`, когда код подтвердят.
 */
async function startSession(
	ctx: ActorContext,
	userId: string
): Promise<{ sessionId: string; mfaPending: boolean }> {
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
	const mfaPending = mfaRequired(await getSetting('mfa_policy'), user, ctx.ip);

	if (!mfaPending) {
		await recordSignIn(actor, user);
	}

	return {
		sessionId: await createSession(
			userId,
			{ ip: ctx.ip, userAgent: ctx.userAgent },
			{ mfaPending }
		),
		mfaPending
	};
}

/**
 * Отметка о состоявшемся входе: последний вход в учётной записи и строка в
 * журнале. Одна на оба пути — пароль без второго фактора и подтверждённый
 * второй шаг, — потому что вход в обоих случаях один и тот же.
 */
async function recordSignIn(actor: ActorContext, user: SessionUser): Promise<void> {
	await markSignedIn(user.id);

	await recordAuditEvent(actor, {
		type: 'auth.login',
		outcome: 'success',
		subject: { type: 'user', id: user.id },
		// Признак берётся у собранной сессии, а не у того, по кнопке пришли или
		// по паролю: демонстрационная запись остаётся общей при любом входе, и
		// журнал должен помечать сессию, а не способ её открыть.
		details: user.isDemo ? { userId: user.id, demo: true } : { userId: user.id }
	});
}

/**
 * Второй фактор подтверждён: сессия становится полной и получает обычный срок
 * жизни, а в журнале появляется вход. До этой строки человек предъявил только
 * пароль, и записи о входе не было.
 */
export async function finishSecondFactor(ctx: ActorContext, sessionId: string): Promise<void> {
	const user = ctx.user;

	if (user === null) {
		throw new ConflictError('Сессия истекла, войдите заново');
	}

	// Закрывать нечего, если второй шаг не начинался: полная сессия, дошедшая
	// сюда, получила бы вторую запись о входе и продление срока в обход того,
	// что его назначило.
	if (!user.mfaPending) {
		throw new ConflictError('Второй шаг входа уже пройден');
	}

	await completeMfa(sessionId);
	await recordSignIn(ctx, user);
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
