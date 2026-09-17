import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEventType, AuditOutcome, AuditSource } from '$lib/contracts/audit';
import type { ActorContext } from '$lib/server/actor';
import type { SessionUser } from '$lib/server/auth/types';
import { listApiKeys } from '$lib/server/api/keys';
import { recordAuditEvent } from '$lib/server/audit';
import {
	createSession,
	destroySession,
	loadSessionUser,
	touchSession
} from '$lib/server/auth/session';
import { auditEvents, users } from '$lib/server/db/schema';
import { loadRolePermissions } from '$lib/server/rbac';
import { DEFAULT_ROLES } from '$lib/server/rbac/permissions';
import { getRedis } from '$lib/server/redis';
import { getSetting, setSetting, SETTING_DEFAULTS } from '$lib/server/settings';
import { startTestDatabase, testActor, TEST_USER_IDS, type TestDatabase } from '../helpers/db';
import { pageEvent, sessionUser } from '../helpers/event';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

/**
 * Сбой записи в журнал на заказ. Настройка и событие о ней обязаны быть одной
 * транзакцией, и другого способа это проверить нет: журнал роняют не данные, а
 * недоступная база, которой в тесте взяться неоткуда.
 */
const journal = vi.hoisted(() => ({ failOn: null as AuditEventType | null }));

vi.mock('$lib/server/audit', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/audit')>();

	return {
		...actual,
		recordAuditEvent: async (
			...args: Parameters<typeof actual.recordAuditEvent>
		): Promise<void> => {
			if (args[1].type === journal.failOn) {
				throw new Error('журнал недоступен');
			}

			return actual.recordAuditEvent(...args);
		}
	};
});

/**
 * `DEMO_MODE` разбирается один раз за процесс, поэтому переменная окружения тут
 * уже не поможет — подменяется сама функция (тот же приём, что в
 * `auth/auth.test.ts`). Граница демонстрации проходит по правам, а права
 * собирает `loadSessionUser`: экранам её видно только через него.
 */
const demo = vi.hoisted(() => ({ mode: false }));

vi.mock('$lib/server/config', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/config')>();

	return { ...actual, getConfig: () => ({ ...actual.getConfig(), DEMO_MODE: demo.mode }) };
});

/**
 * Экраны администратора целиком: журнал, его выгрузка и формы настроек.
 *
 * Проверяются именно загрузчики и действия маршрутов, а не сервисы под ними:
 * право на раздел, разбор фильтра из адреса, заголовки файла выгрузки и
 * перевод предметной ошибки в ошибку формы живут здесь, и ошибиться можно
 * только здесь.
 */

/** Загрузчик и действие маршрута типизированы своим маршрутом; подделка — общим. */
type PageLoad = (event: RequestEvent) => Promise<unknown>;
type FormAction = (event: RequestEvent) => Promise<unknown>;
type Endpoint = (event: RequestEvent) => Promise<Response>;

const auditPage = await import('../../../src/routes/(app)/audit/+page.server');
const auditExport = await import('../../../src/routes/(app)/audit/export/+server');
const usersPage = await import('../../../src/routes/(app)/settings/users/+page.server');
const profilePage = await import('../../../src/routes/(app)/settings/profile/+page.server');
const keysPage = await import('../../../src/routes/(app)/settings/api-keys/+page.server');
const generalPage = await import('../../../src/routes/(app)/settings/general/+page.server');

const loadAudit = auditPage.load as unknown as PageLoad;
const loadUsers = usersPage.load as unknown as PageLoad;
const loadKeys = keysPage.load as unknown as PageLoad;
const loadGeneral = generalPage.load as unknown as PageLoad;
const exportAudit = auditExport.GET as unknown as Endpoint;
const deactivateUserAction = usersPage.actions.deactivate as unknown as FormAction;
const managerAction = usersPage.actions.manager as unknown as FormAction;
const activateUserAction = usersPage.actions.activate as unknown as FormAction;
const revokeAllAction = profilePage.actions.revokeAll as unknown as FormAction;
const loadProfile = profilePage.load as unknown as PageLoad;
const createKeyAction = keysPage.actions.create as unknown as FormAction;
const revokeKeyAction = keysPage.actions.revoke as unknown as FormAction;
const bannerAction = generalPage.actions.banner as unknown as FormAction;

