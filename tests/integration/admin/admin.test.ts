import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEventType, AuditOutcome, AuditSource } from '$lib/contracts/audit';
import type { SessionUser } from '$lib/server/auth/types';
import { listApiKeys } from '$lib/server/api/keys';
import { createUser } from '$lib/server/auth/users';
import { auditEvents } from '$lib/server/db/schema';
import { getRedis } from '$lib/server/redis';
import { startTestDatabase, testActor, TEST_USER_IDS, type TestDatabase } from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

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

const loadAudit = auditPage.load as unknown as PageLoad;
const exportAudit = auditExport.GET as unknown as Endpoint;
const createUserAction = usersPage.actions.create as unknown as FormAction;
const changePasswordAction = profilePage.actions.password as unknown as FormAction;
const createKeyAction = keysPage.actions.create as unknown as FormAction;

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
});

/** Пользователь запроса: тот же, что кладёт в `locals` хук сессии. */
function sessionUser(roleId: string): SessionUser {
	const user = testActor({ roleId }).user;

	if (user === null) {
		throw new Error('testActor обязан вернуть пользователя');
	}

	return user;
}

type EventOptions = {
	path?: string;
	query?: string;
	method?: string;
	user?: SessionUser;
	form?: Record<string, string>;
};

/**
 * Событие запроса в том виде, в каком его собирает SvelteKit. Загрузчику и
 * действию нужны адрес, тело, `locals` и адрес вызывающего — остальное в
 * подделке не участвует.
 */
function pageEvent(options: EventOptions = {}): RequestEvent {
	const url = new URL(`http://localhost${options.path ?? '/audit'}${options.query ?? ''}`);

	let body: FormData | undefined;
	if (options.form !== undefined) {
		body = new FormData();
		for (const [name, value] of Object.entries(options.form)) {
			body.set(name, value);
		}
	}

	return {
		request: new Request(url, { method: options.method ?? (body ? 'POST' : 'GET'), body }),
		url,
		params: {},
		// Действия профиля снимают cookie сессии; больше от неё ничего не нужно.
		cookies: { get: () => undefined, set: () => {}, delete: () => {} },
		route: { id: '/(app)/audit' },
		locals: {
			requestId: crypto.randomUUID(),
			user: options.user ?? sessionUser('admin'),
			apiKey: null
		},
		getClientAddress: () => '198.51.100.10',
		setHeaders: () => {},
		isDataRequest: false,
		isSubRequest: false
	} as unknown as RequestEvent;
}

type EventFixture = {
	type: AuditEventType;
	occurredAt: Date;
	outcome?: AuditOutcome;
	source?: AuditSource;
	actorUserId?: string | null;
	subjectType?: string;
	subjectId?: string;
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
		subjectType: event.subjectType ?? null,
		subjectId: event.subjectId ?? null
	});
}

/** Московские сутки: журнал фильтруется календарными днями оператора. */
function moscow(iso: string): Date {
	return new Date(`${iso}+03:00`);
}

type PageData = {
	events: { items: { eventType: string; actorUserId: string | null }[]; total: number };
	canExport: boolean;
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
		await insertEvent({ type: 'auth.login_failed', occurredAt: moscow('2026-09-02T00:30:00') });
		await insertEvent({ type: 'auth.locked', occurredAt: moscow('2026-08-31T23:30:00') });

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
		await expect(loadAudit(pageEvent({ user: sessionUser('viewer') }))).rejects.toMatchObject({
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

	it('закрыта для роли без права на выгрузку', async () => {
		await expect(
			exportAudit(
				pageEvent({ path: '/audit/export', query: '?format=csv', user: sessionUser('manager') })
			)
		).rejects.toMatchObject({ status: 403 });
	});
});

describe('пользователи', () => {
	it('не заводит пользователя с паролем против политики', async () => {
		const result = await createUserAction(
			pageEvent({
				path: '/settings/users',
				form: {
					email: 'novikov@example.org',
					fullName: 'Новиков Пётр',
					roleId: 'manager',
					password: 'короткий'
				}
			})
		);

		expect((result as { status: number }).status).toBe(400);
		expect(formOf(result).errors._errors).toEqual([
			'Пароль не отвечает политике',
			'Пароль не короче 12 символов',
			'Используйте символы хотя бы 3 видов из четырёх: строчные буквы, прописные буквы, цифры, знаки'
		]);
	});

	it('заводит пользователя и возвращает сообщение', async () => {
		const result = await createUserAction(
			pageEvent({
				path: '/settings/users',
				form: {
					email: 'Novikov@Example.org',
					fullName: 'Новиков Пётр',
					roleId: 'manager',
					password: 'Проверка-Входа1'
				}
			})
		);

		expect(formOf(result).message).toBe('Пользователь Новиков Пётр заведён');
	});

	it('говорит словами, что почта занята', async () => {
		const form = {
			email: 'novikov@example.org',
			fullName: 'Новиков Пётр',
			roleId: 'manager',
			password: 'Проверка-Входа1'
		};

		await createUserAction(pageEvent({ path: '/settings/users', form }));
		const result = await createUserAction(pageEvent({ path: '/settings/users', form }));

		expect(formOf(result).errors.email).toEqual(['Пользователь с такой почтой уже заведён']);
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
});

describe('профиль', () => {
	const password = 'Проверка-Входа1';

	async function account() {
		const created = await createUser(testActor(), {
			email: 'orlova@example.org',
			fullName: 'Орлова Мария',
			roleId: 'manager',
			password
		});

		return testActor({ roleId: 'manager', userId: created.id }).user as SessionUser;
	}

	it('не меняет пароль, если текущий указан неверно', async () => {
		const user = await account();

		const result = await changePasswordAction(
			pageEvent({
				path: '/settings/profile',
				user,
				form: { current: 'совсем не тот', next: 'Другой-Пароль-9', repeat: 'Другой-Пароль-9' }
			})
		);

		expect((result as { status: number }).status).toBe(400);
		expect(formOf(result).errors._errors).toEqual([
			'Пароль не изменён',
			'Текущий пароль указан неверно'
		]);
	});

	it('меняет пароль, говорит о завершённых сессиях и пишет это в журнал', async () => {
		const user = await account();

		const result = await changePasswordAction(
			pageEvent({
				path: '/settings/profile',
				user,
				form: { current: password, next: 'Другой-Пароль-9', repeat: 'Другой-Пароль-9' }
			})
		);

		expect(formOf(result).message).toBe('Пароль изменён. Все сессии завершены — войдите заново.');

		const changed = await database.db
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'auth.password_changed'));

		expect(changed).toHaveLength(1);
		expect(changed[0].actorUserId).toBe(user.id);
	});
});
