// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
import { vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApiKey } from '$lib/server/api/keys';
import {
	auditEvents,
	interactions,
	organizations,
	people,
	programs,
	roles,
	statRows,
	statSnapshots
} from '$lib/server/db/schema';
import { LMS_REFUSAL } from '$lib/server/integrations/lms/moodle';
import { syncLms } from '$lib/server/integrations/lms/sync';
import {
	MOCK_LMS_TOKEN,
	mockRest,
	mockToken,
	readParams
} from '$lib/server/integrations/mock-lms/server';
import { getLmsSettings, setLmsSettings } from '$lib/server/integrations/settings';
import { rejectSnapshot } from '$lib/server/stats/import';
import { getRedis } from '$lib/server/redis';
import { B2B_GROUP_KEY, B2B_PROCESS } from '$lib/server/stages/definitions';
import { ensureProcess } from '$lib/server/stages/process';
import {
	insertOrganization,
	insertUser,
	startTestDatabase,
	testActor,
	TEST_USER_IDS,
	type TestDatabase
} from '../helpers/db';
import { pageEvent } from '../helpers/event';

/**
 * Выгрузка из системы обучения и приём заявки с сайта.
 *
 * Система обучения здесь настоящая настолько, насколько она вообще бывает в
 * прогоне: тот же мок, что живёт под `/mock-lms`, поднят обычным HTTP-сервером,
 * и клиент ходит в него по сети. Заявка идёт через `apiHandler` — ту же
 * обёртку, что вызывает SvelteKit.
 */
let database: TestDatabase;
let server: Server;
let port: number;

/** Чужой адрес, на который площадка пробует нас увести. */
let elsewhere: Server;
let elsewherePort: number;
let elsewhereReceived: string[] = [];
/** Куда заглушка перенаправляет; `null` — отвечает сама. */
let redirectTo: string | null = null;

const intake = (await import('../../../src/routes/api/v1/applications/+server')).POST as (
	event: RequestEvent
) => Promise<Response>;

const settingsActions = (
	await import('../../../src/routes/(app)/settings/integrations/+page.server')
).actions as Record<string, (event: RequestEvent) => Promise<unknown>>;

beforeAll(async () => {
	database = await startTestDatabase();

	server = createServer((request, response) => {
		if (redirectTo !== null) {
			// Перенаправление «как у переехавшей площадки»: строка запроса едет
			// вместе с адресом, а в ней — токен веб-сервиса.
			const incoming = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);

			response.statusCode = 307;
			response.setHeader('location', `${redirectTo}${incoming.search}`);
			response.end();
			return;
		}

		void (async () => {
			const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
			const params = await readParams(
				new Request(url, {
					method: request.method,
					// Мок читает параметры и из строки, и из тела; телом в прогоне не
					// пользуемся, но путь один и тот же.
					body: undefined
				}),
				url
			);

			const { status, body } = url.pathname.endsWith('/login/token.php')
				? mockToken(params)
				: mockRest(params, new Date());

			response.statusCode = status;
			response.setHeader('content-type', 'application/json');
			response.end(JSON.stringify(body));
		})();
	});

	elsewhere = createServer((request, response) => {
		elsewhereReceived.push(request.url ?? '');
		response.statusCode = 200;
		response.setHeader('content-type', 'application/json');
		response.end('[]');
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	port = (server.address() as AddressInfo).port;

	await new Promise<void>((resolve) => elsewhere.listen(0, '127.0.0.1', resolve));
	elsewherePort = (elsewhere.address() as AddressInfo).port;
}, 300_000);

afterAll(async () => {
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve()))
	);
	await new Promise<void>((resolve, reject) =>
		elsewhere.close((error) => (error ? reject(error) : resolve()))
	);
	await getRedis().quit();
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();
	elsewhereReceived = [];
	redirectTo = null;
});

const ctx = () => testActor();

function lmsUrl(): string {
	return `http://127.0.0.1:${port}`;
}

async function configureLms(token: string = MOCK_LMS_TOKEN, baseUrl: string = lmsUrl()) {
	await setLmsSettings(ctx(), {
		baseUrl,
		token,
		enabled: false,
		syncIntervalMinutes: 60
	});
}

/** Справочник, в котором выгрузке есть что опознать. */
async function seedDirectory(): Promise<void> {
	await insertOrganization(database.db, { shortName: 'СЗПУ' });
	// Программа, которую по данным мока слушают во всех вузах: строка про неё
	// обязана опознаться, остальные останутся с претензиями — это и проверяется.
	await database.db.insert(programs).values({
		code: 'VO-MAG-01',
		name: 'Инженерия данных и машинное обучение',
		level: 'master',
		status: 'active'
	});
}

