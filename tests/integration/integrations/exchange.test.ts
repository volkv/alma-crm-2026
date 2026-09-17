// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
import { vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import { and, eq, sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApiKey } from '$lib/server/api/keys';
import {
	auditEvents,
	comments,
	consents,
	documents,
	exchangeMessages,
	interactions,
	learningGroupResults,
	learningGroups,
	organizationResponsibles,
	organizations,
	people,
	stageEntries
} from '$lib/server/db/schema';
import { runExchangeCycle } from '$lib/server/integrations/exchange/delivery';
import { readExchangeFile } from '$lib/server/integrations/exchange/files';
import { listLearningGroups, requestLearningGroup } from '$lib/server/integrations/exchange/groups';
import { enqueueApplicationStatus } from '$lib/server/integrations/exchange/outbox';
import { receiveLearningGroupResult } from '$lib/server/integrations/exchange/results';
import { setExchangeSettings } from '$lib/server/integrations/settings';
import { withTransaction } from '$lib/server/db/transaction';
import { getRedis } from '$lib/server/redis';
import { advanceStage } from '$lib/server/stages/commands';
import {
	B2B_GROUP_KEY,
	B2B_PROCESS,
	B2C_GROUP_KEY,
	B2C_PROCESS
} from '$lib/server/stages/definitions';
import { ensureProcess } from '$lib/server/stages/process';
import { startMockCms } from '../../../mocks/mock-cms/service.ts';
import { startMockLms } from '../../../mocks/mock-lms/service.ts';
import type { MockService } from '../../../mocks/shared/http.ts';
import {
	insertDocument,
	insertOrganization,
	startTestDatabase,
	testActor,
	TEST_USER_IDS,
	type TestDatabase
} from '../helpers/db';

/**
 * Обмен в четыре стороны против имитаторов систем заказчика.
 *
 * Имитаторы подняты в этом же процессе на свободных портах: подпись, конверт и
 * сценарии отказов у них те же, что в контейнере стенда, а сборка образа на
 * каждый прогон стоила бы минуты. Что они отвечают, ничего не доказывает о
 * системах заказчика — доказывается другое: CRM говорит на объявленном
 * контракте, не теряет сообщений и не плодит дублей при повторах.
 */
let database: TestDatabase;
let cms: MockService;
let lms: MockService;
/** Приёмник на месте CRM: те же обработчики маршрутов, что зовёт SvelteKit. */
let crm: { url: string; stop: () => Promise<void> };
/** Ключ обмена этого теста: имитаторы представляются им, как всякая чужая система. */
let apiKey: string;

/** Секрет подписи исходящих: тот же у CRM и у имитаторов. */
const SECRET = 'stand-secret';

const intake = (await import('../../../src/routes/api/v1/applications/+server')).POST as (
	event: RequestEvent
) => Promise<Response>;

const results = (
	await import('../../../src/routes/api/v1/exchange/learning-groups/results/+server')
).POST as (event: RequestEvent) => Promise<Response>;

/** Маршруты API, которыми пользуются имитаторы. */
const ROUTES: Record<string, { id: string; handle: (event: RequestEvent) => Promise<Response> }> = {
	'/api/v1/applications': { id: '/api/v1/applications', handle: intake },
	'/api/v1/exchange/learning-groups/results': {
		id: '/api/v1/exchange/learning-groups/results',
		handle: results
	}
};

/**
 * CRM по сети.
 *
 * Имитатор обязан достучаться до настоящего обработчика тем же способом, что и
 * чужая система: заголовком `Authorization`, телом JSON и ключом
 * идемпотентности. Подделка «как будто приняли» не показала бы ни конверта, ни
 * ключа, а проверяется здесь именно это.
 */
async function startCrmFront(): Promise<{ url: string; stop: () => Promise<void> }> {
	const server = createServer((request, response) => {
		void (async () => {
			const url = new URL(request.url ?? '/', 'http://127.0.0.1');
			const route = ROUTES[url.pathname];

			if (route === undefined) {
				response.writeHead(404).end();
				return;
			}

			const chunks: Buffer[] = [];

			for await (const chunk of request) {
				chunks.push(chunk as Buffer);
			}

			const headers = new Headers();

			for (const [name, value] of Object.entries(request.headers)) {
				headers.set(name, Array.isArray(value) ? value.join(', ') : (value ?? ''));
			}

			const event = {
				request: new Request(url, {
					method: request.method ?? 'POST',
					headers,
					body: Buffer.concat(chunks).toString('utf8')
				}),
				url,
				params: {},
				route: { id: route.id },
				locals: { requestId: crypto.randomUUID(), user: null, apiKey: null },
				getClientAddress: () => '198.51.100.42',
				setHeaders: () => {},
				isDataRequest: false,
				isSubRequest: false
			} as unknown as RequestEvent;

			const answer = await route.handle(event);

			response.writeHead(answer.status, { 'content-type': 'application/json' });
			response.end(await answer.text());
		})();
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

	const { port } = server.address() as AddressInfo;

	return {
		url: `http://127.0.0.1:${port}`,
		stop: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error === undefined ? resolve() : reject(error)));
				server.closeAllConnections();
			})
	};
}