let database: TestDatabase;

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	// Смена пароля гасит сессии, а они живут в Redis: соединение надо закрыть,
	// иначе прогон не завершится.
	await getRedis().quit();
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();
	demo.mode = false;
	journal.failOn = null;
});

/**
 * Пользователь публичной демонстрации, собранный тем же `loadSessionUser`, что
 * и на живом запросе: набор прав у демо-сессии — не список в тесте, а то, что
 * сервер действительно кладёт в `locals`. Зовётся при включённом `demo.mode`:
 * вне демо-режима такая запись — обычная.
 */
async function demoSessionUser(roleId: string): Promise<SessionUser> {
	// Запись заводится прямой вставкой: заведения пользователя в продукте больше
	// нет — она появляется сама при первом входе через каталог.
	const [created] = await database.db
		.insert(users)
		.values({
			email: `demo-${roleId}@example.org`,
			fullName: `${roleId} Демо`,
			roleId,
			isDemo: true
		})
		.returning({ id: users.id });

	const user = await loadSessionUser(created.id);

	if (user === null || !user.isDemo) {
		throw new Error('демонстрационная учётная запись обязана собираться в демо-сессию');
	}

	return user;
}

/** Идентификатор, которого нет ни в одной таблице, но по форме — наш. */
const ABSENT_ID = '00000000-0000-4000-8000-0000000000ff';

type EventFixture = {
	type: AuditEventType;
	occurredAt: Date;
	outcome?: AuditOutcome;
	source?: AuditSource;
	actorUserId?: string | null;
	subjectType?: string;
	subjectId?: string;
	userAgent?: string;
};

/** Запись журнала с заданным моментом времени: `now()` для периода не годится. */
async function insertEvent(event: EventFixture): Promise<void> {
	await database.db.insert(auditEvents).values({
		occurredAt: event.occurredAt,
		requestId: crypto.randomUUID(),
		source: event.source ?? 'ui',
		eventType: event.type,
		outcome: event.outcome ?? 'success',
		actorUserId: event.actorUserId === undefined ? TEST_USER_IDS.admin : event.actorUserId,
		actorLabel: 'Тестовый Пользователь',
		ip: '198.51.100.10',
		userAgent: event.userAgent ?? null,
		subjectType: event.subjectType ?? null,
		subjectId: event.subjectId ?? null
	});
}

/** Московские сутки: журнал фильтруется календарными днями оператора. */
function moscow(iso: string): Date {
	return new Date(`${iso}+03:00`);
}

type UsersPageData = {
	users: { items: { email: string; roleName: string }[]; total: number };
};

type PageData = {
	events: {
		items: {
			eventType: string;
			actorUserId: string | null;
			ip: string | null;
			userAgent: string | null;
		}[];
		total: number;
	};
	canExport: boolean;
	exportDenied: boolean;
	actors: { id: string }[];
};

type FormSnapshot = {
	valid: boolean;
	errors: { _errors?: string[]; email?: string[] };
	message?: unknown;
};

/** Действие отдаёт либо `{ form }`, либо `ActionFailure` со статусом и данными. */
function formOf(result: unknown): FormSnapshot {
	const outcome = result as { form?: FormSnapshot; data?: { form?: FormSnapshot } };
	const form = outcome.form ?? outcome.data?.form;

	if (form === undefined) {
		throw new Error(`Действие не вернуло форму: ${JSON.stringify(result)}`);
	}

	return form;
}

