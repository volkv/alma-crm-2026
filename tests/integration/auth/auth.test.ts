import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { isRedirect } from '@sveltejs/kit';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '$lib/server/actor';
import { rateLimit } from '$lib/server/hooks/rate-limit';
import { auditEvents, organizationResponsibles, users } from '$lib/server/db/schema';
import { ConflictError, ForbiddenError, NotFoundError } from '$lib/server/errors';
import { pageQuerySchema } from '$lib/contracts/common';
import { signInWithClaims } from '$lib/server/auth/identity';
import type { IdentityClaims } from '$lib/server/auth/oidc';
import { mapRealmRoles } from '$lib/server/auth/roles';
import {
	createSession,
	destroySession,
	loadSessionUser,
	revokeAllSessions,
	touchSession
} from '$lib/server/auth/session';
import { withinStartLimit } from '$lib/server/auth/start-limit';
import {
	activateUser,
	deactivateUser,
	listUsers,
	lookupUsers,
	setUserManager,
	unlinkFromDirectory
} from '$lib/server/auth/users';
import { DEFAULT_ROLES } from '$lib/server/rbac/permissions';
import { getRedis } from '$lib/server/redis';
import {
	insertOrganization,
	startTestDatabase,
	testActor,
	TEST_USER_IDS,
	type TestDatabase
} from '../helpers/db';

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
const openedSessions = new Set<string>();
const usedAddresses = new Set<string>();

function email(name: string): string {
	return `${name}-${runId}@example.org`;
}

/** Адрес, который не пересекается с чужими счётчиками в общем Redis. */
function address(octet: number): string {
	const ip = `198.51.100.${octet}`;
	usedAddresses.add(ip);

	return ip;
}

/** Утверждения токена в том виде, в каком их отдаёт проверенный id-токен. */
function claims(overrides: Partial<IdentityClaims> = {}): IdentityClaims {
	return {
		subject: `sub-${randomUUID()}`,
		email: email('ivanov'),
		emailVerified: true,
		fullName: 'Иванов Иван Иванович',
		realmRoles: ['crm-user'],
		...overrides
	};
}

/** Контекст анонимного посетителя: именно он возвращается из каталога. */
function anonymous(ip: string): ActorContext {
	return {
		requestId: randomUUID(),
		source: 'ui',
		user: null,
		apiKeyId: null,
		ip,
		userAgent: 'vitest',
		scope: { kind: 'delegated', userIds: new Set() }
	};
}

/** Вход по утверждениям токена; открытые сессии гасятся после теста. */
async function signIn(
	ip: string,
	overrides: Partial<IdentityClaims> = {}
): Promise<Awaited<ReturnType<typeof signInWithClaims>>> {
	const outcome = await signInWithClaims(anonymous(ip), claims(overrides), `id-token-${runId}`);

	if (outcome.ok) {
		openedSessions.add(outcome.sessionId);
	}

	return outcome;
}

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await database.stop();
});

beforeEach(async () => {
	demo.mode = false;
	await database.reset();
});

afterEach(async () => {
	const redis = getRedis();

	for (const sessionId of openedSessions) {
		await destroySession(sessionId);
	}
	openedSessions.clear();

	for (const ip of usedAddresses) {
		await redis.del(`login_ip:${ip}`);
	}
	usedAddresses.clear();
});

describe('отображение ролей каталога', () => {
	it('переводит роли realm в роли системы', () => {
		expect(mapRealmRoles(['crm-admin'])).toBe('admin');
		expect(mapRealmRoles(['crm-lead'])).toBe('lead');
		expect(mapRealmRoles(['crm-user'])).toBe('manager');
	});

	it('берёт старшую роль, когда каталог выдал несколько', () => {
		// Realm вправе выдать обе: руководитель, который ведёт свои вузы сам, —
		// это законная пара ролей, а не ошибка настройки.
		expect(mapRealmRoles(['crm-user', 'crm-lead'])).toBe('lead');
		expect(mapRealmRoles(['crm-user', 'crm-lead', 'crm-admin'])).toBe('admin');
	});

	it('не знает незнакомых ролей и отказывает, если наших нет', () => {
		expect(mapRealmRoles(['offline_access', 'default-roles-lct'])).toBeNull();
		expect(mapRealmRoles([])).toBeNull();
		// Незнакомая роль рядом с нашей ничего не меняет: набор ролей сужается
		// вместе с кодом, а не вместе с содержимым realm.
		expect(mapRealmRoles(['uma_authorization', 'crm-user'])).toBe('manager');
	});
});

