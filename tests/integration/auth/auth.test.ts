import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { isRedirect, type RequestEvent } from '@sveltejs/kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '$lib/server/actor';
import { rateLimit } from '$lib/server/hooks/rate-limit';
import { auditEvents, users } from '$lib/server/db/schema';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '$lib/server/errors';
import { pageQuerySchema } from '$lib/contracts/common';
import { demoLogin, listDemoAccounts, login } from '$lib/server/auth/login';
import { addressLimitState, withinAddressLimit } from '$lib/server/auth/lockout';
import {
	createSession,
	loadSessionUser,
	revokeAllSessions,
	touchSession
} from '$lib/server/auth/session';
import {
	activateUser,
	changePassword,
	createUser,
	deactivateUser,
	listUsers,
	lookupUsers
} from '$lib/server/auth/users';
import { getRedis } from '$lib/server/redis';
import { setSetting } from '$lib/server/settings';
import { startTestDatabase, testActor, TEST_USER_IDS, type TestDatabase } from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

/**
 * `DEMO_MODE` читается из конфигурации, а она разбирается один раз за процесс —
 * переставить переменную окружения между тестами уже нельзя. Подменяем саму
 * функцию: остальные значения остаются настоящими, включая адрес контейнера,
 * который `startTestDatabase` кладёт в окружение перед первым обращением.
 */
const demo = vi.hoisted(() => ({ mode: false }));

vi.mock('$lib/server/config', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/config')>();

	return { ...actual, getConfig: () => ({ ...actual.getConfig(), DEMO_MODE: demo.mode }) };
});

let database: TestDatabase;

/**
 * Redis у интеграционных тестов общий с разработчиком — база поднимается в
 * контейнере, а Redis берётся из compose. Поэтому ключи теста помечены меткой
 * прогона и удаляются после каждого теста: чужие сессии в той же базе Redis
 * остаются нетронутыми.
 */
const runId = randomUUID().slice(0, 8);
const createdUserIds = new Set<string>();
const usedAddresses = new Set<string>();

function email(name: string): string {
	return `${name}-${runId}@example.org`;
}

function address(last: number): string {
	const ip = `198.51.100.${last}`;
	usedAddresses.add(ip);
	return ip;
}

/** Загрузчик страницы входа: он решает, показывать форму или объяснять отказ. */
const loginPage = await import('../../../src/routes/(auth)/login/+page.server');

const loadLogin = loginPage.load as unknown as (
	event: RequestEvent
) => Promise<{ rateLimited: string | null }>;

/**
 * Запрос к странице входа в том виде, в каком его собирает SvelteKit. Хуку и
 * загрузчику нужны адрес вызывающего, метод, маршрут и `locals` — остальное в
 * подделке не участвует.
 */
function loginEvent(ip: string, options: { method?: string; query?: string } = {}): RequestEvent {
	const url = new URL(`http://localhost/login${options.query ?? ''}`);

	return {
		request: new Request(url, { method: options.method ?? 'GET' }),
		url,
		params: {},
		cookies: { get: () => undefined, set: () => {}, delete: () => {} },
		route: { id: '/(auth)/login' },
		locals: { requestId: randomUUID(), user: null, apiKey: null },
		getClientAddress: () => ip,
		setHeaders: () => {},
		isDataRequest: false,
		isSubRequest: false
	} as unknown as RequestEvent;
}

/**
 * Один POST на форму входа через хук лимита. Возвращает либо ответ маршрута,
 * либо то, что хук бросил: исчерпанный лимит — это брошенное перенаправление, и
 * проверять надо именно его, а не собранный ответ.
 */
async function postLogin(ip: string, query?: string): Promise<unknown> {
	return Promise.resolve(
		rateLimit({
			event: loginEvent(ip, { method: 'POST', query }),
			resolve: async () => new Response('форма принята')
		} as unknown as Parameters<typeof rateLimit>[0])
	).then(
		(response) => response,
		(failure: unknown) => failure
	);
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

async function newUser(options: {
	name: string;
	password: string;
	roleId?: string;
	isDemo?: boolean;
}): Promise<{ id: string; email: string }> {
	const created = await createUser(testActor(), {
		email: email(options.name),
		fullName: 'Иванов Иван',
		roleId: options.roleId ?? 'manager',
		password: options.password,
		isDemo: options.isDemo
	});

	createdUserIds.add(created.id);

	return { id: created.id, email: created.email };
}

async function forgetRedisKeys(): Promise<void> {
	const redis = getRedis();

	for (const userId of createdUserIds) {
		await revokeAllSessions(userId);
	}
	createdUserIds.clear();

	const failureKeys = await redis.keys(`login_fail:*${runId}*`);
	const addressKeys = [...usedAddresses].map((ip) => `login_ip:${ip}`);
	usedAddresses.clear();

	if (failureKeys.length + addressKeys.length > 0) {
		await redis.del(...failureKeys, ...addressKeys);
	}
}

const PASSWORD = 'Надёжный-Пароль1';

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await forgetRedisKeys();
	getRedis().disconnect();
	await database?.stop();
});