describe('журнал действий', () => {
	it('фильтрует по типу события', async () => {
		await insertEvent({ type: 'auth.login', occurredAt: moscow('2026-09-10T10:00:00') });
		await insertEvent({ type: 'auth.logout', occurredAt: moscow('2026-09-10T11:00:00') });
		await insertEvent({ type: 'documents.uploaded', occurredAt: moscow('2026-09-10T12:00:00') });

		const data = (await loadAudit(
			pageEvent({ query: '?type=auth.login&type=auth.logout' })
		)) as PageData;

		expect(data.events.total).toBe(2);
		expect(data.events.items.map((item) => item.eventType).sort()).toEqual([
			'auth.login',
			'auth.logout'
		]);
	});

	it('фильтрует по периоду календарными сутками по Москве', async () => {
		await insertEvent({ type: 'auth.login', occurredAt: moscow('2026-09-01T00:00:01') });
		await insertEvent({ type: 'auth.logout', occurredAt: moscow('2026-09-01T23:59:30') });
		await insertEvent({ type: 'auth.login', occurredAt: moscow('2026-09-02T00:30:00') });
		await insertEvent({ type: 'auth.logout', occurredAt: moscow('2026-08-31T23:30:00') });

		const data = (await loadAudit(
			pageEvent({ query: '?from=2026-09-01&to=2026-09-01' })
		)) as PageData;

		expect(data.events.total).toBe(2);
		expect(data.events.items.map((item) => item.eventType).sort()).toEqual([
			'auth.login',
			'auth.logout'
		]);
	});

	it('фильтрует по действующему лицу', async () => {
		await insertEvent({
			type: 'auth.login',
			occurredAt: moscow('2026-09-10T10:00:00'),
			actorUserId: TEST_USER_IDS.admin
		});
		await insertEvent({
			type: 'auth.login',
			occurredAt: moscow('2026-09-10T11:00:00'),
			actorUserId: TEST_USER_IDS.manager
		});

		const data = (await loadAudit(
			pageEvent({ query: `?actor=${TEST_USER_IDS.manager}` })
		)) as PageData;

		expect(data.events.total).toBe(1);
		expect(data.events.items[0].actorUserId).toBe(TEST_USER_IDS.manager);
	});

	it('не делает вид, что разобрал испорченный фильтр', async () => {
		await expect(loadAudit(pageEvent({ query: '?from=позавчера' }))).rejects.toMatchObject({
			status: 400
		});
	});

	it('закрыт для роли без права на журнал', async () => {
		await expect(loadAudit(pageEvent({ user: sessionUser('manager') }))).rejects.toMatchObject({
			status: 403
		});
	});
});