beforeAll(async () => {
	database = await startTestDatabase();
	crm = await startCrmFront();
}, 300_000);

afterAll(async () => {
	await crm?.stop();
	await getRedis().quit();
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();

	await database.db.transaction(async (tx) => {
		await ensureProcess(tx, B2B_GROUP_KEY, B2B_PROCESS);
		await ensureProcess(tx, B2C_GROUP_KEY, B2C_PROCESS);
	});

	apiKey = await serviceKey();

	// Имитаторы поднимаются на тест: ключ доступа выпускается после очистки базы,
	// а знать его сервис обязан с самого старта — как и на стенде, где ключ
	// приходит переменной окружения контейнера.
	cms = await startMockCms({
		port: 0,
		exchangeSecret: SECRET,
		crm: { baseUrl: crm.url, apiKey }
	});
	lms = await startMockLms({ port: 0, exchangeSecret: SECRET, crm: { baseUrl: crm.url, apiKey } });

	await setExchangeSettings(testActor(), {
		cmsInstance: 'itschool-site',
		cmsStatusUrl: `${cms.url}/api/applications/{externalId}/status`,
		cmsSecret: SECRET,
		cmsDefaultOwnerUserId: TEST_USER_IDS.manager,
		lmsInstance: 'moodle-itschool',
		lmsGroupsUrl: `${lms.url}/api/groups`,
		lmsSecret: SECRET
	});
});

afterEach(async () => {
	await cms?.stop();
	await lms?.stop();
});

/** Действующее лицо ключа обмена: роль `service` и ничего сверх её прав. */
const serviceActor = () => testActor({ roleId: 'service' });

function envelope(data: Record<string, unknown>, options: { eventId?: string } = {}) {
	return {
		schemaVersion: '1.0',
		eventId: options.eventId ?? crypto.randomUUID(),
		eventType: 'application.submitted',
		occurredAt: new Date().toISOString(),
		source: { system: 'cms', instance: 'itschool-site' },
		data
	};
}

const B2B_DATA = {
	externalId: 'site-2026-000123',
	revision: 1,
	form: 'b2b',
	applicant: {
		kind: 'educational_institution',
		name: 'Северо-Западный политехнический университет',
		inn: '7802450127',
		educationLevel: 'vo'
	},
	contact: {
		lastName: 'Кузьмина',
		firstName: 'Наталья',
		email: 'kuzmina@szpu.example.org',
		phone: '+7 900 000-00-11',
		position: 'Проректор по цифровому развитию'
	},
	interest: 'Программа подготовки по прикладной информатике'
};

const B2C_DATA = {
	externalId: 'site-2026-000124',
	revision: 1,
	form: 'b2c',
	applicant: { kind: 'individual', lastName: 'Ветров', firstName: 'Илья' },
	contact: {
		lastName: 'Ветров',
		firstName: 'Илья',
		email: 'vetrov@example.org',
		phone: '+7 900 000-00-22'
	},
	consent: { given: true, at: '2026-09-16T09:40:55Z', policyVersion: '2026-01' }
};

/** Сообщение через настоящий `apiHandler` — ту же обёртку, что зовёт SvelteKit. */
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
		request: new Request(url, { method: 'POST', headers, body: JSON.stringify(options.body) }),
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

async function serviceKey(): Promise<string> {
	const created = await createApiKey(testActor(), {
		name: 'Ключ CMS стенда',
		ownerUserId: TEST_USER_IDS.service
	});

	return created.key;
}

