import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { isRedirect, type RequestEvent } from '@sveltejs/kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '$lib/server/actor';
import type { SessionUser } from '$lib/server/auth/types';
import { auditEvents, users } from '$lib/server/db/schema';
import { ConflictError, ForbiddenError, ValidationError } from '$lib/server/errors';
import { withinAddressLimit } from '$lib/server/auth/lockout';
import { finishSecondFactor, login } from '$lib/server/auth/login';
import {
	confirmEnrollment,
	disableMfa,
	mfaEnabledFor,
	mfaStateFor,
	pendingEnrollment,
	regenerateBackupCodes,
	resetMfa,
	verifySecondFactor
} from '$lib/server/auth/mfa';
import { createSession, loadSessionUser, touchSession } from '$lib/server/auth/session';
import { totpCodeAt, TOTP_STEP_SECONDS } from '$lib/server/auth/totp';
import { createUser } from '$lib/server/auth/users';
import { guard } from '$lib/server/hooks/guard';
import { session as sessionHook } from '$lib/server/hooks/session';
import { getRedis } from '$lib/server/redis';
import { setSetting } from '$lib/server/settings';
import { startTestDatabase, testActor, type TestDatabase } from '../helpers/db';
import { pageEvent } from '../helpers/event';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

/** Страница второго шага: её загрузчик и её форма — отдельный от сервиса слой. */
const mfaPage = await import('../../../src/routes/(auth)/login/mfa/+page.server');

const loadMfa = mfaPage.load as unknown as (event: RequestEvent) => Promise<unknown>;
const verifyAction = mfaPage.actions.verify as unknown as (event: RequestEvent) => Promise<unknown>;

/**
 * Второй фактор целиком: политика решает, регистрация записывает секрет,
 * проверка впускает — и всё это оставляет след в журнале.
 *
 * Проверять это заглушками нельзя: одноразовость кода и резервного кода держат
 * Redis и база, а не код функции, и подделка проверяла бы подделку.
 */

const PASSWORD = 'Надёжный-Пароль1';

let database: TestDatabase;

const runId = randomUUID().slice(0, 8);
const createdUserIds = new Set<string>();

function email(name: string): string {
	return `${name}-${runId}@example.org`;
}

/** Контекст анонимного посетителя: именно он приходит на форму входа. */
function anonymous(ip: string): ActorContext {
	return {
		requestId: randomUUID(),
		source: 'ui',
		user: null,
		apiKeyId: null,
		ip,
		userAgent: 'vitest',
		scope: { kind: 'organizations', organizationIds: new Set() }
	};
}

/**
 * Пользователь запроса: тот же, что собирает хук сессии, с признаком неполной
 * сессии поверх. По умолчанию — тот, кто пароль назвал, а кода ещё нет.
 */
async function sessionUserFor(userId: string, mfaPending = true): Promise<SessionUser> {
	const user = await loadSessionUser(userId);

	if (user === null) {
		throw new Error('Пользователь прогона обязан собираться');
	}

	return { ...user, mfaPending };
}

/** Контекст владельца неполной сессии: пароль назван, второго шага ещё нет. */
async function signedIn(userId: string, options: { mfaPending?: boolean } = {}) {
	const user = await sessionUserFor(userId, options.mfaPending ?? true);

	const ctx: ActorContext = {
		requestId: randomUUID(),
		source: 'ui',
		user,
		apiKeyId: null,
		ip: '198.51.100.7',
		userAgent: 'vitest',
		scope: user.scope
	};

	return ctx;
}

/**
 * Отправка формы второго шага в том виде, в каком её собирает SvelteKit.
 * Общей подделки события здесь мало: действию нужна cookie сессии, которую она
 * не отдаёт.
 */
function verifyEvent(options: {
	user: SessionUser;
	sessionId: string;
	code: string;
}): RequestEvent {
	const url = new URL('http://localhost/login/mfa?/verify');
	const body = new FormData();
	body.set('code', options.code);

	return {
		request: new Request(url, { method: 'POST', body }),
		url,
		params: {},
		cookies: { get: () => options.sessionId, set: () => {}, delete: () => {} },
		route: { id: '/(auth)/login/mfa' },
		locals: { requestId: randomUUID(), user: options.user, apiKey: null },
		getClientAddress: () => '198.51.100.7',
		setHeaders: () => {},
		isDataRequest: false,
		isSubRequest: false
	} as unknown as RequestEvent;
}

