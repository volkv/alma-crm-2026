// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
import { vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditEvents, programs, statRows, statSnapshots } from '$lib/server/db/schema';
import { LMS_REFUSAL } from '$lib/server/integrations/lms/moodle';
import { syncLms } from '$lib/server/integrations/lms/sync';
import { getLmsSettings, setLmsSettings } from '$lib/server/integrations/settings';
import { rejectSnapshot } from '$lib/server/stats/import';
import { getRedis } from '$lib/server/redis';
import { MOCK_LMS_TOKEN } from '../../../mocks/mock-lms/moodle.ts';
import { startMockLms } from '../../../mocks/mock-lms/service.ts';
import type { MockService } from '../../../mocks/shared/http.ts';
import { insertOrganization, startTestDatabase, testActor, type TestDatabase } from '../helpers/db';
import { pageEvent } from '../helpers/event';

/**
 * Выгрузка из системы обучения.
 *
 * Система обучения здесь настоящая настолько, насколько она вообще бывает в
 * прогоне: имитатор стенда (`mocks/mock-lms`) поднят в этом же процессе на
 * свободном порту, и клиент ходит в него по сети — тем же веб-сервисом Moodle,
 * которым пойдёт в площадку заказчика. Его ответ ничего не доказывает о
 * настоящей LMS; доказывает он только то, что клиент говорит на объявленном
 * протоколе.
 */
let database: TestDatabase;
let lms: MockService;

/** Чужой адрес, на который площадка пробует нас увести. */
let elsewhere: Server;
let elsewherePort: number;
let elsewhereReceived: string[] = [];

/** Площадка, которая всегда отвечает перенаправлением на чужой адрес. */
let redirector: Server;
let redirectorPort: number;

const settingsActions = (
	await import('../../../src/routes/(app)/settings/integrations/+page.server')
).actions as Record<string, (event: RequestEvent) => Promise<unknown>>;

beforeAll(async () => {
	database = await startTestDatabase();
	lms = await startMockLms({ port: 0 });

	elsewhere = createServer((request, response) => {
		elsewhereReceived.push(request.url ?? '');
		response.statusCode = 200;
		response.setHeader('content-type', 'application/json');
		response.end('[]');
	});

	await new Promise<void>((resolve) => elsewhere.listen(0, '127.0.0.1', resolve));
	elsewherePort = (elsewhere.address() as AddressInfo).port;

	redirector = createServer((request, response) => {
		// Перенаправление «как у переехавшей площадки»: строка запроса едет вместе
		// с адресом, а в ней — токен веб-сервиса.
		const incoming = new URL(request.url ?? '/', `http://127.0.0.1:${redirectorPort}`);

		response.statusCode = 307;
		response.setHeader(
			'location',
			`http://127.0.0.1:${elsewherePort}/webservice/rest/server.php${incoming.search}`
		);
		response.end();
	});

	await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve));
	redirectorPort = (redirector.address() as AddressInfo).port;
}, 300_000);

afterAll(async () => {
	await lms?.stop();
	await new Promise<void>((resolve, reject) =>
		elsewhere.close((error) => (error ? reject(error) : resolve()))
	);
	await new Promise<void>((resolve, reject) =>
		redirector.close((error) => (error ? reject(error) : resolve()))
	);
	await getRedis().quit();
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();
	elsewhereReceived = [];
});

const ctx = () => testActor();

function lmsUrl(): string {
	return lms.url;
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
	// Программа, которую по данным имитатора слушают во всех вузах: строка про
	// неё обязана опознаться, остальные останутся с претензиями — это и
	// проверяется.
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
		await configureLms(MOCK_LMS_TOKEN, `http://127.0.0.1:${redirectorPort}`);

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