/** Состояние имитатора: всё, что он принял и отправил. */
async function mockState(service: MockService): Promise<{
	objects: {
		applications?: { externalId: string; statuses: { data: Record<string, unknown> }[] }[];
	};
	journal: { direction: string; status: number | null; note: string | null }[];
}> {
	const response = await fetch(`${service.url}/__state`);

	return (await response.json()) as never;
}

/** Срок повтора сдвигается на «сейчас»: расписание проверяется отдельно. */
async function makeDue(): Promise<void> {
	await database.db
		.update(exchangeMessages)
		.set({ nextAttemptAt: sql`now()` })
		.where(eq(exchangeMessages.direction, 'outbound'));
}

describe('приём заявки с сайта', () => {
	it('заводит взаимодействие, назначение и строку журнала обмена одной транзакцией', async () => {
		const response = await intake(apiEvent({ body: envelope(B2B_DATA), key: apiKey }));
		const body = (await response.json()) as {
			result: string;
			data: { interactionId: string; organizationId: string; processGroup: string };
		};

		expect(response.status).toBe(200);
		expect(body.result).toBe('created');
		expect(body.data.processGroup).toBe('b2b');

		const [interaction] = await database.db
			.select()
			.from(interactions)
			.where(eq(interactions.id, body.data.interactionId));

		// Внешняя ссылка несёт систему и экземпляр: та же строка с боевого сайта —
		// это другая заявка, и склеивать их нельзя.
		expect(interaction).toMatchObject({
			externalSource: 'cms:itschool-site',
			externalId: 'site-2026-000123',
			externalRevision: 1,
			ownerUserId: TEST_USER_IDS.manager
		});

		// Ответственным стал сотрудник из настройки, а не владелец ключа: у ключа
		// владелец машинный, и заявка досталась бы записи, которая не работает.
		const responsibles = await database.db
			.select({ userId: organizationResponsibles.userId })
			.from(organizationResponsibles)
			.where(eq(organizationResponsibles.organizationId, body.data.organizationId));

		expect(responsibles).toEqual([{ userId: TEST_USER_IDS.manager }]);

		const messages = await database.db.select().from(exchangeMessages);

		expect(messages.filter((row) => row.direction === 'inbound')).toMatchObject([
			{ system: 'cms', state: 'processed', externalId: 'site-2026-000123' }
		]);
		// Снимок статуса встал в очередь в той же транзакции (outbox).
		expect(messages.filter((row) => row.direction === 'outbound')).toMatchObject([
			{ eventType: 'application.status', state: 'pending' }
		]);
	});

	it('заводит физлицо парой «человек + организация» и записывает согласие', async () => {
		const response = await intake(apiEvent({ body: envelope(B2C_DATA), key: apiKey }));
		const body = (await response.json()) as {
			result: string;
			data: { organizationId: string; processGroup: string };
		};

		expect(body.result).toBe('created');
		expect(body.data.processGroup).toBe('b2c');

		const [organization] = await database.db
			.select()
			.from(organizations)
			.where(eq(organizations.id, body.data.organizationId));

		expect(organization.kind).toBe('individual');
		expect(organization.personId).not.toBeNull();

		// ФИО и контакты живут в `people`: там работают маскирование, срок
		// хранения и обезличивание. Копии ФИО в полях организации не появляется.
		const [person] = await database.db
			.select()
			.from(people)
			.where(eq(people.id, organization.personId!));

		expect(person).toMatchObject({ lastName: 'Ветров', email: 'vetrov@example.org' });

		const recorded = await database.db
			.select({ textVersion: consents.textVersion })
			.from(consents)
			.where(eq(consents.personId, organization.personId!));

		expect(recorded).toEqual([{ textVersion: '2026-01' }]);
	});

	it('обновляет заявку полным снимком и приписывает комментарий, а не затирает', async () => {
		const key = apiKey;

		await intake(apiEvent({ body: envelope(B2B_DATA), key }));

		const second = await intake(
			apiEvent({
				body: envelope({
					...B2B_DATA,
					revision: 2,
					comment: 'Просим перенести встречу на октябрь.'
				}),
				key
			})
		);
		const body = (await second.json()) as { result: string; data: { interactionId: string } };

		expect(body.result).toBe('updated');

		const rows = await database.db.select({ id: interactions.id }).from(interactions);

		// Обновляет существующее взаимодействие только повтор с тем же ключом — то
		// есть та же самая заявка.
		expect(rows).toHaveLength(1);

		const written = await database.db
			.select({ body: comments.body })
			.from(comments)
			.where(eq(comments.interactionId, body.data.interactionId));

		expect(written).toHaveLength(2);
		expect(written.map((row) => row.body).join(' ')).toContain('октябрь');
	});

	it('не применяет сообщение с ревизией не больше применённой', async () => {
		const key = apiKey;

		await intake(apiEvent({ body: envelope({ ...B2B_DATA, revision: 5 }), key }));

		const stale = await intake(apiEvent({ body: envelope({ ...B2B_DATA, revision: 5 }), key }));
		const body = (await stale.json()) as { result: string };

		expect(stale.status).toBe(200);
		expect(body.result).toBe('unchanged');

		const messages = await database.db
			.select({ state: exchangeMessages.state })
			.from(exchangeMessages)
			.where(eq(exchangeMessages.direction, 'inbound'));

		expect(messages.map((row) => row.state).sort()).toEqual(['ignored_stale', 'processed']);
	});

	it('повтор того же события отдаёт сохранённый ответ и ничего не применяет заново', async () => {
		const key = apiKey;
		const eventId = crypto.randomUUID();
		const message = envelope({ ...B2B_DATA, revision: 2 }, { eventId });

		const first = (await (await intake(apiEvent({ body: message, key }))).json()) as {
			result: string;
			data: { interactionId: string };
		};
		const second = (await (await intake(apiEvent({ body: message, key }))).json()) as {
			result: string;
			data: { interactionId: string };
		};

		expect(first.result).toBe('created');
		expect(second.result).toBe('unchanged');
		expect(second.data.interactionId).toBe(first.data.interactionId);

		// Второй строки журнала обмена нет: её не даёт завести уникальность
		// `(направление, система, экземпляр, eventId)`.
		const inbound = await database.db
			.select({ id: exchangeMessages.id })
			.from(exchangeMessages)
			.where(eq(exchangeMessages.direction, 'inbound'));

		expect(inbound).toHaveLength(1);

		// И комментарий один: повтор ничего не применяет заново.
		const written = await database.db.select({ id: comments.id }).from(comments);

		expect(written).toHaveLength(1);
	});

	it('тот же eventId с другим телом отвергается', async () => {
		const key = apiKey;
		const eventId = crypto.randomUUID();

		await intake(apiEvent({ body: envelope(B2B_DATA, { eventId }), key }));

		const response = await intake(
			apiEvent({ body: envelope({ ...B2B_DATA, revision: 9 }, { eventId }), key })
		);

		expect(response.status).toBe(409);
		expect((await response.json()) as { error: { code: string } }).toMatchObject({
			error: { code: 'conflict' }
		});
	});

	it('сверяет форму заявки с видом заявителя', async () => {
		const response = await intake(
			apiEvent({ body: envelope({ ...B2B_DATA, form: 'b2c' }), key: apiKey })
		);

		expect(response.status).toBe(400);
		expect(JSON.stringify(await response.json())).toContain('b2b');
	});

	it('не принимает сообщение чужого экземпляра', async () => {
		const message = {
			...envelope(B2B_DATA),
			source: { system: 'cms', instance: 'другая-площадка' }
		};

		const response = await intake(apiEvent({ body: message, key: apiKey }));

		// Экземпляр определяется подключением, а не полем из тела: иначе
		// отправитель переписал бы себе чужой экземпляр одной строкой в JSON.
		expect(response.status).toBe(403);

		const messages = await database.db.select({ id: exchangeMessages.id }).from(exchangeMessages);

		expect(messages).toHaveLength(0);
	});

	it('отказывает, когда ответственный за входящие не настроен', async () => {
		await setExchangeSettings(testActor(), {
			cmsInstance: 'itschool-site',
			cmsStatusUrl: '',
			cmsSecret: null,
			cmsDefaultOwnerUserId: null,
			lmsInstance: 'moodle-itschool',
			lmsGroupsUrl: '',
			lmsSecret: null
		});

		const response = await intake(apiEvent({ body: envelope(B2B_DATA), key: apiKey }));

		// Тихо назначить робота хуже, чем отказать: у взаимодействия без живого
		// ответственного нет ни срока, ни того, кто за него отвечает.
		expect(response.status).toBe(400);
		expect(JSON.stringify(await response.json())).toContain('Ответственный за входящие');

		expect(await database.db.select({ id: interactions.id }).from(interactions)).toHaveLength(0);
		expect(
			await database.db.select({ id: exchangeMessages.id }).from(exchangeMessages)
		).toHaveLength(0);
	});
});