describe('выгрузка из системы обучения', () => {
	it('становится проверенным снимком, который ждёт подтверждения', async () => {
		await seedDirectory();
		await configureLms();

		const state = await syncLms(ctx());

		expect(state.ok).toBe(true);
		expect(state.snapshotId).not.toBeNull();
		expect(state.rows).toBeGreaterThan(0);

		const [snapshot] = await database.db
			.select()
			.from(statSnapshots)
			.where(eq(statSnapshots.id, state.snapshotId!));

		// Подтверждение вводит числа в показатели, и это решение человека:
		// выгрузка останавливается на «проверен».
		expect(snapshot).toMatchObject({
			source: 'lms',
			mode: 'full',
			periodKind: 'academic',
			status: 'validated',
			isCurrent: false
		});

		const rows = await database.db
			.select({ isValid: statRows.isValid, programId: statRows.programId })
			.from(statRows)
			.where(eq(statRows.snapshotId, snapshot.id));

		expect(rows).toHaveLength(state.rows);
		// Строки про заведённый вуз и заведённую программу опознались; остальные
		// остаются в снимке с претензиями — это видно счётчиком ошибок.
		expect(rows.filter((row) => row.isValid).length).toBeGreaterThan(0);
		expect(snapshot.errorCount).toBe(rows.filter((row) => !row.isValid).length);

		const journal = await database.db
			.select({ type: auditEvents.eventType })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'integrations.lms_synced'));

		expect(journal).toHaveLength(1);
	});

	it('второй заход за тем же не создаёт второго снимка', async () => {
		await seedDirectory();
		await configureLms();

		const first = await syncLms(ctx());
		const second = await syncLms(ctx());

		expect(second.ok).toBe(true);
		expect(second.snapshotId).toBeNull();
		expect(second.message).toContain('Изменений нет');

		const snapshots = await database.db.select({ id: statSnapshots.id }).from(statSnapshots);

		expect(snapshots.map((row) => row.id)).toEqual([first.snapshotId]);
	});

	it('после отклонения снимка та же выгрузка загружается заново', async () => {
		await seedDirectory();
		await configureLms();

		const first = await syncLms(ctx());
		await rejectSnapshot(ctx(), first.snapshotId!, 'Числа не сошлись с отчётом вуза');

		const second = await syncLms(ctx());

		expect(second.ok).toBe(true);
		expect(second.snapshotId).not.toBeNull();
		expect(second.snapshotId).not.toBe(first.snapshotId);

		const snapshots = await database.db.select({ id: statSnapshots.id }).from(statSnapshots);

		expect(snapshots).toHaveLength(2);
	});

	it('отказывает одним текстом, не пересказывая ответ чужой системы', async () => {
		await configureLms('чужой-токен');

		const state = await syncLms(ctx());

		expect(state.ok).toBe(false);
		expect(state.snapshotId).toBeNull();
		// Один текст на любой отказ: по разнице формулировок («отказала»,
		// «ответила 403», «не в формате JSON») раздел настроек превратился бы в
		// определитель чужой сети.
		expect(state.message).toBe(LMS_REFUSAL);

		const journal = await database.db
			.select({
				type: auditEvents.eventType,
				outcome: auditEvents.outcome,
				details: auditEvents.details
			})
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'integrations.lms_sync_failed'));

		// В журнале остаётся код ответа — и ничего из тела ответа.
		expect(journal).toMatchObject([{ outcome: 'failure', details: { status: 200 } }]);
		expect(JSON.stringify(journal[0].details)).not.toContain('token');
	});

	it('не идёт за перенаправлением и не уносит туда токен веб-сервиса', async () => {
		await configureLms();
		redirectTo = `http://127.0.0.1:${elsewherePort}/webservice/rest/server.php`;

		const state = await syncLms(ctx());

		expect(state.ok).toBe(false);
		expect(state.message).toBe(LMS_REFUSAL);
		// Токен уходит параметром строки запроса: пойди клиент за `Location`, он
		// оказался бы на машине, которую правило адреса не проверяло.
		expect(elsewhereReceived).toHaveLength(0);
		expect(elsewhereReceived.join(' ')).not.toContain(MOCK_LMS_TOKEN);
	});

	it('не молчит о ненастроенной интеграции', async () => {
		const state = await syncLms(ctx());

		expect(state).toMatchObject({ ok: false, snapshotId: null });
		expect(state.message).toContain('Не настроено');
	});

	it('не пускает того, у кого нет права на интеграции', async () => {
		await expect(syncLms(testActor({ roleId: 'manager' }))).rejects.toMatchObject({
			code: 'forbidden'
		});
	});
});