beforeEach(async () => {
	await forgetRedisKeys();
	await database.reset();
	demo.mode = false;
});

/** События журнала по типу, в порядке появления. */
async function auditOf(type: string): Promise<{ outcome: string; details: unknown }[]> {
	return database.db
		.select({ outcome: auditEvents.outcome, details: auditEvents.details })
		.from(auditEvents)
		.where(eq(auditEvents.eventType, type))
		.orderBy(asc(auditEvents.occurredAt));
}

describe('вход', () => {
	it('впускает с верным паролем, заводит сессию и пишет в журнал', async () => {
		const user = await newUser({ name: 'ivanov', password: PASSWORD });

		const outcome = await login(anonymous(address(1)), { email: user.email, password: PASSWORD });

		expect(outcome).toMatchObject({ ok: true });
		if (!outcome.ok) return;

		// Сессия полная: политика второго фактора роли менеджера его не требует.
		expect(await touchSession(outcome.sessionId)).toEqual({
			userId: user.id,
			mfaPending: false
		});

		const session = await loadSessionUser(user.id);
		expect(session).toMatchObject({ id: user.id, roleId: 'manager' });
		expect(session?.permissions.has('interactions.write')).toBe(true);

		expect(await auditOf('auth.login')).toEqual([
			{ outcome: 'success', details: { userId: user.id } }
		]);

		// Почта в разных регистрах — один и тот же человек.
		const again = await login(anonymous(address(1)), {
			email: user.email.toUpperCase(),
			password: PASSWORD
		});
		expect(again.ok).toBe(true);
	});

	it('отказывает одинаково неверному паролю и незаведённой почте', async () => {
		const user = await newUser({ name: 'petrov', password: PASSWORD });
		const ip = address(2);

		const wrongPassword = await login(anonymous(ip), {
			email: user.email,
			password: 'Другой-Пароль1'
		});
		const unknownEmail = await login(anonymous(ip), {
			email: email('never-existed'),
			password: PASSWORD
		});

		expect(wrongPassword).toEqual({
			ok: false,
			reason: 'invalid',
			message: 'Неверная почта или пароль'
		});
		expect(unknownEmail).toEqual(wrongPassword);

		// Неудача записывается всегда, даже когда записывать нечего, кроме факта.
		const failures = await auditOf('auth.login_failed');
		expect(failures).toEqual([
			{ outcome: 'failure', details: { userId: user.id } },
			{ outcome: 'failure', details: {} }
		]);
	});

	it('записывает удачный вход от лица вошедшего, а не анонимного посетителя', async () => {
		const user = await newUser({ name: 'akter', password: PASSWORD });

		// Форму входа заполняет ещё аноним: пользователя в контексте нет ни у
		// неудачной попытки, ни у удачной.
		await login(anonymous(address(20)), { email: user.email, password: 'Мимо-Пароля1' });
		expect(
			await login(anonymous(address(20)), { email: user.email, password: PASSWORD })
		).toMatchObject({ ok: true });

		const events = await database.db
			.select({
				type: auditEvents.eventType,
				actorUserId: auditEvents.actorUserId,
				actorLabel: auditEvents.actorLabel
			})
			.from(auditEvents)
			.where(eq(auditEvents.actorUserId, user.id));

		// Кто вошёл — это и есть ответ на вопрос «кто действовал»; неудачная
		// попытка остаётся анонимной, её мог сделать кто угодно.
		expect(events).toEqual([
			{ type: 'auth.login', actorUserId: user.id, actorLabel: 'Иванов Иван' }
		]);
	});

	it('не впускает выключенного пользователя и гасит его сессии', async () => {
		const user = await newUser({ name: 'uvolen', password: PASSWORD });
		const first = await createSession(user.id, { ip: null, userAgent: null });
		const second = await createSession(user.id, { ip: null, userAgent: null });

		await deactivateUser(testActor(), user.id);

		expect(await touchSession(first)).toBeNull();
		expect(await touchSession(second)).toBeNull();

		const outcome = await login(anonymous(address(3)), { email: user.email, password: PASSWORD });
		expect(outcome).toMatchObject({ ok: false, reason: 'invalid' });
	});
});