describe('снимок статуса заявки', () => {
	/** «На сайте заполнили форму»: заявка едет в CRM по сети, как со стенда. */
	async function acceptApplication(): Promise<string> {
		const response = await fetch(`${cms.url}/__send-application`, {
			method: 'POST',
			body: JSON.stringify({ form: 'b2b' })
		});

		const sent = (await response.json()) as {
			crm: { status: number; body: { data: { interactionId: string } } };
		};

		expect(sent.crm.status).toBe(200);

		return sent.crm.body.data.interactionId;
	}

	it('доходит до CMS подписанным и в конверте контракта', async () => {
		await acceptApplication();

		const report = await runExchangeCycle(testActor());

		expect(report.sent).toBe(1);

		const state = await mockState(cms);
		const [application] = state.objects.applications ?? [];

		// Имитатор принял сообщение только потому, что сошлась подпись: правило
		// одно на вебхуки и на обмен, и проверяет он его своим кодом.
		expect(application.statuses).toHaveLength(1);
		expect(application.statuses[0].data).toMatchObject({
			externalId: 'site-2026-000123',
			applicationStatus: 'received'
		});

		const [message] = await database.db
			.select()
			.from(exchangeMessages)
			.where(eq(exchangeMessages.direction, 'outbound'));

		expect(message).toMatchObject({ state: 'sent', responseStatus: 200 });
	});

	it('появляется в той же транзакции, что и переход по стадии', async () => {
		const interactionId = await acceptApplication();
		await runExchangeCycle(testActor());

		const [entry] = await database.db
			.select()
			.from(stageEntries)
			.where(eq(stageEntries.interactionId, interactionId));

		// Переход с несуществующей редакцией отклоняется до единой записи —
		// и сообщения обмена после него тоже не остаётся.
		await expect(
			advanceStage(testActor(), {
				interactionId,
				fromStageId: entry.stageId,
				toStageId: entry.stageId,
				revision: 99,
				reason: null,
				resultText: null,
				checklistState: {}
			})
		).rejects.toMatchObject({ code: 'conflict' });

		const outbound = await database.db
			.select({ id: exchangeMessages.id })
			.from(exchangeMessages)
			.where(eq(exchangeMessages.direction, 'outbound'));

		expect(outbound).toHaveLength(1);
	});

	it('не переживает отката транзакции: сообщение и доменное изменение вместе', async () => {
		const interactionId = await acceptApplication();

		await expect(
			withTransaction(testActor(), async (tx) => {
				await enqueueApplicationStatus(tx, interactionId);

				// Доменная операция не удалась — и уведомления о ней не остаётся.
				// Порядок «отправить, потом записать» терял бы уведомление при
				// падении процесса, а «записать после коммита» — при падении сразу
				// после коммита; здесь строка живёт и умирает вместе с транзакцией.
				throw new Error('доменная операция не удалась');
			})
		).rejects.toThrow('доменная операция не удалась');

		const outbound = await database.db
			.select({ id: exchangeMessages.id })
			.from(exchangeMessages)
			.where(eq(exchangeMessages.direction, 'outbound'));

		// Осталось ровно то сообщение, которое поставил приём заявки.
		expect(outbound).toHaveLength(1);
	});

	it('повторяет временный отказ и доходит без дубля', async () => {
		await acceptApplication();

		// Два ближайших обращения к эндпоинтам контракта имитатор испортит 503.
		await fetch(`${cms.url}/__scenario`, {
			method: 'POST',
			body: JSON.stringify({ failNext: 2, status: 503 })
		});

		const first = await runExchangeCycle(testActor());
		expect(first.retried).toBe(1);

		await makeDue();
		const second = await runExchangeCycle(testActor());
		expect(second.retried).toBe(1);

		await makeDue();
		const third = await runExchangeCycle(testActor());
		expect(third.sent).toBe(1);

		const [message] = await database.db
			.select()
			.from(exchangeMessages)
			.where(eq(exchangeMessages.direction, 'outbound'));

		expect(message).toMatchObject({ state: 'sent', attempt: 3 });

		// Карточка заявки на сайте получила ровно один статус: повтор не создаёт
		// дубля, потому что получатель узнаёт сообщение по `eventId`.
		const state = await mockState(cms);

		expect(state.objects.applications?.[0].statuses).toHaveLength(1);
	});

	it('не повторяет отказ 4xx: тело не станет другим само по себе', async () => {
		await acceptApplication();

		await fetch(`${cms.url}/__scenario`, {
			method: 'POST',
			body: JSON.stringify({ failNext: 1, status: 400 })
		});

		const report = await runExchangeCycle(testActor());

		expect(report.failed).toBe(1);

		const [message] = await database.db
			.select()
			.from(exchangeMessages)
			.where(eq(exchangeMessages.direction, 'outbound'));

		expect(message).toMatchObject({ state: 'failed', attempt: 1, responseStatus: 400 });
		expect(message.closedAt).not.toBeNull();

		const journal = await database.db
			.select({ type: auditEvents.eventType })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'exchange.message_failed'));

		expect(journal).toHaveLength(1);
	});
});