describe('форма настроек системы обучения', () => {
	it('не возвращает токен веб-сервиса в ответ действия', async () => {
		const secret = 'ws-token-0f3a9c';

		const result = await settingsActions.lms(
			pageEvent({
				path: '/settings/integrations',
				routeId: '/(app)/settings/integrations',
				form: {
					baseUrl: lmsUrl(),
					token: secret,
					syncIntervalMinutes: '60'
				}
			})
		);

		// Ответ действия перерисовывает форму её же данными — и токен уехал бы в
		// разметку страницы, хотя сохранённым его не показывают вовсе.
		expect(JSON.stringify(result)).not.toContain(secret);

		// При этом он именно сохранён, а не потерян по дороге.
		expect((await getLmsSettings()).token).toBe(secret);
	});
});

/* ------------------------------------------------------------------ */
/* Приём заявок                                                        */
/* ------------------------------------------------------------------ */

function apiEvent(options: { body: unknown; key: string; idempotencyKey?: string }): RequestEvent {
	const url = new URL('http://localhost/api/v1/applications');
	const headers: Record<string, string> = {
		authorization: `Bearer ${options.key}`,
		'content-type': 'application/json'
	};

	if (options.idempotencyKey !== undefined) {
		headers['idempotency-key'] = options.idempotencyKey;
	}

	return {
		request: new Request(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(options.body)
		}),
		url,
		params: {},
		route: { id: '/api/v1/applications' },
		locals: { requestId: crypto.randomUUID(), user: null, apiKey: null },
		getClientAddress: () => '198.51.100.42',
		setHeaders: () => {},
		isDataRequest: false,
		isSubRequest: false
	} as unknown as RequestEvent;
}

const APPLICATION = {
	externalId: 'site-2026-000123',
	organization: {
		name: 'Автономная некоммерческая организация «Учебный центр цифровых компетенций»',
		inn: '7802450127',
		kind: 'educational_institution',
		educationLevel: 'vo'
	},
	contact: {
		lastName: 'Кузьмина',
		firstName: 'Наталья',
		middleName: 'Петровна',
		email: 'kuzmina@example.org',
		phone: '+7 900 000-00-11',
		position: 'Проректор по цифровому развитию'
	},
	interest: 'Программа подготовки по прикладной информатике',
	comment: 'Просим связаться до конца недели.'
};

async function issueKey(roleId = 'manager'): Promise<string> {
	const created = await createApiKey(testActor(), {
		name: 'Форма на сайте',
		ownerUserId: TEST_USER_IDS[roleId]
	});

	return created.key;
}

/**
 * Ключ владельца без единого права: он проходит вход, но не действие.
 *
 * Роли «только смотреть» в системе нет, а право на заведение взаимодействия
 * есть у всех трёх ролей человека, — поэтому владелец заводится на своей роли с
 * пустым набором прав. Отказ при этом остаётся тем же самым: его даёт
 * `requirePermission`, а не отсутствие роли.
 */
async function keyWithoutPermissions(): Promise<string> {
	await database.db
		.insert(roles)
		.values({ id: 'restricted', name: 'Без прав', description: 'Только для проверки отказа' })
		.onConflictDoNothing();

	const ownerUserId = await insertUser(database.db, { roleId: 'restricted' });
	const created = await createApiKey(testActor(), { name: 'Ключ без прав', ownerUserId });

	return created.key;
}