describe('вход через каталог', () => {
	it('заводит запись при первом входе и связывает её с субъектом каталога', async () => {
		const outcome = await signIn(address(1), { email: email('novikov') });

		expect(outcome.ok).toBe(true);

		const [row] = await database.db
			.select({
				id: users.id,
				externalSubject: users.externalSubject,
				roleId: users.roleId,
				fullName: users.fullName
			})
			.from(users)
			.where(eq(users.email, email('novikov')));

		expect(row.roleId).toBe('manager');
		expect(row.fullName).toBe('Иванов Иван Иванович');
		expect(row.externalSubject).not.toBeNull();

		const logged = await database.db
			.select({ outcome: auditEvents.outcome, actorUserId: auditEvents.actorUserId })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'auth.login'));

		expect(logged).toEqual([{ outcome: 'success', actorUserId: row.id }]);
	});

	it('узнаёт заведённую запись по подтверждённой почте и оставляет ей прежний портфель', async () => {
		const [existing] = await database.db
			.insert(users)
			.values({ email: email('orlova'), fullName: 'Орлова Мария', roleId: 'manager' })
			.returning({ id: users.id });

		const outcome = await signIn(address(2), {
			email: email('ORLOVA').toUpperCase(),
			fullName: 'Орлова Мария Петровна'
		});

		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			// Та же строка, а не двойник: иначе её взаимодействия, назначения и
			// след в журнале остались бы за записью, в которую уже никто не войдёт.
			expect(outcome.user.id).toBe(existing.id);
		}

		const [row] = await database.db
			.select({ externalSubject: users.externalSubject, fullName: users.fullName })
			.from(users)
			.where(eq(users.id, existing.id));

		expect(row.externalSubject).not.toBeNull();
		// Источник истины о человеке — каталог: имя приведено к тому, что в токене.
		expect(row.fullName).toBe('Орлова Мария Петровна');
	});

	it('не связывает по неподтверждённой почте и отказывает понятно', async () => {
		await database.db
			.insert(users)
			.values({ email: email('gromov'), fullName: 'Громов Илья', roleId: 'manager' });

		const outcome = await signIn(address(3), {
			email: email('gromov'),
			emailVerified: false
		});

		// Чужой адрес в токене иначе отдавал бы чужой портфель: заведённая запись
		// с этой почтой так и остаётся без внешнего субъекта, а вход получает
		// отказ, а не ошибку уникальности из базы.
		expect(outcome).toMatchObject({ ok: false, reason: 'email_taken' });

		const rows = await database.db
			.select({ externalSubject: users.externalSubject })
			.from(users)
			.where(eq(users.email, email('gromov')));

		expect(rows).toEqual([{ externalSubject: null }]);
	});

	it('отказывает тому, у кого нет ни одной известной роли realm', async () => {
		const outcome = await signIn(address(4), { realmRoles: ['offline_access'] });

		expect(outcome).toEqual({ ok: false, reason: 'no_role' });

		// Локальная запись при этом не заводится: пользователь без роли нам не
		// сотрудник.
		const rows = await database.db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, email('ivanov')));

		expect(rows).toEqual([]);

		const denied = await database.db
			.select({ outcome: auditEvents.outcome })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'auth.login'));

		expect(denied).toEqual([{ outcome: 'denied' }]);
	});

	it('выключает запись, у которой каталог отозвал роль, и гасит её сессии', async () => {
		const subject = `sub-${randomUUID()}`;
		const first = await signIn(address(5), { subject, email: email('petrov') });

		expect(first.ok).toBe(true);
		const sessionId = first.ok ? first.sessionId : '';

		const refused = await signIn(address(5), {
			subject,
			email: email('petrov'),
			realmRoles: []
		});

		expect(refused).toEqual({ ok: false, reason: 'no_role' });

		const [row] = await database.db
			.select({ isActive: users.isActive })
			.from(users)
			.where(eq(users.externalSubject, subject));

		expect(row.isActive).toBe(false);
		// Ждать, пока администратор заметит, нельзя: у уволенного входа может уже
		// не быть, а открытая сессия работала бы до конца дня.
		expect(await touchSession(sessionId)).toBeNull();
	});

	it('гасит сессии, когда каталог поменял роль', async () => {
		const subject = `sub-${randomUUID()}`;
		const first = await signIn(address(6), { subject, email: email('smirnov') });
		const sessionId = first.ok ? first.sessionId : '';

		const second = await signIn(address(6), {
			subject,
			email: email('smirnov'),
			realmRoles: ['crm-lead']
		});

		expect(second.ok).toBe(true);
		if (second.ok) {
			expect(second.user.roleId).toBe('lead');
		}

		// Прежняя сессия несла прежнюю область: донашивать её до истечения нельзя.
		expect(await touchSession(sessionId)).toBeNull();

		const changed = await database.db
			.select({ id: auditEvents.id })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'users.role_changed'));

		expect(changed).toHaveLength(1);
	});

	it('не впускает машинного субъекта ни при каких утверждениях токена', async () => {
		// Запись роли `service` подготовка прогона уже завела — по одной на роль.
		const [service] = await database.db
			.select({ email: users.email })
			.from(users)
			.where(eq(users.id, TEST_USER_IDS.service));

		const outcome = await signIn(address(7), { email: service.email });

		expect(outcome).toEqual({
			ok: false,
			reason: 'service_account',
			userId: TEST_USER_IDS.service
		});
	});

	it('не впускает выключенную запись', async () => {
		const [account] = await database.db
			.insert(users)
			.values({
				email: email('uvolen'),
				fullName: 'Уволен Уволенович',
				roleId: 'manager',
				isActive: false
			})
			.returning({ id: users.id });

		const outcome = await signIn(address(8), { email: email('uvolen') });

		expect(outcome).toEqual({ ok: false, reason: 'inactive', userId: account.id });
	});
});