describe('выгрузка журнала', () => {
	beforeEach(async () => {
		await insertEvent({ type: 'auth.login', occurredAt: moscow('2026-09-10T10:00:00') });
		await insertEvent({ type: 'documents.uploaded', occurredAt: moscow('2026-09-10T11:00:00') });
	});

	it('отдаёт CSV с BOM, заголовками и вложением', async () => {
		const response = await exportAudit(pageEvent({ path: '/audit/export', query: '?format=csv' }));

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
		expect(response.headers.get('content-disposition')).toMatch(
			/^attachment; filename="audit-\d{4}-\d{2}-\d{2}\.csv"/
		);
		expect(response.headers.get('cache-control')).toBe('no-store');

		// Байты, а не `text()`: разбор ответа по спецификации сам съедает BOM, и
		// проверка на строке прошла бы даже без него.
		const bytes = new Uint8Array(await response.arrayBuffer());

		// BOM: без него Excel читает кириллицу в CSV как мусор.
		expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

		const lines = new TextDecoder().decode(bytes.slice(3)).split('\r\n');
		expect(lines[0]).toBe(
			'occurred_at;request_id;source;event_type;outcome;actor_label;actor_user_id;api_key_id;ip;user_agent;subject_type;subject_id;details'
		);
		expect(lines.filter((line) => line !== '')).toHaveLength(3);
	});

	it('называет файл московской датой, а не датой по Гринвичу', async () => {
		// 21:30 по Гринвичу — это уже следующие сутки в Москве. Оператор работает
		// по Москве, границы фильтра — тоже московские сутки, и выгрузка за
		// сегодня не должна приезжать с вчерашним числом в имени.
		vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-12T21:30:00Z') });

		try {
			const response = await exportAudit(
				pageEvent({ path: '/audit/export', query: '?format=json' })
			);

			expect(response.headers.get('content-disposition')).toContain(
				'filename="audit-2026-09-13.json"'
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it('отдаёт JSON массивом и под тем же фильтром, что список', async () => {
		const response = await exportAudit(
			pageEvent({ path: '/audit/export', query: '?format=json&type=auth.login' })
		);

		expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

		const body: unknown = JSON.parse(await response.text());

		expect(Array.isArray(body)).toBe(true);
		expect(body).toHaveLength(1);
		expect((body as { eventType: string }[])[0].eventType).toBe('auth.login');
	});

	it('сама попадает в журнал', async () => {
		await exportAudit(pageEvent({ path: '/audit/export', query: '?format=json' }));

		const exported = await database.db
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'audit.exported'));

		expect(exported).toHaveLength(1);
	});

	it('закрыта для роли без права на выгрузку и оставляет след отказа', async () => {
		await expect(
			exportAudit(
				pageEvent({ path: '/audit/export', query: '?format=csv', user: sessionUser('manager') })
			)
		).rejects.toMatchObject({ status: 403 });

		// Выгрузка уносит адреса, клиентов и всю историю: попытка её забрать —
		// то, о чём администратор должен узнать, а не молчаливая ошибка в ответе.
		const denied = await database.db
			.select({ outcome: auditEvents.outcome, actorUserId: auditEvents.actorUserId })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'audit.exported'));

		expect(denied).toEqual([{ outcome: 'denied', actorUserId: TEST_USER_IDS.manager }]);
	});

	it('браузеру показывает отказ страницей журнала, а не страницей ошибки', async () => {
		// Сюда приходят по ссылке со списка, и вернуть человека надо туда же: на
		// странице журнала отказ стоит рядом с кнопками, которых он не может
		// нажать, а не вместо всего раздела.
		await expect(
			exportAudit(
				pageEvent({
					path: '/audit/export',
					query: '?format=csv',
					user: sessionUser('manager'),
					headers: { accept: 'text/html,application/xhtml+xml' }
				})
			)
		).rejects.toMatchObject({ status: 303, location: '/audit?denied=export' });

		// След отказа в журнале остаётся тот же: показ отказа его не отменяет.
		const denied = await database.db
			.select({ outcome: auditEvents.outcome })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'audit.exported'));

		expect(denied).toEqual([{ outcome: 'denied' }]);
	});

	it('страница журнала объясняет отказ, когда её об этом попросили', async () => {
		const withHint = (await loadAudit(pageEvent({ query: '?denied=export' }))) as PageData;
		const without = (await loadAudit(pageEvent())) as PageData;

		expect(withHint.exportDenied).toBe(true);
		expect(without.exportDenied).toBe(false);
	});
});