describe('блокировка после неудачных попыток', () => {
	beforeEach(async () => {
		await setSetting(testActor(), 'lockout_policy', { attempts: 3, minutes: 1 });
	});

	it('закрывает вход после заданного числа неудач и открывает по истечении срока', async () => {
		const user = await newUser({ name: 'podbor', password: PASSWORD });
		const ip = address(4);

		for (let attempt = 0; attempt < 3; attempt += 1) {
			const refusal = await login(anonymous(ip), { email: user.email, password: 'Мимо-Пароля1' });
			expect(refusal).toMatchObject({ reason: 'invalid' });
		}

		// Четвёртая попытка не доходит до проверки пароля — даже с верным.
		const locked = await login(anonymous(ip), { email: user.email, password: PASSWORD });
		expect(locked).toMatchObject({ ok: false, reason: 'locked' });
		expect(locked.ok === false && locked.message).toMatch(/ещё 1 минуту/);

		expect(await auditOf('auth.locked')).toEqual([
			{ outcome: 'denied', details: { userId: user.id } }
		]);

		const key = `login_fail:${user.email}:${ip}`;
		const redis = getRedis();
		expect(await redis.ttl(key)).toBeGreaterThan(50);
		expect(await redis.ttl(key)).toBeLessThanOrEqual(60);

		// Срок жизни счётчика и есть срок блокировки: как только ключ ушёл,
		// вход открыт снова.
		await redis.pexpire(key, 1);
		await new Promise((resolve) => setTimeout(resolve, 40));

		expect(await login(anonymous(ip), { email: user.email, password: PASSWORD })).toMatchObject({
			ok: true
		});
	});

	it('снимает счётчик после удачного входа', async () => {
		const user = await newUser({ name: 'oshibsya', password: PASSWORD });
		const ip = address(5);

		await login(anonymous(ip), { email: user.email, password: 'Мимо-Пароля1' });
		await login(anonymous(ip), { email: user.email, password: PASSWORD });

		expect(await getRedis().exists(`login_fail:${user.email}:${ip}`)).toBe(0);
	});

	it('не закрывает демонстрационную учётную запись, пока включён демо-режим', async () => {
		demo.mode = true;
		const user = await newUser({ name: 'demo', password: PASSWORD, isDemo: true });
		const ip = address(6);

		for (let attempt = 0; attempt < 5; attempt += 1) {
			await login(anonymous(ip), { email: user.email, password: 'Мимо-Пароля1' });
		}

		expect(await getRedis().exists(`login_fail:${user.email}:${ip}`)).toBe(0);
		expect(await login(anonymous(ip), { email: user.email, password: PASSWORD })).toMatchObject({
			ok: true
		});

		// Вне демо-режима та же учётная запись — обычная.
		demo.mode = false;
		for (let attempt = 0; attempt < 3; attempt += 1) {
			await login(anonymous(ip), { email: user.email, password: 'Мимо-Пароля1' });
		}

		expect(await login(anonymous(ip), { email: user.email, password: PASSWORD })).toMatchObject({
			ok: false,
			reason: 'locked'
		});
	});

	it('считает попытки с одного адреса и отсекает после тридцати', async () => {
		const ip = address(7);

		for (let attempt = 1; attempt <= 30; attempt += 1) {
			expect(await withinAddressLimit(ip)).toBe(true);
		}

		expect(await withinAddressLimit(ip)).toBe(false);
		expect(await getRedis().ttl(`login_ip:${ip}`)).toBeGreaterThan(60);

		// Страница входа спрашивает то же состояние, ничего не считая: по нему она
		// решает, рисовать форму или объяснять, сколько ждать.
		const state = await addressLimitState(ip);
		expect(state.exhausted).toBe(true);
		expect(state.remainingSeconds).toBeGreaterThan(60);
	});

	it('не тратит лимит адреса на удачные входы', async () => {
		const user = await newUser({ name: 'za-natom', password: PASSWORD });
		const ip = address(13);

		// Жюри и класс сидят за одним NAT: для счётчика это один адрес. Тридцать
		// первый обычный вход не должен упираться в защиту от перебора — перебора
		// тут нет, каждый раз подходит пароль.
		for (let attempt = 1; attempt <= 31; attempt += 1) {
			expect(await withinAddressLimit(ip)).toBe(true);
			expect(await login(anonymous(ip), { email: user.email, password: PASSWORD })).toMatchObject({
				ok: true
			});
		}

		expect(await getRedis().exists(`login_ip:${ip}`)).toBe(0);
		expect((await addressLimitState(ip)).exhausted).toBe(false);
	});

	it('разворачивает исчерпавший лимит POST обратно на страницу входа', async () => {
		const ip = address(17);

		for (let attempt = 1; attempt <= 30; attempt += 1) {
			expect(await postLogin(ip)).toMatchObject({ status: 200 });
		}

		// Голый 429 человеку ничего не объясняет, поэтому отказ уводит на ту же
		// страницу входа — она видит тот же счётчик и говорит словами.
		// Перенаправление именно бросается: форму входа отправляет `use:enhance`,
		// и вид ответа для неё выбирает SvelteKit. Готовый 303 приехал бы к ней
		// разметкой страницы входа вместо конверта, и форма сломалась бы на его
		// разборе вместо того, чтобы показать отказ.
		const refused = await postLogin(ip);
		expect(isRedirect(refused)).toBe(true);
		expect(refused).toMatchObject({ status: 303, location: '/login' });

		// Куда человек шёл, из-за отказа теряться не должно.
		const withNext = await postLogin(ip, '?next=%2Faudit');
		expect(isRedirect(withNext)).toBe(true);
		expect(withNext).toMatchObject({ status: 303, location: '/login?next=%2Faudit' });

		const data = await loadLogin(loginEvent(ip));

		// Форму и кнопки страница по этому сообщению и прячет: жать их незачем,
		// POST с них всё равно развернёт сюда же.
		expect(data.rateLimited).toBe('Слишком много входов с этого адреса. Попробуйте через 15 минут');
	});

	it('до исчерпания лимита страница входа ничего не сообщает', async () => {
		const ip = address(18);

		expect(await postLogin(ip)).toMatchObject({ status: 200 });
		expect((await loadLogin(loginEvent(ip))).rateLimited).toBeNull();
	});

	it('поднимает лимит адреса в демо-режиме', async () => {
		demo.mode = true;
		const ip = address(14);

		for (let attempt = 1; attempt <= 150; attempt += 1) {
			expect(await withinAddressLimit(ip)).toBe(true);
		}

		expect(await withinAddressLimit(ip)).toBe(false);
	});
});

