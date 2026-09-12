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
	programs,
	statRows,
	statSnapshots
} from '$lib/server/db/schema';
import { syncLms } from '$lib/server/integrations/lms/sync';
import {
	MOCK_LMS_TOKEN,
	mockRest,
	mockToken,
	readParams
} from '$lib/server/integrations/mock-lms/server';
import { setLmsSettings } from '$lib/server/integrations/settings';
import { getRedis } from '$lib/server/redis';
import { ensureDemoRoute } from '$lib/server/stages/routes';
import {
	insertOrganization,
	startTestDatabase,
	testActor,
	TEST_USER_IDS,
	type TestDatabase
} from '../helpers/db';

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

const intake = (await import('../../../src/routes/api/v1/applications/+server')).POST as (
	event: RequestEvent
) => Promise<Response>;

beforeAll(async () => {
	database = await startTestDatabase();

	server = createServer((request, response) => {
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

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	port = (server.address() as AddressInfo).port;
}, 300_000);

afterAll(async () => {
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve()))
	);
	await getRedis().quit();
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();
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

	it('называет отказ веб-сервиса словами и пишет неудачу в журнал', async () => {
		await configureLms('чужой-токен');

		const state = await syncLms(ctx());

		expect(state.ok).toBe(false);
		expect(state.message).toContain('Invalid token');
		expect(state.snapshotId).toBeNull();

		const journal = await database.db
			.select({ type: auditEvents.eventType, outcome: auditEvents.outcome })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'integrations.lms_sync_failed'));

		expect(journal).toMatchObject([{ outcome: 'failure' }]);
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

describe('приём заявки с сайта', () => {
	beforeEach(async () => {
		await database.db.transaction(async (tx) => {
			await ensureDemoRoute(tx);
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
		const key = await issueKey('viewer');
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

	it('повтор с ключом идемпотентности отдаёт прежний ответ', async () => {
		const key = await issueKey();
		const idempotencyKey = crypto.randomUUID();

		const first = await intake(apiEvent({ body: APPLICATION, key, idempotencyKey }));
		const second = await intake(apiEvent({ body: APPLICATION, key, idempotencyKey }));

		expect(second.headers.get('Idempotency-Replay')).toBe('true');
		expect(await second.json()).toEqual(await first.json());
	});
});