describe('учебная группа', () => {
	async function interactionWithGroup(): Promise<{
		interactionId: string;
		groupExternalId: string;
	}> {
		const response = await intake(apiEvent({ body: envelope(B2B_DATA), key: apiKey }));
		const { data } = (await response.json()) as { data: { interactionId: string } };

		await requestLearningGroup(testActor(), {
			interactionId: data.interactionId,
			streamNumber: 1,
			plannedSeats: 45,
			startsOn: '2026-10-01',
			endsOn: '2027-05-31'
		});

		const [group] = await listLearningGroups(testActor(), data.interactionId);

		expect(group.groupExternalId).not.toBeNull();

		return { interactionId: data.interactionId, groupExternalId: group.groupExternalId! };
	}

	it('заводится действием сотрудника и получает имя в системе обучения', async () => {
		const { interactionId, groupExternalId } = await interactionWithGroup();

		const [message] = await database.db
			.select()
			.from(exchangeMessages)
			.where(
				and(
					eq(exchangeMessages.direction, 'outbound'),
					eq(exchangeMessages.eventType, 'learning_group.requested')
				)
			);

		expect(message).toMatchObject({ state: 'sent', interactionId });
		expect(message.externalId).toBe(`crm-group-${interactionId}-1`);
		expect(groupExternalId).toMatch(/^\d+$/);
	});

	it('второй раз тот же поток не заводит', async () => {
		const { interactionId } = await interactionWithGroup();

		await expect(
			requestLearningGroup(testActor(), {
				interactionId,
				streamNumber: 1,
				plannedSeats: 45,
				startsOn: null,
				endsOn: null
			})
		).rejects.toMatchObject({ code: 'conflict' });
	});

	it('не отправляется без права: это действие сотрудника, а не машины', async () => {
		const response = await intake(apiEvent({ body: envelope(B2B_DATA), key: apiKey }));
		const { data } = (await response.json()) as { data: { interactionId: string } };

		await expect(
			requestLearningGroup(testActor({ roleId: 'service' }), {
				interactionId: data.interactionId,
				streamNumber: 1,
				plannedSeats: 10,
				startsOn: null,
				endsOn: null
			})
		).rejects.toMatchObject({ code: 'forbidden' });
	});

	it('результат подтверждает стадию фактами и никуда её не двигает', async () => {
		const { interactionId, groupExternalId } = await interactionWithGroup();

		// Стадии, которой нужны данные обучения, в демонстрационном процессе нет:
		// признак включают черновиком. Здесь он поднимается прямо в слепке
		// открытой записи — движок читает именно его.
		const [entry] = await database.db
			.select()
			.from(stageEntries)
			.where(eq(stageEntries.interactionId, interactionId));

		await database.db
			.update(stageEntries)
			.set({
				stageSnapshot: { ...entry.stageSnapshot, requiresLmsData: true, requiresConfirmation: true }
			})
			.where(eq(stageEntries.id, entry.id));

		const result = await receiveLearningGroupResult(serviceActor(), {
			schemaVersion: '1.0',
			eventId: crypto.randomUUID(),
			eventType: 'learning_group.result',
			occurredAt: '2027-05-21T06:00:00Z',
			source: { system: 'lms', instance: 'moodle-itschool' },
			data: {
				groupExternalId,
				requestExternalId: `crm-group-${interactionId}-1`,
				period: { start: '2026-10-01', end: '2027-05-31' },
				finishedOn: '2027-05-20',
				counters: { enrolled: 45, completed: 38, expelled: 4 },
				report: null
			}
		});

		expect(result.result).toBe('created');
		expect(result.data.stageConfirmed).toBe(true);

		const [saved] = await database.db.select().from(learningGroupResults);

		expect(saved).toMatchObject({ enrolled: 45, completed: 38, expelled: 4 });

		const [updated] = await database.db
			.select()
			.from(stageEntries)
			.where(eq(stageEntries.id, entry.id));

		expect(updated.lmsEvidence).toMatchObject({ groupExternalId, completed: 38 });
		expect(updated.confirmation).toMatchObject({ kind: 'lms_record', recordId: groupExternalId });

		// Дальше взаимодействие не двигается ни на шаг: переход — решение
		// сотрудника, и права `stages.transition` у машинного субъекта нет.
		expect(updated.leftAt).toBeNull();
		expect(await database.db.select({ id: stageEntries.id }).from(stageEntries)).toHaveLength(1);
	});

	it('второй результат добавляет строку истории, а не перезаписывает', async () => {
		const { interactionId, groupExternalId } = await interactionWithGroup();

		const send = (occurredAt: string, completed: number) =>
			receiveLearningGroupResult(serviceActor(), {
				schemaVersion: '1.0',
				eventId: crypto.randomUUID(),
				eventType: 'learning_group.result',
				occurredAt,
				source: { system: 'lms', instance: 'moodle-itschool' },
				data: {
					groupExternalId,
					requestExternalId: `crm-group-${interactionId}-1`,
					period: null,
					finishedOn: null,
					counters: { enrolled: 45, completed, expelled: 0 },
					report: null
				}
			});

		await send('2027-01-10T06:00:00Z', 10);
		await send('2027-05-21T06:00:00Z', 38);

		const history = await database.db
			.select({ completed: learningGroupResults.completed })
			.from(learningGroupResults);

		expect(history.map((row) => row.completed).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
			10, 38
		]);

		const [group] = await database.db.select().from(learningGroups);

		expect(group.lastResultAt?.toISOString()).toBe('2027-05-21T06:00:00.000Z');

		// Результат старше сохранённого не применяется.
		const stale = await send('2026-12-01T06:00:00Z', 1);

		expect(stale.result).toBe('unchanged');
		expect(
			await database.db.select({ id: learningGroupResults.id }).from(learningGroupResults)
		).toHaveLength(2);
	});

	it('не принимает результат неизвестной группы', async () => {
		await expect(
			receiveLearningGroupResult(serviceActor(), {
				schemaVersion: '1.0',
				eventId: crypto.randomUUID(),
				eventType: 'learning_group.result',
				occurredAt: '2027-05-21T06:00:00Z',
				source: { system: 'lms', instance: 'moodle-itschool' },
				data: {
					groupExternalId: '9999',
					requestExternalId: null,
					period: null,
					finishedOn: null,
					counters: { enrolled: 1, completed: 1, expelled: 0 },
					report: null
				}
			})
		).rejects.toMatchObject({ code: 'not_found' });
	});
});