describe('граница демонстрационной сессии', () => {
	/** Права, которых демонстрация не получает ни под какой ролью. */
	const DENIED = [
		'users.manage',
		'api_keys.manage',
		'settings.write',
		'audit.export',
		'stages.configure'
	] as const;

	it('вычитает необратимые права у сессии демонстрационной учётной записи', async () => {
		demo.mode = true;
		const user = await newUser({
			name: 'demo-admin',
			password: PASSWORD,
			roleId: 'admin',
			isDemo: true
		});

		const session = await loadSessionUser(user.id);

		expect(session?.isDemo).toBe(true);
		for (const key of DENIED) {
			expect(session?.permissions.has(key)).toBe(false);
		}

		// Остальное остаётся: демонстрация показывает работу, а не пустой экран.
		expect(session?.permissions.has('audit.read')).toBe(true);
		expect(session?.permissions.has('interactions.write')).toBe(true);
		expect(session?.permissions.has('documents.generate')).toBe(true);
	});

	it('держит границу и на входе по паролю, и на ключе доступа', async () => {
		demo.mode = true;
		const user = await newUser({
			name: 'demo-parol',
			password: PASSWORD,
			roleId: 'admin',
			isDemo: true
		});

		// Кнопкой «Войти как …» или паролем — сессия одна и та же: общая учётная
		// запись остаётся общей, каким бы способом в неё ни вошли.
		expect(
			await login(anonymous(address(15)), { email: user.email, password: PASSWORD })
		).toMatchObject({ ok: true });

		const ctx: ActorContext = {
			...anonymous(address(15)),
			user: await loadSessionUser(user.id),
			scope: { kind: 'all' }
		};

		await expect(listUsers(ctx, pageQuerySchema.parse({}))).rejects.toBeInstanceOf(ForbiddenError);

		// Журнал помечает сессию, а не способ её открыть: кнопки тут не было.
		expect(await auditOf('auth.login')).toEqual([
			{ outcome: 'success', details: { userId: user.id, demo: true } }
		]);
	});

	it('вне демо-режима та же учётная запись получает права роли целиком', async () => {
		demo.mode = true;
		const user = await newUser({
			name: 'demo-vykl',
			password: PASSWORD,
			roleId: 'admin',
			isDemo: true
		});

		demo.mode = false;
		const session = await loadSessionUser(user.id);

		expect(session?.isDemo).toBe(false);
		for (const key of DENIED) {
			expect(session?.permissions.has(key)).toBe(true);
		}
	});

	it('не даёт выключить демонстрационную учётную запись, пока включён демо-режим', async () => {
		demo.mode = true;
		const user = await newUser({
			name: 'demo-neubit',
			password: PASSWORD,
			roleId: 'viewer',
			isDemo: true
		});

		// Выключить её некому и включить обратно тоже: раздел пользователей для
		// самой демонстрации закрыт, а кнопка «Войти как …» исчезнет вместе с
		// записью — стенд останется без входа.
		await expect(deactivateUser(testActor(), user.id)).rejects.toBeInstanceOf(ConflictError);
		expect((await loadSessionUser(user.id))?.id).toBe(user.id);

		// Вне демо-режима это обычная учётная запись, и запрета на неё нет.
		demo.mode = false;
		await deactivateUser(testActor(), user.id);
		expect(await loadSessionUser(user.id)).toBeNull();
	});
});