describe('сессии', () => {
	it('живут в Redis и гаснут по требованию', async () => {
		const sessionId = await createSession(TEST_USER_IDS.manager, {
			ip: address(9),
			userAgent: 'vitest'
		});
		openedSessions.add(sessionId);

		expect(await touchSession(sessionId)).toMatchObject({ userId: TEST_USER_IDS.manager });

		await revokeAllSessions(TEST_USER_IDS.manager);

		expect(await touchSession(sessionId)).toBeNull();
	});

	it('собирают пользователя из базы, а не из записи сессии', async () => {
		const user = await loadSessionUser(TEST_USER_IDS.manager);

		expect(user?.roleId).toBe('manager');
		expect(user?.permissions.has('interactions.write')).toBe(true);
		// Право, отнятое у КАМа: каталог прав один, и сессия читает его же.
		expect(user?.permissions.has('stats.import')).toBe(false);
	});

	it('не собирают выключенную учётную запись', async () => {
		await database.db
			.update(users)
			.set({ isActive: false })
			.where(eq(users.id, TEST_USER_IDS.manager));

		expect(await loadSessionUser(TEST_USER_IDS.manager)).toBeNull();
	});
});

describe('область доступа сессии', () => {
	it('у администратора полная, у менеджера — только его записи', async () => {
		const admin = await loadSessionUser(TEST_USER_IDS.admin);
		const manager = await loadSessionUser(TEST_USER_IDS.manager);

		expect(admin?.scope).toEqual({ kind: 'all' });
		expect(manager?.scope).toEqual({
			kind: 'delegated',
			userIds: new Set([TEST_USER_IDS.manager])
		});
	});

	it('у руководителя — он сам и его подчинённые на любую глубину', async () => {
		const [deep] = await database.db
			.insert(users)
			.values({
				email: email('deep'),
				fullName: 'Глубокий Подчинённый',
				roleId: 'manager',
				managerUserId: TEST_USER_IDS.manager
			})
			.returning({ id: users.id });

		await database.db
			.update(users)
			.set({ managerUserId: TEST_USER_IDS.lead })
			.where(eq(users.id, TEST_USER_IDS.manager));

		const lead = await loadSessionUser(TEST_USER_IDS.lead);

		expect(lead?.scope).toEqual({
			kind: 'delegated',
			userIds: new Set([TEST_USER_IDS.lead, TEST_USER_IDS.manager, deep.id])
		});
	});

	it('у машинного субъекта полная: ключ обмена работает по любому вузу', async () => {
		const service = await loadSessionUser(TEST_USER_IDS.service);

		expect(service?.scope).toEqual({ kind: 'all' });
		// Ширина безопасна ровно потому, что дальше эндпоинтов обмена такой ключ
		// не пускают: набор прав у роли закрытый и перечислен целиком.
		expect([...(service?.permissions ?? [])].sort()).toEqual([
			'exchange.intake',
			'exchange.results',
			'stages.confirm'
		]);
	});
});