async function newUser(options: {
	name: string;
	roleId?: string;
	isDemo?: boolean;
}): Promise<{ id: string; email: string }> {
	const created = await createUser(testActor(), {
		email: email(options.name),
		fullName: 'Иванов Иван',
		roleId: options.roleId ?? 'admin',
		password: PASSWORD,
		isDemo: options.isDemo
	});

	createdUserIds.add(created.id);

	return { id: created.id, email: created.email };
}

/** Секрет, уже записанный в учётную запись: половина тестов начинается отсюда. */
async function enrolled(userId: string): Promise<{ secret: string; backupCodes: string[] }> {
	const ctx = await signedIn(userId);
	const sessionId = randomUUID();
	const { secret } = await pendingEnrollment(ctx, sessionId);
	const backupCodes = await confirmEnrollment(ctx, {
		sessionId,
		code: totpCodeAt(secret, Date.now())
	});

	return { secret, backupCodes };
}

/**
 * Код следующего шага. Код текущего шага после регистрации уже помечен
 * использованным — им её и подтвердили, — поэтому проверять проверку надо
 * другим.
 */
function nextCode(secret: string, shift = 1): { code: string; at: number } {
	const at = Date.now() + shift * TOTP_STEP_SECONDS * 1000;

	return { code: totpCodeAt(secret, at), at };
}

async function auditOf(type: string): Promise<{ outcome: string; details: unknown }[]> {
	return database.db
		.select({ outcome: auditEvents.outcome, details: auditEvents.details })
		.from(auditEvents)
		.where(eq(auditEvents.eventType, type))
		.orderBy(asc(auditEvents.occurredAt));
}

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	getRedis().disconnect();
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();
	createdUserIds.clear();
});

describe('политика на входе', () => {
	it('заводит неполную сессию, не записывая вход, и коротким сроком', async () => {
		const user = await newUser({ name: 'policy' });

		const outcome = await login(anonymous('203.0.113.1'), {
			email: user.email,
			password: PASSWORD
		});

		expect(outcome).toMatchObject({ ok: true, mfaPending: true });
		if (!outcome.ok) return;

		expect(await touchSession(outcome.sessionId)).toEqual({
			userId: user.id,
			mfaPending: true
		});

		// Вход ещё не состоялся: пароль назван, второй шаг не пройден.
		expect(await auditOf('auth.login')).toEqual([]);

		const [row] = await database.db
			.select({ lastLoginAt: users.lastLoginAt })
			.from(users)
			.where(eq(users.id, user.id));
		expect(row.lastLoginAt).toBeNull();

		// Пять минут вместо получаса бездействия: сессия на одном пароле не
		// должна жить рабочий день.
		const ttl = await getRedis().ttl(`session:${outcome.sessionId}`);
		expect(ttl).toBeGreaterThan(4 * 60);
		expect(ttl).toBeLessThanOrEqual(5 * 60);
	});

	it('не трогает роль, которой фактор не нужен', async () => {
		const user = await newUser({ name: 'manager', roleId: 'manager' });

		const outcome = await login(anonymous('203.0.113.2'), {
			email: user.email,
			password: PASSWORD
		});

		expect(outcome).toMatchObject({ ok: true, mfaPending: false });
		expect(await auditOf('auth.login')).toHaveLength(1);
	});

	it('не спрашивает фактор из доверенной сети, пока политика про удалённый доступ', async () => {
		await setSetting(testActor(), 'mfa_policy', {
			requiredForRoles: ['admin'],
			remoteOnly: true,
			trustedNetworks: ['198.51.100.0/24']
		});

		const user = await newUser({ name: 'office' });

		const inside = await login(anonymous('198.51.100.7'), {
			email: user.email,
			password: PASSWORD
		});
		expect(inside).toMatchObject({ ok: true, mfaPending: false });

		const outside = await login(anonymous('203.0.113.3'), {
			email: user.email,
			password: PASSWORD
		});
		expect(outside).toMatchObject({ ok: true, mfaPending: true });
	});
});