describe('срок жизни сессии', () => {
	it('живёт ровно столько, сколько разрешает бездействие', async () => {
		const user = await newUser({ name: 'session', password: PASSWORD });
		const sessionId = await createSession(user.id, { ip: '198.51.100.9', userAgent: 'vitest' });

		const ttl = await getRedis().ttl(`session:${sessionId}`);
		expect(ttl).toBeGreaterThan(30 * 60 - 5);
		expect(ttl).toBeLessThanOrEqual(30 * 60);
	});

	it('продлевается при активности, но не чаще раза в минуту', async () => {
		const user = await newUser({ name: 'active', password: PASSWORD });
		const sessionId = await createSession(user.id, { ip: null, userAgent: null });
		const key = `session:${sessionId}`;
		const redis = getRedis();

		// Сессия, которой никто не касался две минуты, и вот-вот истечёт.
		const stored = JSON.parse((await redis.get(key)) as string);
		await redis.set(
			key,
			JSON.stringify({ ...stored, lastSeenAt: new Date(Date.now() - 120_000).toISOString() }),
			'EX',
			100
		);

		expect(await touchSession(sessionId)).toEqual({ userId: user.id, mfaPending: false });
		expect(await redis.ttl(key)).toBeGreaterThan(100);

		// Вторая активность в ту же минуту Redis не трогает.
		await redis.expire(key, 100);
		expect(await touchSession(sessionId)).toEqual({ userId: user.id, mfaPending: false });
		expect(await redis.ttl(key)).toBeLessThanOrEqual(100);
	});

	it('не переживает предельный срок, сколько бы ни было активности', async () => {
		const user = await newUser({ name: 'longlived', password: PASSWORD });
		const sessionId = await createSession(user.id, { ip: null, userAgent: null });
		const key = `session:${sessionId}`;
		const redis = getRedis();

		const stored = JSON.parse((await redis.get(key)) as string);
		await redis.set(
			key,
			JSON.stringify({
				...stored,
				createdAt: new Date(Date.now() - 13 * 3600 * 1000).toISOString(),
				lastSeenAt: new Date().toISOString()
			}),
			'EX',
			1800
		);

		expect(await touchSession(sessionId)).toBeNull();
		expect(await redis.exists(key)).toBe(0);
	});
});