describe('гигиена журнала', () => {
	/** Контекст с подложенной строкой клиента: её задаёт тот, кто обращается. */
	function withUserAgent(userAgent: string): ActorContext {
		return { ...testActor(), userAgent };
	}

	it('обрезает строку клиента до потолка', async () => {
		await recordAuditEvent(withUserAgent('A'.repeat(8 * 1024)), {
			type: 'auth.login',
			outcome: 'success'
		});

		const [row] = await database.db
			.select({ userAgent: auditEvents.userAgent })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'auth.login'));

		// Заголовок `User-Agent` не проверяет никто: без потолка каждая запись
		// журнала уносила бы в базу столько, сколько влезло в запрос.
		expect(Buffer.byteLength(row.userAgent ?? '', 'utf8')).toBe(512);
	});

	it('режет по границе символа, а не байта', async () => {
		// 512 байт — это 256 кириллических букв: срез посреди буквы положил бы в
		// журнал «замену» вместо символа.
		await recordAuditEvent(withUserAgent('Я'.repeat(400)), {
			type: 'auth.login',
			outcome: 'success'
		});

		const [row] = await database.db
			.select({ userAgent: auditEvents.userAgent })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'auth.login'));

		expect(row.userAgent).toBe('Я'.repeat(256));
	});

	it('обезвреживает формулу в ячейке выгрузки', async () => {
		const formula = '=HYPERLINK("http://example.invalid/steal","Открыть")';

		await insertEvent({
			type: 'auth.login',
			occurredAt: moscow('2026-09-10T10:00:00'),
			userAgent: formula
		});

		const response = await exportAudit(pageEvent({ path: '/audit/export', query: '?format=csv' }));
		const lines = (await response.text()).split('\r\n');
		const line = lines.find((row) => row.includes('HYPERLINK'));

		if (line === undefined) {
			throw new Error('строка со строкой клиента не попала в выгрузку');
		}

		// Кавычки вокруг ячейки формулу не обезвреживают: таблица разбирает
		// содержимое уже после них. Обезвреживает апостроф в начале значения.
		const userAgentColumn = 9;
		expect(line.split(';')[userAgentColumn]).toBe(`"'${formula.replaceAll('"', '""')}"`);
	});
});

describe('запись настройки', () => {
	it('не остаётся в базе, если её не удалось записать в журнал', async () => {
		journal.failOn = 'settings.updated';

		await expect(setSetting(testActor(), 'session_idle_minutes', 45)).rejects.toThrow(
			'журнал недоступен'
		);

		// Настройка безопасности, поменянная без следа в журнале, ничем не
		// отличается от подменённой: значение обязано остаться прежним.
		await expect(getSetting('session_idle_minutes')).resolves.toBe(
			SETTING_DEFAULTS.session_idle_minutes
		);
	});

	it('оставляет след отказа, когда права на неё нет', async () => {
		await expect(
			setSetting(testActor({ roleId: 'manager' }), 'session_idle_minutes', 45)
		).rejects.toMatchObject({ code: 'forbidden' });

		const denied = await database.db
			.select({ outcome: auditEvents.outcome, actorUserId: auditEvents.actorUserId })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'settings.updated'));

		expect(denied).toEqual([{ outcome: 'denied', actorUserId: TEST_USER_IDS.manager }]);
		await expect(getSetting('session_idle_minutes')).resolves.toBe(
			SETTING_DEFAULTS.session_idle_minutes
		);
	});
});