describe('вложение обмена', () => {
	it('отдаётся по своему взаимодействию и не находится по чужому', async () => {
		const response = await intake(apiEvent({ body: envelope(B2B_DATA), key: apiKey }));
		const { data } = (await response.json()) as { data: { interactionId: string } };

		const ownId = await insertDocument(database.db, { interactionId: data.interactionId });
		const [own] = await database.db
			.select({ filePath: documents.filePath })
			.from(documents)
			.where(eq(documents.id, ownId));

		const file = await readExchangeFile(serviceActor(), own.filePath);

		expect(file.documentId).toBe(ownId);

		// Чужой ключ объекта — `404`, а не `403`: перебором ключей нельзя узнать,
		// что у нас лежит.
		const organizationId = await insertOrganization(database.db, { inn: null });
		const [stranger] = await database.db
			.insert(interactions)
			.values({
				title: 'Заведено руками',
				processGroupId: (
					await database.db
						.select({ id: interactions.processGroupId })
						.from(interactions)
						.where(eq(interactions.id, data.interactionId))
				)[0].id,
				ownerUserId: TEST_USER_IDS.manager
			})
			.returning({ id: interactions.id });

		expect(organizationId).toBeTruthy();

		const strangeId = await insertDocument(database.db, { interactionId: stranger.id });
		const [strange] = await database.db
			.select({ filePath: documents.filePath })
			.from(documents)
			.where(eq(documents.id, strangeId));

		await expect(readExchangeFile(serviceActor(), strange.filePath)).rejects.toMatchObject({
			code: 'not_found'
		});
	});
});