describe('гвардия', () => {
	/**
	 * Запрос страницы приложения с cookie сессии — через те же два хука и в том
	 * же порядке, что в `hooks.server.ts`.
	 */
	async function requestApp(sessionId: string): Promise<unknown> {
		const url = new URL('http://localhost/audit');
		const event = {
			url,
			request: new Request(url),
			route: { id: '/(app)/audit' },
			cookies: { get: () => sessionId, set: () => {}, delete: () => {} },
			locals: { requestId: randomUUID(), user: null, apiKey: null }
		} as unknown as RequestEvent;

		return Promise.resolve(
			sessionHook({
				event,
				resolve: (inner: RequestEvent) =>
					guard({ event: inner, resolve: () => new Response('страница раздела') })
			} as unknown as Parameters<typeof sessionHook>[0])
		).then(
			(response) => response,
			(failure: unknown) => failure
		);
	}

	it('не пускает неполную сессию в приложение и уводит её на второй шаг', async () => {
		const user = await newUser({ name: 'guard' });
		const sessionId = await createSession(
			user.id,
			{ ip: '203.0.113.4', userAgent: 'vitest' },
			{ mfaPending: true }
		);

		const thrown = await requestApp(sessionId);

		expect(isRedirect(thrown)).toBe(true);
		expect((thrown as { location: string }).location).toBe('/login/mfa?next=%2Faudit');
	});

	it('полную сессию пускает', async () => {
		const user = await newUser({ name: 'guard-ok' });
		const sessionId = await createSession(user.id, { ip: '203.0.113.5', userAgent: 'vitest' });

		const response = await requestApp(sessionId);

		expect(response).toBeInstanceOf(Response);
		expect((response as Response).status).toBe(200);
	});
});

describe('регистрация', () => {
	it('отдаёт один и тот же секрет, пока регистрация не закончена', async () => {
		const user = await newUser({ name: 'enroll-stable' });
		const ctx = await signedIn(user.id);
		const sessionId = randomUUID();

		const first = await pendingEnrollment(ctx, sessionId);
		const second = await pendingEnrollment(ctx, sessionId);

		// Иначе человек, переснявший код после перезагрузки страницы, подтверждал
		// бы не тот секрет, который унёс в приложение.
		expect(second.secret).toBe(first.secret);
		expect(first.uri).toContain(`secret=${first.secret}`);

		// До подтверждения фактора у учётной записи нет.
		expect(await mfaStateFor(user.id)).toMatchObject({ enabled: false, backupCodesLeft: 0 });
	});

	it('записывает секрет только после верного кода и выдаёт резервные коды', async () => {
		const user = await newUser({ name: 'enroll' });
		const ctx = await signedIn(user.id);
		const sessionId = randomUUID();
		const { secret } = await pendingEnrollment(ctx, sessionId);

		const codes = await confirmEnrollment(ctx, { sessionId, code: totpCodeAt(secret, Date.now()) });

		expect(codes).toHaveLength(10);
		expect(new Set(codes).size).toBe(10);
		for (const code of codes) {
			expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
		}

		expect(await mfaStateFor(user.id)).toMatchObject({ enabled: true, backupCodesLeft: 10 });
		expect(await auditOf('auth.mfa_enrolled')).toEqual([
			{ outcome: 'success', details: { userId: user.id } }
		]);

		// Резервные коды в базе только отпечатками: показать их второй раз нечем.
		const [row] = await database.db
			.select({ hashes: users.totpBackupCodes })
			.from(users)
			.where(eq(users.id, user.id));
		expect(row.hashes).toHaveLength(10);
		for (const hash of row.hashes ?? []) {
			expect(hash).toMatch(/^[0-9a-f]{64}$/);
			expect(codes).not.toContain(hash);
		}
	});

	it('не записывает секрет по неверному коду и пишет неудачу в журнал', async () => {
		const user = await newUser({ name: 'enroll-bad' });
		const ctx = await signedIn(user.id);
		const sessionId = randomUUID();
		await pendingEnrollment(ctx, sessionId);

		await expect(confirmEnrollment(ctx, { sessionId, code: '000000' })).rejects.toBeInstanceOf(
			ValidationError
		);

		expect(await mfaStateFor(user.id)).toMatchObject({ enabled: false });
		expect(await auditOf('auth.mfa_failed')).toEqual([
			{ outcome: 'failure', details: { userId: user.id } }
		]);
	});

	it('не подтверждается без начатой регистрации', async () => {
		const user = await newUser({ name: 'enroll-none' });
		const ctx = await signedIn(user.id);

		await expect(
			confirmEnrollment(ctx, { sessionId: randomUUID(), code: '000000' })
		).rejects.toBeInstanceOf(ConflictError);
	});
});