describe('граница демонстрационной сессии', () => {
	beforeEach(() => {
		demo.mode = true;
	});

	it('оставляет журнал открытым, но прячет адреса и клиентов посетителей', async () => {
		const user = await demoSessionUser('admin');

		await insertEvent({
			type: 'auth.login',
			occurredAt: moscow('2026-09-10T10:00:00'),
			userAgent:
				'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
		});

		// Отбор по типу: заведение демонстрационной записи само попало в журнал.
		const data = (await loadAudit(pageEvent({ user, query: '?type=auth.login' }))) as PageData;

		// Журнал — часть того, что показывают, поэтому он остаётся; настоящими в
		// нём остаются только те поля, которые ничего не говорят о посетителе.
		expect(data.events.total).toBe(1);
		expect(data.events.items[0].eventType).toBe('auth.login');
		expect(data.events.items[0].ip).toBe('198.51.*.*');
		expect(data.events.items[0].userAgent).toBe('Chrome');

		// Выгрузка демонстрации остаётся: она обязана огрублять адрес и клиента
		// ровно так же, как экран, — и огрубляет. А выбор действующего лица
		// пуст: список пользователей демонстрации не принадлежит.
		expect(data.canExport).toBe(true);
		expect(data.actors).toEqual([]);
	});

	it('оставляет демонстрации учёт согласий, но не уничтожение данных', async () => {
		const user = await demoSessionUser('admin');

		// Согласия и сроки хранения — это и есть то, что на стенде показывают про
		// 152-ФЗ, и записанное там переигрывается: срок переназначают, согласие
		// отзывают.
		expect(user.permissions.has('people.manage_consents')).toBe(true);

		// Обезличивание не переигрывается: имя и контакты стираются насовсем, а
		// сид их не возвращает — посетитель стенда стёр бы справочник для всех,
		// кто придёт после него.
		expect(user.permissions.has('people.anonymize')).toBe(false);

		// Вычитание — у сессии, а не у роли: сама роль права не лишается.
		const role = await loadRolePermissions('admin');
		expect(role.has('people.anonymize')).toBe(true);
	});

	it('отдаёт демонстрации выгрузку журнала с тем же огрублением, что и экран', async () => {
		const user = await demoSessionUser('admin');

		await insertEvent({
			type: 'auth.login',
			occurredAt: moscow('2026-09-10T10:00:00'),
			userAgent:
				'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
		});

		const response = await exportAudit(
			pageEvent({ path: '/audit/export', query: '?format=csv&type=auth.login', user })
		);
		const body = await (response as Response).text();

		// Выгрузка — это то же, что экран, файлом: огрубление адреса и клиента
		// обязано быть тем же, иначе она уносит со стенда то, что экран прячет.
		expect(body).toContain('198.51.*.*');
		expect(body).not.toContain('Mozilla/5.0');

		const exported = await database.db
			.select({ outcome: auditEvents.outcome, actorUserId: auditEvents.actorUserId })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'audit.exported'));

		expect(exported).toEqual([{ outcome: 'success', actorUserId: user.id }]);
	});

	it('не пускает демонстрацию в раздел пользователей', async () => {
		const user = await demoSessionUser('admin');

		await expect(loadUsers(pageEvent({ path: '/settings/users', user }))).rejects.toMatchObject({
			status: 403
		});

		// Отказ не в разметке, а в правах: форма, отправленная мимо страницы,
		// получает то же самое — и не претензию к полям, а 403.
		const result = await deactivateUserAction(
			pageEvent({
				path: '/settings/users',
				user,
				form: { userId: TEST_USER_IDS.manager }
			})
		);

		expect(result).toMatchObject({
			status: 403,
			data: { message: 'Недостаточно прав: требуется «users.manage»' }
		});
	});

	it('не даёт демонстрации выпустить ключ доступа', async () => {
		const user = await demoSessionUser('admin');

		await expect(loadKeys(pageEvent({ path: '/settings/api-keys', user }))).rejects.toMatchObject({
			status: 403
		});

		const result = await createKeyAction(
			pageEvent({
				path: '/settings/api-keys',
				user,
				form: { name: 'Ключ мимо стенда', ownerUserId: user.id }
			})
		);

		expect(result).toMatchObject({
			status: 403,
			data: { message: 'Недостаточно прав: требуется «api_keys.manage»' }
		});

		// Ключ пережил бы демонстрацию и пускал бы в API после неё — его нет.
		expect(await listApiKeys(testActor())).toEqual([]);
	});

	it('оставляет демонстрации настройки стенда: их на нём и показывают', async () => {
		const user = await demoSessionUser('admin');

		await expect(
			loadGeneral(pageEvent({ path: '/settings/general', user }))
		).resolves.toMatchObject({ bannerForm: expect.anything() });

		const result = await bannerAction(
			pageEvent({
				path: '/settings/general',
				user,
				form: { title: 'Свой баннер', text: 'Свой текст' }
			})
		);

		expect(result).toMatchObject({ form: { valid: true } });
		expect(await getSetting('login_banner')).toEqual({
			title: 'Свой баннер',
			text: 'Свой текст'
		});
	});

	it('не даёт демонстрации завершить сессии общей учётной записи', async () => {
		const user = await demoSessionUser('admin');
		const sessionId = await createSession(user.id, { ip: null, userAgent: null });

		// Учётная запись у демонстрации общая: «завершить все сессии» выкинуло бы
		// со стенда всех, кто его сейчас смотрит, а не автора нажатия.
		const result = await revokeAllAction(pageEvent({ path: '/settings/profile', user }));

		expect((result as { status: number }).status).toBe(403);
		expect((result as { data: { message: string } }).data.message).toContain(
			'Демонстрационная учётная запись общая'
		);

		// Чужая сессия пережила попытку.
		expect(await touchSession(sessionId)).toBe(user.id);
		await destroySession(sessionId);
	});

	it('рисует раздел профиля без обоих действий', async () => {
		const user = await demoSessionUser('admin');

		const data = (await loadProfile(pageEvent({ path: '/settings/profile', user }))) as {
			isDemo: boolean;
		};

		// Спрятанная кнопка отказ не заменяет, но и оставлять её нажимаемой
		// незачем: страница говорит, почему действия нет.
		expect(data.isDemo).toBe(true);
	});
});