describe('приём заявки с сайта', () => {
	beforeEach(async () => {
		await database.db.transaction(async (tx) => {
			await ensureProcess(tx, B2B_GROUP_KEY, B2B_PROCESS);
		});
	});

	it('становится взаимодействием на маршруте по умолчанию', async () => {
		const key = await issueKey();
		const response = await intake(apiEvent({ body: APPLICATION, key }));
		const body = (await response.json()) as { interactionId: string; created: boolean };

		expect(response.status).toBe(200);
		expect(body.created).toBe(true);

		const [interaction] = await database.db
			.select()
			.from(interactions)
			.where(eq(interactions.id, body.interactionId));

		expect(interaction).toMatchObject({
			externalSource: 'site',
			externalId: APPLICATION.externalId,
			status: 'active',
			ownerUserId: TEST_USER_IDS.manager
		});
		expect(interaction.title).toContain('Заявка с сайта');

		const journal = await database.db
			.select({ type: auditEvents.eventType, details: auditEvents.details })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'integrations.application_received'));

		expect(journal).toMatchObject([{ details: { interactionId: body.interactionId } }]);
	});

	it('повтор с тем же идентификатором возвращает ту же запись', async () => {
		const key = await issueKey();

		const first = (await (await intake(apiEvent({ body: APPLICATION, key }))).json()) as {
			interactionId: string;
			created: boolean;
		};
		const second = (await (await intake(apiEvent({ body: APPLICATION, key }))).json()) as {
			interactionId: string;
			created: boolean;
		};

		expect(second).toEqual({ interactionId: first.interactionId, created: false });

		const rows = await database.db.select({ id: interactions.id }).from(interactions);
		expect(rows).toHaveLength(1);
	});

	it('вторая заявка того же вуза не заводит вторую организацию', async () => {
		const key = await issueKey();

		await intake(apiEvent({ body: APPLICATION, key }));
		const response = await intake(
			apiEvent({
				body: {
					...APPLICATION,
					externalId: 'site-2026-000124',
					organization: { ...APPLICATION.organization, name: 'ИНН тот же, название другое' }
				},
				key
			})
		);

		expect(response.status).toBe(200);

		const organizations = await database.db.select({ id: interactions.id }).from(interactions);

		// Два взаимодействия, одна организация: сверка идёт по ИНН.
		expect(organizations).toHaveLength(2);

		const rows = await database.db
			.select({ type: auditEvents.eventType })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'organizations.created'));

		expect(rows).toHaveLength(1);
	});

	it('не принимает заявку без права на взаимодействия', async () => {
		const key = await keyWithoutPermissions();
		const response = await intake(apiEvent({ body: APPLICATION, key }));

		expect(response.status).toBe(403);
		expect((await response.json()) as { error: { code: string } }).toMatchObject({
			error: { code: 'forbidden' }
		});
	});

	it('объясняет непрошедшее тело в общем конверте', async () => {
		const key = await issueKey();
		const response = await intake(
			apiEvent({
				body: { ...APPLICATION, contact: { ...APPLICATION.contact, email: 'не-почта' } },
				key
			})
		);

		expect(response.status).toBe(400);

		const body = (await response.json()) as {
			error: { code: string; details: { issues: string[] } };
		};

		expect(body.error.code).toBe('validation');
		expect(body.error.details.issues.join(' ')).toContain('почта');
	});

	it('три одновременных заявки с одним идентификатором дают одну запись', async () => {
		const key = await issueKey();
		// Без ИНН: сверять организацию не с чем, и до одной транзакции каждая из
		// трёх заявок заводила свою организацию и своего человека, а двое из трёх
		// получали 500 на уникальности внешней ссылки.
		const body = { ...APPLICATION, organization: { ...APPLICATION.organization, inn: null } };

		const responses = await Promise.all([
			intake(apiEvent({ body, key })),
			intake(apiEvent({ body, key })),
			intake(apiEvent({ body, key }))
		]);

		expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);

		const bodies = (await Promise.all(responses.map((response) => response.json()))) as {
			interactionId: string;
			created: boolean;
		}[];

		// Заведена запись одна, и все три ответа указывают на неё; завёл её
		// ровно один запрос, остальные ответили как обычный повтор.
		expect(new Set(bodies.map((item) => item.interactionId)).size).toBe(1);
		expect(bodies.filter((item) => item.created)).toHaveLength(1);

		expect(await database.db.select({ id: interactions.id }).from(interactions)).toHaveLength(1);
		// Сирот в справочнике не остаётся: проигравшая транзакция откатилась целиком.
		expect(await database.db.select({ id: organizations.id }).from(organizations)).toHaveLength(1);
		expect(await database.db.select({ id: people.id }).from(people)).toHaveLength(1);

		// И след в журнале один: записи отката не пережили.
		const journal = await database.db
			.select({ type: auditEvents.eventType })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'organizations.created'));

		expect(journal).toHaveLength(1);
	});

	it('три одновременных заявки с ИНН тоже дают одну запись', async () => {
		const key = await issueKey();

		// С ИНН гонка расходится на другом ограничении — уникальности ИНН
		// организации, — и ответ обязан быть тем же: заявка одна.
		const responses = await Promise.all([
			intake(apiEvent({ body: APPLICATION, key })),
			intake(apiEvent({ body: APPLICATION, key })),
			intake(apiEvent({ body: APPLICATION, key }))
		]);

		expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);

		const bodies = (await Promise.all(responses.map((response) => response.json()))) as {
			interactionId: string;
			created: boolean;
		}[];

		expect(new Set(bodies.map((item) => item.interactionId)).size).toBe(1);
		expect(bodies.filter((item) => item.created)).toHaveLength(1);
		expect(await database.db.select({ id: interactions.id }).from(interactions)).toHaveLength(1);
		expect(await database.db.select({ id: organizations.id }).from(organizations)).toHaveLength(1);
		expect(await database.db.select({ id: people.id }).from(people)).toHaveLength(1);
	});

	it('повтор с ключом идемпотентности отдаёт прежний ответ', async () => {
		const key = await issueKey();
		const idempotencyKey = crypto.randomUUID();

		const first = await intake(apiEvent({ body: APPLICATION, key, idempotencyKey }));
		const second = await intake(apiEvent({ body: APPLICATION, key, idempotencyKey }));

		expect(second.headers.get('Idempotency-Replay')).toBe('true');
		expect(await second.json()).toEqual(await first.json());
	});
});