describe('проверка кода', () => {
	it('впускает по коду из приложения и пишет это в журнал', async () => {
		const user = await newUser({ name: 'verify' });
		const { secret } = await enrolled(user.id);
		const ctx = await signedIn(user.id);

		const outcome = await verifySecondFactor(ctx, { code: nextCode(secret).code });

		expect(outcome).toEqual({ ok: true, kind: 'totp', backupCodesLeft: 10 });
		expect(await auditOf('auth.mfa_verified')).toEqual([
			{ outcome: 'success', details: { userId: user.id } }
		]);
	});

	it('не принимает тот же код второй раз', async () => {
		const user = await newUser({ name: 'replay' });
		const { secret } = await enrolled(user.id);
		const ctx = await signedIn(user.id);
		const { code } = nextCode(secret);

		expect(await verifySecondFactor(ctx, { code })).toMatchObject({ ok: true });

		// Код действует целое окно: без отметки об использованном шаге
		// подсмотренный код проходит второй раз, пока окно не закрылось.
		expect(await verifySecondFactor(ctx, { code })).toEqual({
			ok: false,
			message: 'Этот код уже использован — дождитесь следующего'
		});
	});

	it('не принимает чужой код и считает неудачу в блокировку входа', async () => {
		const user = await newUser({ name: 'wrong' });
		await enrolled(user.id);
		const ctx = await signedIn(user.id);

		await setSetting(testActor(), 'lockout_policy', { attempts: 2, minutes: 15 });

		expect(await verifySecondFactor(ctx, { code: '000000' })).toEqual({
			ok: false,
			message: 'Код не подошёл'
		});
		expect(await verifySecondFactor(ctx, { code: '000001' })).toEqual({
			ok: false,
			message: 'Код не подошёл'
		});

		// Третья попытка до проверки кода уже не доходит: перебор шестизначного
		// кода должен упираться в ту же блокировку, что и перебор пароля.
		const locked = await verifySecondFactor(ctx, { code: '000002' });
		expect(locked.ok).toBe(false);
		expect(locked.ok === false && locked.message).toMatch(/^Слишком много неудачных попыток/);

		expect(await auditOf('auth.mfa_failed')).toHaveLength(2);
		expect(await auditOf('auth.locked')).toEqual([
			{ outcome: 'denied', details: { userId: user.id } }
		]);
	});

	it('принимает резервный код один раз и списывает его', async () => {
		const user = await newUser({ name: 'backup' });
		const { backupCodes } = await enrolled(user.id);
		const ctx = await signedIn(user.id);
		const code = backupCodes[0];

		expect(await verifySecondFactor(ctx, { code })).toEqual({
			ok: true,
			kind: 'backup',
			backupCodesLeft: 9
		});

		// Второй раз тот же код не работает: он списан из базы, а не помечен.
		expect(await verifySecondFactor(ctx, { code })).toMatchObject({ ok: false });
		expect(await mfaStateFor(user.id)).toMatchObject({ backupCodesLeft: 9 });

		// Резервный код записан отдельно от кода из приложения: по журналу видно,
		// что человек вошёл не приложением.
		expect(await auditOf('auth.mfa_verified')).toEqual([
			{ outcome: 'success', details: { userId: user.id, changedFields: ['totpBackupCodes'] } }
		]);
	});

	it('списывает резервный код один раз, сколько бы попыток ни пришло разом', async () => {
		const user = await newUser({ name: 'backup-race' });
		const { backupCodes } = await enrolled(user.id);
		const code = backupCodes[0];

		// Один листок с кодами в трёх руках: три неполные сессии одной учётной
		// записи предъявляют один и тот же код одновременно. Проверка и списание
		// обязаны быть неделимы — иначе все трое читают полный набор, все трое
		// вычитают из него один и тот же код, и войти успевает каждый.
		const contexts = await Promise.all([signedIn(user.id), signedIn(user.id), signedIn(user.id)]);
		const outcomes = await Promise.all(contexts.map((ctx) => verifySecondFactor(ctx, { code })));

		expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
		expect(await mfaStateFor(user.id)).toMatchObject({ backupCodesLeft: 9 });
	});

	it('не тратит резервный код на сессии, которая второй шаг уже прошла', async () => {
		const user = await newUser({ name: 'backup-full' });
		const { backupCodes } = await enrolled(user.id);
		const ctx = await signedIn(user.id, { mfaPending: false });

		// Подтверждать нечего: шаг пройден. Расход кода здесь — потеря одного из
		// десяти ключей ни за что.
		await expect(verifySecondFactor(ctx, { code: backupCodes[0] })).rejects.toBeInstanceOf(
			ConflictError
		);
		expect(await mfaStateFor(user.id)).toMatchObject({ backupCodesLeft: 10 });
	});

	it('терпит резервный код, переписанный без дефисов и в нижнем регистре', async () => {
		const user = await newUser({ name: 'backup-format' });
		const { backupCodes } = await enrolled(user.id);
		const ctx = await signedIn(user.id);

		const typed = backupCodes[0].replace(/-/g, '').toLowerCase();
		expect(await verifySecondFactor(ctx, { code: typed })).toMatchObject({ ok: true });
	});

	it('закрывает второй шаг: сессия становится полной, а вход попадает в журнал', async () => {
		const user = await newUser({ name: 'finish' });
		const { secret } = await enrolled(user.id);
		const sessionId = await createSession(
			user.id,
			{ ip: '203.0.113.6', userAgent: 'vitest' },
			{ mfaPending: true }
		);
		const ctx = await signedIn(user.id);

		expect(await verifySecondFactor(ctx, { code: nextCode(secret).code })).toMatchObject({
			ok: true
		});
		await finishSecondFactor(ctx, sessionId);

		expect(await touchSession(sessionId)).toEqual({ userId: user.id, mfaPending: false });
		expect(await auditOf('auth.login')).toEqual([
			{ outcome: 'success', details: { userId: user.id } }
		]);

		// Срок жизни — обычный, а не остаток пяти минут второго шага.
		expect(await getRedis().ttl(`session:${sessionId}`)).toBeGreaterThan(5 * 60);
	});

	it('не закрывает шаг, которого не было', async () => {
		const user = await newUser({ name: 'finish-twice' });
		await enrolled(user.id);
		const sessionId = await createSession(user.id, { ip: null, userAgent: null });
		const ctx = await signedIn(user.id, { mfaPending: false });

		await expect(finishSecondFactor(ctx, sessionId)).rejects.toBeInstanceOf(ConflictError);
		expect(await auditOf('auth.login')).toEqual([]);
	});
});

