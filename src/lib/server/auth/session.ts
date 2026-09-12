/**
 * Сессии браузера.
 *
 * Cookie хранит только идентификатор — 256 случайных бит, — а всё остальное
 * лежит в Redis. Поэтому сессию можно погасить с сервера: при выходе, при смене
 * пароля, при деактивации пользователя. Подписывать такой cookie нечем и незачем:
 * подделать идентификатор, которого нет в Redis, бесполезно, а угадать его
 * нельзя.
 *
 * Права и имя пользователя в сессии не хранятся: они читаются из базы на каждый
 * запрос. Иначе снятое право продолжало бы действовать до конца рабочего дня.
 */
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Cookies } from '@sveltejs/kit';
import type { SessionUser } from './types';
import { getConfig } from '../config';
import { getDb } from '../db';
import { roles, users } from '../db/schema';
import { demoSessionPermissions, loadRolePermissions } from '../rbac';
import { getRedis } from '../redis';
import { getSetting } from '../settings';

export const SESSION_COOKIE = 'lct_session';

/** Как часто продлевается сессия: чаще раза в минуту Redis дёргать незачем. */
const TOUCH_INTERVAL_MS = 60_000;

const sessionKey = (sessionId: string): string => `session:${sessionId}`;
const userSessionsKey = (userId: string): string => `user_sessions:${userId}`;

/**
 * Идентификатор сессии: 32 случайных байта в base64url. Не UUID — у него
 * случайны не все биты, а cookie сессии это единственное, что отделяет чужой
 * браузер от учётной записи.
 */
export function newSessionId(): string {
	return randomBytes(32).toString('base64url');
}

/** Что известно о сессии. Всё остальное — в базе, по `userId`. */
type SessionRecord = {
	userId: string;
	createdAt: string;
	lastSeenAt: string;
	ip: string | null;
	userAgent: string | null;
};

function parseRecord(raw: string): SessionRecord | null {
	const parsed: unknown = JSON.parse(raw);

	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		typeof (parsed as SessionRecord).userId !== 'string'
	) {
		return null;
	}

	return parsed as SessionRecord;
}

/** Сроки жизни сессии в секундах: по бездействию и предельный. */
async function lifetimes(): Promise<{ idleSeconds: number; absoluteSeconds: number }> {
	const [idleMinutes, absoluteHours] = await Promise.all([
		getSetting('session_idle_minutes'),
		getSetting('session_absolute_hours')
	]);

	return { idleSeconds: idleMinutes * 60, absoluteSeconds: absoluteHours * 3600 };
}

export async function createSession(
	userId: string,
	origin: { ip: string | null; userAgent: string | null }
): Promise<string> {
	const { idleSeconds, absoluteSeconds } = await lifetimes();
	const sessionId = newSessionId();
	const now = new Date().toISOString();

	const record: SessionRecord = {
		userId,
		createdAt: now,
		lastSeenAt: now,
		ip: origin.ip,
		userAgent: origin.userAgent
	};

	await getRedis()
		.multi()
		.set(
			sessionKey(sessionId),
			JSON.stringify(record),
			'EX',
			Math.min(idleSeconds, absoluteSeconds)
		)
		.sadd(userSessionsKey(userId), sessionId)
		// Список сессий пользователя переживает самую долгую из них и не больше:
		// иначе в Redis остаются ключи, за которыми уже ничего нет.
		.expire(userSessionsKey(userId), absoluteSeconds)
		.exec();

	return sessionId;
}

/**
 * Читает сессию и продлевает её. Возвращает идентификатор пользователя или
 * `null`, если сессии нет, она просрочена по бездействию (истёк ключ) или
 * перешагнула предельный срок.
 */
export async function touchSession(sessionId: string): Promise<string | null> {
	const redis = getRedis();
	const raw = await redis.get(sessionKey(sessionId));

	if (raw === null) {
		return null;
	}

	const record = parseRecord(raw);

	if (record === null) {
		await redis.del(sessionKey(sessionId));
		return null;
	}

	const { idleSeconds, absoluteSeconds } = await lifetimes();
	const now = Date.now();
	const expiresAt = Date.parse(record.createdAt) + absoluteSeconds * 1000;

	if (!Number.isFinite(expiresAt) || now >= expiresAt) {
		await destroySession(sessionId);
		return null;
	}

	if (now - Date.parse(record.lastSeenAt) >= TOUCH_INTERVAL_MS) {
		const remaining = Math.ceil((expiresAt - now) / 1000);
		const next: SessionRecord = { ...record, lastSeenAt: new Date(now).toISOString() };

		await redis.set(
			sessionKey(sessionId),
			JSON.stringify(next),
			'EX',
			Math.min(idleSeconds, remaining)
		);
	}

	return record.userId;
}