describe('демонстрационный вход', () => {
	it('впускает без пароля под ролью и помечает это в журнале', async () => {
		demo.mode = true;
		const user = await newUser({
			name: 'demo-viewer',
			password: PASSWORD,
			roleId: 'viewer',
			isDemo: true
		});

		expect(await listDemoAccounts()).toEqual([{ roleId: 'viewer', roleName: 'Наблюдатель' }]);

		const sessionId = await demoLogin(anonymous(address(8)), 'viewer');
		expect(await touchSession(sessionId)).toEqual({ userId: user.id, mfaPending: false });

		// Демонстрационный вход отличается от обычного одной подробностью — по ней
		// журнал и показывает, что учётная запись общая, а не личная.
		expect(await auditOf('auth.login')).toEqual([
			{ outcome: 'success', details: { userId: user.id, demo: true } }
		]);

		// И подписан он тем же, кем обычный вход: демонстрационная запись — тоже
		// учётная запись, а не аноним.
		const [event] = await database.db
			.select({ actorUserId: auditEvents.actorUserId, actorLabel: auditEvents.actorLabel })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'auth.login'));

		expect(event).toEqual({ actorUserId: user.id, actorLabel: 'Иванов Иван' });
	});

	it('вне демо-режима не существует', async () => {
		demo.mode = true;
		await newUser({ name: 'demo-off', password: PASSWORD, roleId: 'viewer', isDemo: true });

		demo.mode = false;
		expect(await listDemoAccounts()).toEqual([]);
		await expect(demoLogin(anonymous(address(10)), 'viewer')).rejects.toBeInstanceOf(NotFoundError);
	});

	it('не снимает счётчик адреса: пароля он не спрашивает', async () => {
		demo.mode = true;
		await newUser({ name: 'demo-limit', password: PASSWORD, roleId: 'viewer', isDemo: true });
		const ip = address(12);

		// Счётчик адреса защищает от перебора учётных записей с одной машины.
		// Снимает его верный пароль — а демонстрационный вход пароля не знает:
		// снимай он счётчик, обход лимита стоил бы одно нажатие кнопки.
		expect(await withinAddressLimit(ip)).toBe(true);
		expect(await getRedis().exists(`login_ip:${ip}`)).toBe(1);

		await demoLogin(anonymous(ip), 'viewer');

		expect(await getRedis().exists(`login_ip:${ip}`)).toBe(1);
	});

	it('не впускает под ролью, для которой учётной записи нет', async () => {
		demo.mode = true;
		await newUser({ name: 'demo-only-viewer', password: PASSWORD, roleId: 'viewer', isDemo: true });

		await expect(demoLogin(anonymous(address(11)), 'admin')).rejects.toBeInstanceOf(NotFoundError);
	});
});

describe('отказ по правам в журнале', () => {
	/**
	 * Попытка сделать то, на что права нет, — это то, о чём администратор должен
	 * узнать, а не молчаливая ошибка в ответе одному вызывающему. Проверяется
	 * пара «отказ и запись»: без записи отказ невидим, а без отказа запись врёт.
	 */
	const viewer = (): ActorContext => testActor({ roleId: 'viewer' });

	/** Исход и субъект события данного вида. */
	async function denialsOf(
		type: string
	): Promise<{ outcome: string; subjectId: string | null; actorUserId: string | null }[]> {
		return database.db
			.select({
				outcome: auditEvents.outcome,
				subjectId: auditEvents.subjectId,
				actorUserId: auditEvents.actorUserId
			})
			.from(auditEvents)
			.where(eq(auditEvents.eventType, type))
			.orderBy(asc(auditEvents.occurredAt));
	}

	it('пишет отказ завести учётную запись', async () => {
		const actor = viewer();

		await expect(
			createUser(actor, {
				email: email('mimo-prav'),
				fullName: 'Мимо Прав',
				roleId: 'manager',
				password: PASSWORD
			})
		).rejects.toBeInstanceOf(ForbiddenError);

		expect(await denialsOf('users.created')).toEqual([
			{ outcome: 'denied', subjectId: null, actorUserId: actor.user?.id }
		]);

		// И учётной записи после отказа не осталось.
		const created = await database.db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, email('mimo-prav')));
		expect(created).toEqual([]);
	});

	it('пишет отказ выключить и включить учётную запись — вместе с тем, кого трогали', async () => {
		const target = await newUser({ name: 'tselevoi', password: PASSWORD });
		const actor = viewer();

		await expect(deactivateUser(actor, target.id)).rejects.toBeInstanceOf(ForbiddenError);
		await expect(activateUser(actor, target.id)).rejects.toBeInstanceOf(ForbiddenError);

		expect(await denialsOf('users.deactivated')).toEqual([
			{ outcome: 'denied', subjectId: target.id, actorUserId: actor.user?.id }
		]);
		expect(await denialsOf('users.activated')).toEqual([
			{ outcome: 'denied', subjectId: target.id, actorUserId: actor.user?.id }
		]);
	});

	it('пишет отказ прочитать штат', async () => {
		const actor = viewer();

		await expect(listUsers(actor, pageQuerySchema.parse({}))).rejects.toBeInstanceOf(
			ForbiddenError
		);

		expect(await denialsOf('users.viewed')).toEqual([
			{ outcome: 'denied', subjectId: null, actorUserId: actor.user?.id }
		]);
	});

	it('удачное действие отказом не помечает', async () => {
		const target = await newUser({ name: 'obychnyi', password: PASSWORD });

		await deactivateUser(testActor(), target.id);

		expect(await denialsOf('users.deactivated')).toEqual([
			{ outcome: 'success', subjectId: target.id, actorUserId: TEST_USER_IDS.admin }
		]);
	});
});