describe('пользователи', () => {
	it('ищет по почте и имени', async () => {
		// Записи заводятся вставкой: в продукте они появляются при первом входе
		// через каталог, и формы заведения в разделе нет.
		await database.db.insert(users).values([
			{ email: 'novikov@example.org', fullName: 'Новиков Пётр', roleId: 'manager' },
			{ email: 'orlova@example.org', fullName: 'Орлова Мария', roleId: 'manager' }
		]);

		const byEmail = (await loadUsers(
			pageEvent({ path: '/settings/users', query: '?q=novikov@example' })
		)) as UsersPageData;

		expect(byEmail.users.items.map((user) => user.email)).toEqual(['novikov@example.org']);

		// Счётчик тоже под отбором: иначе пагинация обещала бы страницы, которых
		// под поиском нет.
		const byName = (await loadUsers(
			pageEvent({ path: '/settings/users', query: '?q=Орлова' })
		)) as UsersPageData;

		expect(byName.users.items.map((user) => user.email)).toEqual(['orlova@example.org']);
		expect(byName.users.total).toBe(1);

		// Без поиска список прежний: по пользователю на каждую системную роль
		// плюс двое заведённых.
		const all = (await loadUsers(pageEvent({ path: '/settings/users' }))) as UsersPageData;

		expect(all.users.total).toBe(DEFAULT_ROLES.length + 2);
	});

	it('включает выключенную запись обратно и говорит об этом', async () => {
		const [created] = await database.db
			.insert(users)
			.values({ email: 'orlova@example.org', fullName: 'Орлова Мария', roleId: 'manager' })
			.returning({ id: users.id });

		const off = await deactivateUserAction(
			pageEvent({ path: '/settings/users', form: { userId: created.id } })
		);
		expect(off).toEqual({ message: 'Учётная запись выключена, её сессии завершены', issues: [] });

		const on = await activateUserAction(
			pageEvent({ path: '/settings/users', form: { userId: created.id } })
		);
		expect(on).toEqual({ message: 'Учётная запись включена, вход открыт', issues: [] });

		const activated = await database.db
			.select({ subjectId: auditEvents.subjectId })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'users.activated'));

		expect(activated).toEqual([{ subjectId: created.id }]);
	});

	it('переводит отказ выключить демонстрационную запись в сообщение формы', async () => {
		demo.mode = true;
		const [created] = await database.db
			.insert(users)
			.values({
				email: 'demo-lead@example.org',
				fullName: 'Руководитель Демо',
				roleId: 'lead',
				isDemo: true
			})
			.returning({ id: users.id });

		const result = await deactivateUserAction(
			pageEvent({ path: '/settings/users', form: { userId: created.id } })
		);

		expect((result as { status: number }).status).toBe(409);
		expect((result as { data: { message: string } }).data.message).toBe(
			'Демонстрационную учётную запись нельзя выключить, пока включён демо-режим'
		);
	});

	it('не роняет запрос на идентификаторе, который не может быть нашим', async () => {
		// `abc` — это не «не нашли», а «прислали не то»: без разбора схемой строка
		// доехала бы до запроса к `uuid`-столбцу и вернулась ошибкой PostgreSQL,
		// то есть пятисотой на месте обычной претензии к запросу.
		for (const action of [deactivateUserAction, activateUserAction]) {
			const result = await action(pageEvent({ path: '/settings/users', form: { userId: 'abc' } }));

			expect((result as { status: number }).status).toBe(400);
		}

		// Идентификатор нашей формы, за которым никого нет, — это 404.
		const absent = await deactivateUserAction(
			pageEvent({ path: '/settings/users', form: { userId: ABSENT_ID } })
		);

		expect((absent as { status: number }).status).toBe(404);
	});

	it('ведёт иерархию сотрудников и гасит сессии затронутых', async () => {
		const [subordinate] = await database.db
			.insert(users)
			.values({ email: 'gromov@example.org', fullName: 'Громов Илья', roleId: 'manager' })
			.returning({ id: users.id });

		const result = await managerAction(
			pageEvent({
				path: '/settings/users',
				form: { userId: subordinate.id, managerUserId: TEST_USER_IDS.lead }
			})
		);

		expect(result).toMatchObject({ message: expect.stringContaining('Руководитель назначен') });

		const [row] = await database.db
			.select({ managerUserId: users.managerUserId })
			.from(users)
			.where(eq(users.id, subordinate.id));

		expect(row.managerUserId).toBe(TEST_USER_IDS.lead);

		// Роль отсюда не назначается: её приносит токен каталога на каждом входе.
		const data = (await loadUsers(pageEvent({ path: '/settings/users' }))) as UsersPageData;
		expect(data.users.items.every((item) => typeof item.roleName === 'string')).toBe(true);
	});
});