describe('управление фактором', () => {
	it('не даёт владельцу отключить фактор, обязательный для его роли', async () => {
		const user = await newUser({ name: 'disable-required' });
		const { secret } = await enrolled(user.id);
		const ctx = await signedIn(user.id, { mfaPending: false });

		await expect(disableMfa(ctx, { code: nextCode(secret).code })).rejects.toBeInstanceOf(
			ForbiddenError
		);
		expect(await mfaStateFor(user.id)).toMatchObject({ enabled: true });
	});

	it('отключает фактор по коду там, где политика его не требует', async () => {
		const user = await newUser({ name: 'disable', roleId: 'manager' });
		const { secret } = await enrolled(user.id);
		const ctx = await signedIn(user.id, { mfaPending: false });

		await expect(disableMfa(ctx, { code: '000000' })).rejects.toBeInstanceOf(ValidationError);
		expect(await mfaStateFor(user.id)).toMatchObject({ enabled: true });

		await disableMfa(ctx, { code: nextCode(secret).code });

		expect(await mfaStateFor(user.id)).toMatchObject({ enabled: false, backupCodesLeft: 0 });
		expect(await auditOf('auth.mfa_disabled')).toEqual([
			{ outcome: 'success', details: { userId: user.id } }
		]);
	});

	it('не отключает фактор резервным кодом', async () => {
		const user = await newUser({ name: 'disable-backup', roleId: 'manager' });
		const { backupCodes } = await enrolled(user.id);
		const ctx = await signedIn(user.id, { mfaPending: false });

		// Иначе потерянного листка с кодами хватило бы, чтобы снять защиту совсем.
		await expect(disableMfa(ctx, { code: backupCodes[0] })).rejects.toBeInstanceOf(ValidationError);
		expect(await mfaStateFor(user.id)).toMatchObject({ enabled: true, backupCodesLeft: 10 });
	});

	it('перевыпускает резервные коды, гася прежние', async () => {
		const user = await newUser({ name: 'codes' });
		const { secret, backupCodes } = await enrolled(user.id);
		const ctx = await signedIn(user.id, { mfaPending: false });

		const fresh = await regenerateBackupCodes(ctx, { code: nextCode(secret).code });

		expect(fresh).toHaveLength(10);
		expect(fresh.filter((code) => backupCodes.includes(code))).toEqual([]);

		// Проверяются коды на следующем входе, то есть на неполной сессии: полная
		// второй шаг не проходит и кода не тратит.
		const next = await signedIn(user.id);
		expect(await verifySecondFactor(next, { code: backupCodes[0] })).toMatchObject({
			ok: false
		});
		expect(await verifySecondFactor(next, { code: fresh[0] })).toMatchObject({ ok: true });
	});

	it('сбрасывается администратором вместе с сессиями владельца', async () => {
		const user = await newUser({ name: 'reset' });
		await enrolled(user.id);
		const sessionId = await createSession(user.id, { ip: null, userAgent: null });

		await resetMfa(testActor(), user.id);

		expect(await mfaStateFor(user.id)).toMatchObject({ enabled: false, backupCodesLeft: 0 });
		// Сброс делают, когда фактор мог достаться кому-то ещё: открытая где-то
		// вкладка не должна его пережить.
		expect(await touchSession(sessionId)).toBeNull();
		expect(await auditOf('auth.mfa_reset')).toEqual([
			{ outcome: 'success', details: { userId: user.id } }
		]);
	});

	it('сбрасывать даёт только тому, кто управляет пользователями', async () => {
		const user = await newUser({ name: 'reset-denied' });
		await enrolled(user.id);

		await expect(resetMfa(testActor({ roleId: 'manager' }), user.id)).rejects.toBeInstanceOf(
			ForbiddenError
		);

		expect(await mfaStateFor(user.id)).toMatchObject({ enabled: true });
		expect(await auditOf('auth.mfa_reset')).toEqual([{ outcome: 'denied', details: {} }]);
	});

	it('не сбрасывает то, чего нет', async () => {
		const user = await newUser({ name: 'reset-none' });

		await expect(resetMfa(testActor(), user.id)).rejects.toBeInstanceOf(ConflictError);
	});

	it('отвечает списку пользователей, у кого фактор подключён', async () => {
		const withFactor = await newUser({ name: 'list-on' });
		const without = await newUser({ name: 'list-off' });
		await enrolled(withFactor.id);

		const enabled = await mfaEnabledFor([withFactor.id, without.id]);

		expect(enabled.has(withFactor.id)).toBe(true);
		expect(enabled.has(without.id)).toBe(false);
		expect(await mfaEnabledFor([])).toEqual(new Set());
	});
});