describe('пользователи', () => {
	it('требует существующей роли и не допускает двух одинаковых почт', async () => {
		await newUser({ name: 'pervyi', password: PASSWORD });

		await expect(
			createUser(testActor(), {
				email: email('pervyi'),
				fullName: 'Другой Человек',
				roleId: 'manager',
				password: PASSWORD
			})
		).rejects.toBeInstanceOf(ConflictError);

		await expect(
			createUser(testActor(), {
				email: email('bez-roli'),
				fullName: 'Человек Без Роли',
				roleId: 'superuser',
				password: PASSWORD
			})
		).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof ValidationError && error.issues.some((issue) => /superuser/.test(issue))
		);
	});

	it('не заводит пользователя со слабым паролем', async () => {
		await expect(
			createUser(testActor(), {
				email: email('slaboe'),
				fullName: 'Человек Иванов',
				roleId: 'viewer',
				password: 'qwerty'
			})
		).rejects.toSatisfy(
			(error: unknown) => error instanceof ValidationError && error.issues.length === 2
		);
	});

	it('пускает к списку и к заведению только с правом users.manage', async () => {
		const page = pageQuerySchema.parse({});
		const viewer = testActor({ roleId: 'viewer' });

		await expect(listUsers(viewer, page)).rejects.toBeInstanceOf(ForbiddenError);
		await expect(
			createUser(viewer, {
				email: email('chuzhoi'),
				fullName: 'Человек Иванов',
				roleId: 'viewer',
				password: PASSWORD
			})
		).rejects.toBeInstanceOf(ForbiddenError);

		await newUser({ name: 'v-spiske', password: PASSWORD });
		const listed = await listUsers(testActor(), page);

		// Три пользователя завела фикстура — по одному на роль.
		expect(listed.total).toBe(4);
		expect(listed.items.some((item) => item.email === email('v-spiske'))).toBe(true);
	});

	it('отдаёт штат для выбора ответственного тому, кто ведёт взаимодействия', async () => {
		const manager = testActor({ roleId: 'manager' });
		const created = await newUser({ name: 'v-vybore', password: PASSWORD });

		// Раздел пользователей закрыт правом администратора, а выбор
		// ответственного — нет: иначе менеджер не смог бы назначить работу коллеге.
		await expect(listUsers(manager, pageQuerySchema.parse({}))).rejects.toBeInstanceOf(
			ForbiddenError
		);

		const staff = await lookupUsers(manager);
		expect(staff.map((item) => item.id)).toContain(created.id);
		expect(staff.find((item) => item.id === created.id)).toMatchObject({
			fullName: 'Иванов Иван',
			roleId: 'manager',
			roleName: 'Менеджер'
		});

		// Наблюдателю назначать нечего — и штата он не видит.
		await expect(lookupUsers(testActor({ roleId: 'viewer' }))).rejects.toBeInstanceOf(
			ForbiddenError
		);
	});

	it('не предлагает выключенных и сужает список поиском и ролью', async () => {
		const manager = testActor({ roleId: 'manager' });
		const uvolen = await newUser({ name: 'uvolen-iz-vybora', password: PASSWORD });
		await deactivateUser(testActor(), uvolen.id);
		await newUser({ name: 'ostalsya-v-shtate', password: PASSWORD });

		// Назначить работу на уволенного нельзя, поэтому его нет и в выборе.
		expect((await lookupUsers(manager)).map((item) => item.id)).not.toContain(uvolen.id);

		const found = await lookupUsers(manager, { q: 'иванов' });
		expect(found.length).toBeGreaterThan(0);
		expect(found.every((item) => item.fullName.includes('Иванов'))).toBe(true);

		const admins = await lookupUsers(manager, { roleIds: ['admin'] });
		expect(admins.length).toBeGreaterThan(0);
		expect(admins.every((item) => item.roleId === 'admin')).toBe(true);

		// Пустой список ролей — это «ни одна не подходит», а не «любая».
		expect(await lookupUsers(manager, { roleIds: [] })).toEqual([]);
	});

	it('не даёт выключить собственную учётную запись', async () => {
		const actor = testActor();

		await expect(deactivateUser(actor, actor.user?.id as string)).rejects.toBeInstanceOf(
			ConflictError
		);
	});

	it('включает выключенную запись обратно и открывает ей вход', async () => {
		const user = await newUser({ name: 'vernulsya', password: PASSWORD });

		await deactivateUser(testActor(), user.id);
		expect(
			await login(anonymous(address(16)), { email: user.email, password: PASSWORD })
		).toMatchObject({ ok: false, reason: 'invalid' });

		await activateUser(testActor(), user.id);

		// Пароль выключение не отменяло: человек возвращается к работе с тем же.
		expect(
			await login(anonymous(address(16)), { email: user.email, password: PASSWORD })
		).toMatchObject({ ok: true });

		expect(await auditOf('users.activated')).toEqual([{ outcome: 'success', details: {} }]);

		const [row] = await database.db
			.select({ deactivatedAt: users.deactivatedAt })
			.from(users)
			.where(eq(users.id, user.id));
		expect(row.deactivatedAt).toBeNull();
	});

	it('не записывает включение того, что и так работает, и не знает чужих записей', async () => {
		const user = await newUser({ name: 'uzhe-rabotaet', password: PASSWORD });

		await expect(activateUser(testActor(), user.id)).rejects.toBeInstanceOf(ConflictError);
		await expect(
			activateUser(testActor(), '00000000-0000-4000-8000-00000000dead')
		).rejects.toBeInstanceOf(NotFoundError);

		// Журнал — доказательство того, что произошло: отказ ничего в него не кладёт.
		expect(await auditOf('users.activated')).toEqual([]);
	});

	it('включать и выключать может только тот, кто управляет пользователями', async () => {
		const user = await newUser({ name: 'ne-tvoyo', password: PASSWORD });
		const viewer = testActor({ roleId: 'viewer' });

		await expect(deactivateUser(viewer, user.id)).rejects.toBeInstanceOf(ForbiddenError);
		await expect(activateUser(viewer, user.id)).rejects.toBeInstanceOf(ForbiddenError);
	});

	it('меняет пароль, проверяя текущий, и гасит все сессии', async () => {
		const created = await newUser({ name: 'smena', password: PASSWORD });
		const user = await loadSessionUser(created.id);
		expect(user).not.toBeNull();

		const ctx: ActorContext = { ...anonymous(address(12)), user, scope: { kind: 'all' } };
		const sessionId = await createSession(created.id, { ip: null, userAgent: null });

		await expect(
			changePassword(ctx, { current: 'Совсем-Другой1', next: 'Новый-Пароль1' })
		).rejects.toBeInstanceOf(ValidationError);

		await changePassword(ctx, { current: PASSWORD, next: 'Новый-Пароль1' });

		expect(await touchSession(sessionId)).toBeNull();
		expect(
			await login(anonymous(address(12)), { email: created.email, password: PASSWORD })
		).toMatchObject({ ok: false });
		expect(
			await login(anonymous(address(12)), { email: created.email, password: 'Новый-Пароль1' })
		).toMatchObject({ ok: true });

		expect(await auditOf('auth.password_changed')).toEqual([{ outcome: 'success', details: {} }]);

		const [row] = await database.db
			.select({ hash: users.passwordHash })
			.from(users)
			.where(eq(users.id, created.id));
		expect(row.hash).toMatch(/^\$argon2id\$/);
	});
});