describe('ключи доступа', () => {
	it('показывает сырой ключ один раз — при выпуске', async () => {
		const result = await createKeyAction(
			pageEvent({
				path: '/settings/api-keys',
				form: { name: 'Выгрузка в 1С', ownerUserId: TEST_USER_IDS.admin }
			})
		);

		const issued = formOf(result).message as { name: string; key: string };

		expect(issued.name).toBe('Выгрузка в 1С');
		expect(issued.key).toMatch(/^lct_[A-Za-z0-9_-]{32}$/);

		// Второй раз ключа нет нигде: в базе остался только его хеш.
		const keys = await listApiKeys(testActor());
		expect(keys).toHaveLength(1);
		expect(JSON.stringify(keys)).not.toContain(issued.key);
	});

	it('не роняет отзыв на идентификаторе, который не может быть нашим', async () => {
		const result = await revokeKeyAction(
			pageEvent({ path: '/settings/api-keys', form: { apiKeyId: 'abc' } })
		);

		expect((result as { status: number }).status).toBe(400);

		const absent = await revokeKeyAction(
			pageEvent({ path: '/settings/api-keys', form: { apiKeyId: ABSENT_ID } })
		);

		expect((absent as { status: number }).status).toBe(404);
	});
});

describe('профиль', () => {
	async function account() {
		const [created] = await database.db
			.insert(users)
			.values({ email: 'orlova@example.org', fullName: 'Орлова Мария', roleId: 'manager' })
			.returning({ id: users.id });

		return testActor({ roleId: 'manager', userId: created.id }).user as SessionUser;
	}

	it('гасит все сессии владельца и снимает cookie', async () => {
		const user = await account();
		const sessionId = await createSession(user.id, { ip: null, userAgent: null });

		const result = await revokeAllAction(pageEvent({ path: '/settings/profile', user }));

		expect(result).toMatchObject({ message: 'Все сессии завершены — войдите заново.' });
		// Сессия погашена в Redis, а не только в браузере: иначе украденный
		// идентификатор пережил бы нажатие.
		expect(await touchSession(sessionId)).toBeNull();

		const loggedOut = await database.db
			.select({ actorUserId: auditEvents.actorUserId })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'auth.logout'));

		expect(loggedOut).toEqual([{ actorUserId: user.id }]);
	});
});