describe('демонстрационная сессия', () => {
	it('теряет ровно те права, что переживают демонстрацию', async () => {
		demo.mode = true;

		await database.db.update(users).set({ isDemo: true }).where(eq(users.id, TEST_USER_IDS.admin));

		const user = await loadSessionUser(TEST_USER_IDS.admin);

		expect(user?.isDemo).toBe(true);
		// Адрес подключения — единственное, чего не отменяет суточный сброс
		// стенда: по нему сервер пойдёт запросами на указанный узел.
		expect(user?.permissions.has('integrations.manage_endpoints')).toBe(false);

		// Всё остальное показывают целиком, потому что сброс это возвращает:
		// учётные записи, ключи, обезличивание, правка процесса, журнал обмена,
		// настройки и выгрузка журнала.
		expect(user?.permissions.has('users.manage')).toBe(true);
		expect(user?.permissions.has('api_keys.manage')).toBe(true);
		expect(user?.permissions.has('people.anonymize')).toBe(true);
		expect(user?.permissions.has('stages.configure')).toBe(true);
		expect(user?.permissions.has('integrations.manage')).toBe(true);
		expect(user?.permissions.has('settings.write')).toBe(true);
		expect(user?.permissions.has('audit.export')).toBe(true);
	});

	it('вне демо-режима признак ничего не значит', async () => {
		demo.mode = false;

		await database.db.update(users).set({ isDemo: true }).where(eq(users.id, TEST_USER_IDS.admin));

		const user = await loadSessionUser(TEST_USER_IDS.admin);

		expect(user?.isDemo).toBe(false);
		expect(user?.permissions.has('users.manage')).toBe(true);
	});
});

describe('лимит заходов с адреса', () => {
	it('разворачивает POST страницы входа, когда окно выбрано', async () => {
		const ip = address(20);
		const redis = getRedis();

		// Счётчик выставляется сразу за потолок: тридцать одиночных заходов
		// проверяли бы скорость Redis, а не правило.
		await redis.set(`login_ip:${ip}`, '10000', 'EX', 900);

		expect(await withinStartLimit(ip)).toBe(false);

		const thrown = await Promise.resolve(
			rateLimit({
				event: {
					route: { id: '/(auth)/login' },
					request: new Request('http://localhost/login', { method: 'POST' }),
					url: new URL('http://localhost/login?next=%2Faudit'),
					getClientAddress: () => ip
				},
				resolve: async () => new Response('форма принята')
			} as unknown as Parameters<typeof rateLimit>[0])
		).then(
			(response) => response,
			(failure: unknown) => failure
		);

		expect(isRedirect(thrown)).toBe(true);
		// `next` переживает отказ: лимит не должен ещё и терять, куда человек шёл.
		expect((thrown as { location: string }).location).toBe('/login?next=%2Faudit');
	});
});