describe('страница второго шага', () => {
	it('говорит про исчерпанный лимит адреса, а не показывает нерабочую форму', async () => {
		const user = await newUser({ name: 'page-limit' });
		await enrolled(user.id);
		const pending = await sessionUserFor(user.id);
		const event = () => pageEvent({ path: '/login/mfa', user: pending });

		type MfaPageData = { rateLimited: string | null };

		expect((await loadMfa(event())) as MfaPageData).toMatchObject({ rateLimited: null });

		// Окно выбирается тем же вызовом, которым его считает хук: порог здесь не
		// повторяется числом, иначе тест разошёлся бы с настройкой молча.
		let allowed = true;
		while (allowed) {
			allowed = await withinAddressLimit('198.51.100.10');
		}

		// Форма второго шага отправляется тем же POST на маршрут `(auth)`: его
		// развернёт хук, и человек будет жать «Подтвердить» в пустоту, если
		// страница не скажет, что происходит.
		const data = (await loadMfa(event())) as MfaPageData;
		expect(data.rateLimited).toMatch(/^Слишком много входов с этого адреса/);
	});

	it('отказывает форме второго шага на полной сессии, не тратя резервный код', async () => {
		const user = await newUser({ name: 'page-full' });
		const { backupCodes } = await enrolled(user.id);
		const pending = await sessionUserFor(user.id, false);
		const sessionId = await createSession(user.id, { ip: null, userAgent: null });

		// Шаг уже пройден: закрыть его второй раз нечем, и ответ на это — отказ
		// формы, а не сбой сервера. Код при этом обязан остаться неизрасходованным.
		const failure = await verifyAction(
			verifyEvent({ user: pending, sessionId, code: backupCodes[0] })
		);

		expect(failure).toMatchObject({
			status: 409,
			data: { message: 'Второй шаг входа уже пройден' }
		});
		expect(await mfaStateFor(user.id)).toMatchObject({ backupCodesLeft: 10 });
	});
});