export async function destroySession(sessionId: string): Promise<void> {
	const redis = getRedis();
	const raw = await redis.get(sessionKey(sessionId));
	const record = raw === null ? null : parseRecord(raw);

	const pipeline = redis.multi().del(sessionKey(sessionId));

	if (record !== null) {
		pipeline.srem(userSessionsKey(record.userId), sessionId);
	}

	await pipeline.exec();
}

/**
 * Гасит все сессии пользователя. Зовётся при смене пароля и при деактивации:
 * и то и другое должно действовать немедленно, а не со следующего входа.
 */
export async function revokeAllSessions(userId: string): Promise<void> {
	const redis = getRedis();
	const sessionIds = await redis.smembers(userSessionsKey(userId));

	const pipeline = redis.multi();
	for (const sessionId of sessionIds) {
		pipeline.del(sessionKey(sessionId));
	}
	pipeline.del(userSessionsKey(userId));

	await pipeline.exec();
}

/**
 * Пользователь запроса: строится из базы каждый раз, потому что роль, права и
 * признак активности меняются без участия владельца сессии. Деактивированный
 * пользователь не собирается вовсе — сессия для него всё равно что погашена.
 *
 * Здесь же проходит граница публичной демонстрации. Она проходит по правам, а
 * не по интерфейсу, и именно в этом месте, потому что через него собирается
 * действующее лицо и для браузера, и для ключа доступа: спрятать кнопку мало,
 * а вычесть право один раз — достаточно для обоих входов.
 */
export async function loadSessionUser(userId: string): Promise<SessionUser | null> {
	const [row] = await getDb()
		.select({
			id: users.id,
			email: users.email,
			fullName: users.fullName,
			roleId: users.roleId,
			isDemo: users.isDemo,
			isActive: users.isActive
		})
		.from(users)
		.innerJoin(roles, eq(roles.id, users.roleId))
		.where(eq(users.id, userId))
		.limit(1);

	if (row === undefined || !row.isActive) {
		return null;
	}

	// Вне демо-режима запись с `is_demo` — обычная учётная запись: признак
	// поднимает не столбец сам по себе, а столбец вместе с режимом стенда.
	const isDemo = row.isDemo && getConfig().DEMO_MODE;
	const rolePermissions = await loadRolePermissions(row.roleId);

	return {
		id: row.id,
		email: row.email,
		fullName: row.fullName,
		roleId: row.roleId,
		permissions: isDemo ? demoSessionPermissions(rolePermissions) : rolePermissions,
		isDemo,
		// Область доступа пока полная у всех ролей: столбца, который сужал бы её до
		// списка организаций, в схеме ещё нет. Сужение появится здесь — в одном
		// месте, а не в выборках, которые уже зовут `scopeFilter`.
		scope: { kind: 'all' }
	};
}

/** Отметка последнего входа. Отдельным запросом: она не часть проверки пароля. */
export async function markSignedIn(userId: string): Promise<void> {
	await getDb()
		.update(users)
		.set({ lastLoginAt: sql`now()` })
		.where(eq(users.id, userId));
}

function cookieOptions(): { httpOnly: true; sameSite: 'lax'; path: '/'; secure: boolean } {
	return {
		httpOnly: true,
		sameSite: 'lax',
		path: '/',
		// На http-происхождении `secure` сделал бы cookie невидимой для самого
		// приложения; на https без неё cookie уехала бы по открытому каналу.
		secure: getConfig().ORIGIN.startsWith('https://')
	};
}

export async function setSessionCookie(cookies: Cookies, sessionId: string): Promise<void> {
	const { idleSeconds, absoluteSeconds } = await lifetimes();

	cookies.set(SESSION_COOKIE, sessionId, {
		...cookieOptions(),
		maxAge: Math.min(idleSeconds, absoluteSeconds)
	});
}

export function clearSessionCookie(cookies: Cookies): void {
	cookies.delete(SESSION_COOKIE, cookieOptions());
}