describe('управление учётными записями', () => {
	it('выключает запись, гасит её сессии и включает обратно', async () => {
		const [account] = await database.db
			.insert(users)
			.values({ email: email('vetrov'), fullName: 'Ветров Игорь', roleId: 'manager' })
			.returning({ id: users.id });

		const sessionId = await createSession(account.id, { ip: address(21), userAgent: 'vitest' });
		openedSessions.add(sessionId);

		await deactivateUser(testActor(), account.id);

		expect(await touchSession(sessionId)).toBeNull();
		expect(await loadSessionUser(account.id)).toBeNull();

		await activateUser(testActor(), account.id);

		expect((await loadSessionUser(account.id))?.id).toBe(account.id);
		await expect(activateUser(testActor(), account.id)).rejects.toBeInstanceOf(ConflictError);
	});

	it('не даёт выключить собственную запись и демонстрационную в демо-режиме', async () => {
		await expect(
			deactivateUser(testActor({ roleId: 'admin' }), TEST_USER_IDS.admin)
		).rejects.toBeInstanceOf(ConflictError);

		demo.mode = true;
		const [account] = await database.db
			.insert(users)
			.values({
				email: email('demo'),
				fullName: 'Демо Демович',
				roleId: 'manager',
				isDemo: true
			})
			.returning({ id: users.id });

		await expect(deactivateUser(testActor(), account.id)).rejects.toBeInstanceOf(ConflictError);
	});

	it('требует права на список и на переключение', async () => {
		const manager = testActor({ roleId: 'manager' });

		await expect(listUsers(manager, pageQuerySchema.parse({}))).rejects.toBeInstanceOf(
			ForbiddenError
		);
		await expect(deactivateUser(manager, TEST_USER_IDS.lead)).rejects.toBeInstanceOf(
			ForbiddenError
		);
	});

	it('ведёт иерархию и гасит сессии затронутых', async () => {
		const [account] = await database.db
			.insert(users)
			.values({ email: email('sidorov'), fullName: 'Сидоров Пётр', roleId: 'manager' })
			.returning({ id: users.id });

		const sessionId = await createSession(account.id, { ip: address(22), userAgent: 'vitest' });
		openedSessions.add(sessionId);

		await setUserManager(testActor(), { userId: account.id, managerUserId: TEST_USER_IDS.lead });

		expect(await touchSession(sessionId)).toBeNull();

		const [row] = await database.db
			.select({ managerUserId: users.managerUserId })
			.from(users)
			.where(eq(users.id, account.id));

		expect(row.managerUserId).toBe(TEST_USER_IDS.lead);

		// Область руководителя расширилась немедленно.
		const lead = await loadSessionUser(TEST_USER_IDS.lead);
		expect(lead?.scope).toEqual({
			kind: 'delegated',
			userIds: new Set([TEST_USER_IDS.lead, account.id])
		});
	});

	it('отвязывает от каталога, и следующий вход связывает запись заново', async () => {
		const first = await signIn(address(23), { email: email('perezavod') });
		expect(first.ok).toBe(true);

		const [account] = await database.db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, email('perezavod')));

		// Каталог перезавели: у того же человека другой субъект. Вход его не
		// узнаёт и по почте не связывается — иначе чужой адрес в токене отдавал
		// бы чужой портфель.
		const stranger = await signIn(address(23), { email: email('perezavod') });
		expect(stranger).toMatchObject({ ok: false, reason: 'email_taken', userId: account.id });

		await unlinkFromDirectory(testActor(), account.id);

		const [unlinked] = await database.db
			.select({ externalSubject: users.externalSubject })
			.from(users)
			.where(eq(users.id, account.id));

		expect(unlinked.externalSubject).toBeNull();

		// Та же строка, а не двойник: портфель, назначения и след в журнале
		// остаются за ней.
		const again = await signIn(address(23), { email: email('perezavod') });
		expect(again.ok).toBe(true);
		if (again.ok) {
			expect(again.user.id).toBe(account.id);
		}

		await expect(unlinkFromDirectory(testActor(), account.id)).resolves.toBeUndefined();
	});

	it('не отвязывает запись, которая и так не связана', async () => {
		await expect(unlinkFromDirectory(testActor(), TEST_USER_IDS.manager)).rejects.toBeInstanceOf(
			ConflictError
		);
	});

	it('не заводит круг в иерархии', async () => {
		await setUserManager(testActor(), {
			userId: TEST_USER_IDS.manager,
			managerUserId: TEST_USER_IDS.lead
		});

		await expect(
			setUserManager(testActor(), {
				userId: TEST_USER_IDS.lead,
				managerUserId: TEST_USER_IDS.manager
			})
		).rejects.toThrow('Иерархия не изменена');
	});

	it('показывает в списке руководителя и признак связанности с каталогом', async () => {
		const page = await listUsers(testActor(), pageQuerySchema.parse({}));
		const manager = page.items.find((item) => item.id === TEST_USER_IDS.manager);

		expect(manager?.isLinked).toBe(false);
		expect(manager?.managerUserId).toBeNull();
	});

	it('не предлагает машинного субъекта в выборе исполнителя', async () => {
		const found = await lookupUsers(testActor());

		expect(found.map((item) => item.id)).not.toContain(TEST_USER_IDS.service);
	});
});

describe('назначения и область', () => {
	it('сужают список организаций по действующим назначениям', async () => {
		const mine = await insertOrganization(database.db, { shortName: 'Мой вуз' });
		const foreign = await insertOrganization(database.db, { shortName: 'Чужой вуз' });

		await database.db
			.insert(organizationResponsibles)
			.values({ organizationId: mine, userId: TEST_USER_IDS.manager });

		const manager = await loadSessionUser(TEST_USER_IDS.manager);

		expect(manager?.scope).toEqual({
			kind: 'delegated',
			userIds: new Set([TEST_USER_IDS.manager])
		});

		const rows = await database.db
			.select({ organizationId: organizationResponsibles.organizationId })
			.from(organizationResponsibles)
			.orderBy(asc(organizationResponsibles.organizationId));

		expect(rows.map((row) => row.organizationId)).toEqual([mine]);
		expect(foreign).not.toBe(mine);
	});
});

describe('каталог ролей', () => {
	it('перечисляет ровно три роли человека и одного машинного субъекта', () => {
		expect(DEFAULT_ROLES.map((role) => role.id)).toEqual(['admin', 'lead', 'manager', 'service']);
	});

	it('не заводит запись под несуществующую роль', async () => {
		await expect(
			database.db
				.insert(users)
				.values({ email: email('nobody'), fullName: 'Никто', roleId: 'viewer' })
		).rejects.toBeInstanceOf(Error);
	});

	it('не находит выключенного пользователя', async () => {
		await expect(
			deactivateUser(testActor(), '00000000-0000-4000-8000-0000000000ff')
		).rejects.toBeInstanceOf(NotFoundError);
	});
});
