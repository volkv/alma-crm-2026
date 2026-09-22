// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
import { vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApiKey } from '$lib/server/api/keys';
import { MAX_REVISION_STEP } from '$lib/contracts/exchange';
import {
	affiliations,
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
	stageEntries,
	users
} from '$lib/server/db/schema';
import { runExchangeCycle } from '$lib/server/integrations/exchange/delivery';
import { retryExchangeMessage } from '$lib/server/integrations/exchange/messages';
import { readExchangeFile } from '$lib/server/integrations/exchange/files';
import { listLearningGroups, requestLearningGroup } from '$lib/server/integrations/exchange/groups';
import { enqueueApplicationStatus } from '$lib/server/integrations/exchange/outbox';
import { receiveLearningGroupResult } from '$lib/server/integrations/exchange/results';
import { setExchangeSettings } from '$lib/server/integrations/settings';
import { decryptContacts } from '$lib/server/people/pii';
import { withTransaction } from '$lib/server/db/transaction';
import { getRedis } from '$lib/server/redis';
import { advanceStage } from '$lib/server/stages/commands';
import {
	B2B_WORKSPACE_KEY,
	B2B_PROCESS,
	B2C_WORKSPACE_KEY,
	B2C_PROCESS
} from '$lib/server/stages/definitions';
import { ensureWorkflow } from '$lib/server/stages/process';
import { advanceTo } from '../stages/fixture';
import { startMockCms } from '../../../mocks/mock-cms/service.ts';
import { startMockLms } from '../../../mocks/mock-lms/service.ts';
import type { MockService } from '../../../mocks/shared/http.ts';
import { anonymizePerson } from '$lib/server/people/retention';
import {
	insertDocument,
	insertOrganization,
	insertUser,
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
/** Ключ системы обучения: направления у ключей разные, и это проверяется. */
let lmsApiKey: string;

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
		await ensureWorkflow(tx, B2B_WORKSPACE_KEY, B2B_PROCESS);
		await ensureWorkflow(tx, B2C_WORKSPACE_KEY, B2C_PROCESS);
	});

	apiKey = await serviceKey('cms');
	lmsApiKey = await serviceKey('lms');

	// Имитаторы поднимаются на тест: ключ доступа выпускается после очистки базы,
	// а знать его сервис обязан с самого старта — как и на стенде, где ключ
	// приходит переменной окружения контейнера.
	cms = await startMockCms({
		port: 0,
		exchangeSecret: SECRET,
		crm: { baseUrl: crm.url, apiKey }
	});
	lms = await startMockLms({
		port: 0,
		exchangeSecret: SECRET,
		crm: { baseUrl: crm.url, apiKey: lmsApiKey }
	});

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
		name: 'Московский технический университет связи и информатики',
		inn: '0000000096',
		educationLevel: 'vo'
	},
	contact: {
		lastName: 'Кузьмина',
		firstName: 'Наталья',
		email: 'kuzmina@mtuci.example.org',
		phone: '+7 900 000-00-11',
		position: 'Проректор по цифровому развитию'
	},
	interest: 'Программа подготовки DevOps-инженеров'
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
function apiEvent(options: {
	body: unknown;
	key: string;
	idempotencyKey?: string;
	/** Маршрут: по умолчанию приём заявки. */
	route?: string;
}): RequestEvent {
	const path = options.route ?? '/api/v1/applications';
	const url = new URL(`http://localhost${path}`);
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
		route: { id: path },
		locals: { requestId: crypto.randomUUID(), user: null, apiKey: null },
		getClientAddress: () => '198.51.100.42',
		setHeaders: () => {},
		isDataRequest: false,
		isSubRequest: false
	} as unknown as RequestEvent;
}

async function serviceKey(system: 'cms' | 'lms' = 'cms'): Promise<string> {
	const created = await createApiKey(testActor(), {
		name: `Ключ ${system.toUpperCase()} стенда`,
		ownerUserId: TEST_USER_IDS.service,
		exchangeSystem: system
	});

	return created.key;
}

/** Подключение, от имени которого работает ключ стенда. */
const CMS_BINDING = { system: 'cms', instance: 'itschool-site' } as const;

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

		// Контакты лежат шифртекстом: их читает только ключ установки.
		expect(person.lastName).toBe('Ветров');
		expect(person.email).not.toContain('vetrov');
		expect(decryptContacts(person).email).toBe('vetrov@example.org');

		const recorded = await database.db
			.select({ textVersion: consents.textVersion })
			.from(consents)
			.where(eq(consents.personId, organization.personId!));

		expect(recorded).toEqual([{ textVersion: '2026-01' }]);
	});

	it('контактным лицом физлица становится он сам, а не вторая запись справочника', async () => {
		const key = apiKey;

		const first = await intake(apiEvent({ body: envelope(B2C_DATA), key }));
		const created = (await first.json()) as {
			data: { organizationId: string; contactPersonId: string };
		};

		const [organization] = await database.db
			.select({ personId: organizations.personId })
			.from(organizations)
			.where(eq(organizations.id, created.data.organizationId));

		// Контрагент и контактное лицо — одна строка `people`: у второй записи с
		// тем же ФИО, той же почтой и тем же телефоном свой срок хранения и своё
		// обезличивание, и уничтожение по одной оставляло бы копию в другой.
		expect(created.data.contactPersonId).toBe(organization.personId);

		// Вторая заявка того же человека: ключ заявки другой, адрес почты тот же.
		const second = await intake(
			apiEvent({ body: envelope({ ...B2C_DATA, externalId: 'site-2026-000199' }), key })
		);

		expect(((await second.json()) as { result: string }).result).toBe('created');

		expect(await database.db.select({ id: people.id }).from(people)).toHaveLength(1);

		// И роль в своей организации у него одна: повтор не плодит ни людей, ни
		// ролей.
		const roles = await database.db
			.select({ personId: affiliations.personId })
			.from(affiliations)
			.where(eq(affiliations.organizationId, created.data.organizationId));

		expect(roles).toEqual([{ personId: organization.personId }]);
	});

	it('у заявки организации контактное лицо остаётся отдельным человеком', async () => {
		const response = await intake(apiEvent({ body: envelope(B2B_DATA), key: apiKey }));
		const body = (await response.json()) as {
			data: { organizationId: string; contactPersonId: string };
		};

		const [organization] = await database.db
			.select({ personId: organizations.personId })
			.from(organizations)
			.where(eq(organizations.id, body.data.organizationId));

		// У вуза человека-контрагента нет вовсе, и контактное лицо — его
		// сотрудник: правило физлица на заявку организации не распространяется.
		expect(organization.personId).toBeNull();

		const rows = await database.db.select({ id: people.id }).from(people);

		expect(rows).toEqual([{ id: body.data.contactPersonId }]);
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

	it('отвергает ревизию, ушедшую вперёд дальше допустимого шага', async () => {
		const key = apiKey;

		await intake(apiEvent({ body: envelope({ ...B2B_DATA, revision: 5 }), key }));

		const jumped = await intake(
			apiEvent({ body: envelope({ ...B2B_DATA, revision: 5 + MAX_REVISION_STEP + 1 }), key })
		);

		expect(jumped.status).toBe(400);
		expect(JSON.stringify(await jumped.json())).toContain('Ревизия заявки');

		const [interaction] = await database.db
			.select({ externalRevision: interactions.externalRevision })
			.from(interactions);

		// Заявка осталась на применённой ревизии: сообщение со скачком её не
		// заморозило, и законные обновления по ней по-прежнему проходят.
		expect(interaction.externalRevision).toBe(5);

		// Отказ виден не только отправителю: на экране «Внешние системы» стоит
		// строка с причиной словами.
		const refused = await database.db
			.select({ lastError: exchangeMessages.lastError })
			.from(exchangeMessages)
			.where(eq(exchangeMessages.state, 'failed'));

		expect(refused).toHaveLength(1);
		expect(refused[0].lastError).toContain('Ревизия заявки');

		// Шаг ровно в порог — рабочий случай: столько сообщений отправитель мог
		// потерять, пока связь не работала.
		const applied = await intake(
			apiEvent({ body: envelope({ ...B2B_DATA, revision: 5 + MAX_REVISION_STEP }), key })
		);

		expect(((await applied.json()) as { result: string }).result).toBe('updated');
	});

	it('отвергает скачок и в первом сообщении по заявке', async () => {
		const response = await intake(
			apiEvent({ body: envelope({ ...B2B_DATA, revision: MAX_REVISION_STEP + 1 }), key: apiKey })
		);

		// Применённой ревизии у незнакомой заявки нет, и считается она нулём:
		// иначе заявку выключало бы первое же сообщение по ней.
		expect(response.status).toBe(400);
		expect(await database.db.select({ id: interactions.id }).from(interactions)).toHaveLength(0);
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

		// Транзакция приёма откатилась целиком, но след сообщения остался: иначе
		// на экране «Внешние системы» не было бы ничего, и разбирать было бы
		// нечего — отправитель видел бы отказ, а мы не видели бы даже попытки.
		const [refused] = await database.db.select().from(exchangeMessages);

		expect(refused).toMatchObject({
			direction: 'inbound',
			state: 'failed',
			externalId: 'site-2026-000123'
		});
		expect(refused.lastError).toContain('Ответственный за входящие заявки не настроен');
	});

	it('вне демонстрационного режима демонстрационная запись входящие не принимает', async () => {
		await database.db.insert(users).values({
			email: 'demo-manager@example.org',
			fullName: 'Демонстрационный Менеджер',
			roleId: 'manager',
			isDemo: true
		});

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

		// Запасной ответственный — свойство демонстрационного стенда, а не базы, в
		// которой когда-то запускали сид: при выключенном `DEMO_MODE` отметка
		// `is_demo` не значит ничего (`db/schema/auth.ts`), и заявка отвергается с
		// указанием, что настроить.
		expect(response.status).toBe(400);
		expect(JSON.stringify(await response.json())).toContain('Ответственный за входящие');

		expect(await database.db.select({ id: interactions.id }).from(interactions)).toHaveLength(0);
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

		// Данных обучения в процессе учебных заведений требует «Ведение
		// занятий», и взаимодействие доводится до неё движком: поднять признак
		// в слепке открытой записи значило бы проверять выдуманную стадию.
		await advanceTo(testActor(), database, interactionId, 'classes');

		const [entry] = await database.db
			.select()
			.from(stageEntries)
			.where(and(eq(stageEntries.interactionId, interactionId), isNull(stageEntries.leftAt)));

		expect(entry.stageSnapshot.requiresLmsData).toBe(true);

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

		const open = await database.db
			.select({ id: stageEntries.id })
			.from(stageEntries)
			.where(and(eq(stageEntries.interactionId, interactionId), isNull(stageEntries.leftAt)));

		expect(open).toHaveLength(1);
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

		const file = await readExchangeFile(serviceActor(), own.filePath, CMS_BINDING);

		expect(file.documentId).toBe(ownId);

		// Чужой ключ объекта — `404`, а не `403`: перебором ключей нельзя узнать,
		// что у нас лежит.
		const organizationId = await insertOrganization(database.db, { inn: null });
		const [stranger] = await database.db
			.insert(interactions)
			.values({
				title: 'Заведено руками',
				workspaceId: (
					await database.db
						.select({ id: interactions.workspaceId })
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

		await expect(
			readExchangeFile(serviceActor(), strange.filePath, CMS_BINDING)
		).rejects.toMatchObject({
			code: 'not_found'
		});
	});
});

/**
 * Приёмник на свободном порту: отвечает тем, что скажет тест, и запоминает
 * каждое тело, которое до него дошло.
 *
 * Имитатор стенда для этого не годится: он проверяет контракт, а здесь
 * проверяется другое — что уходит по сети при повторе и что делает CRM с
 * ответом не по контракту.
 */
async function startReceiver(
	reply: (body: string, attempt: number) => { status: number; body: string }
): Promise<{ url: string; bodies: string[]; stop: () => Promise<void> }> {
	const bodies: string[] = [];

	const server = createServer((request, response) => {
		void (async () => {
			const chunks: Buffer[] = [];

			for await (const chunk of request) {
				chunks.push(chunk as Buffer);
			}

			const body = Buffer.concat(chunks).toString('utf8');
			bodies.push(body);

			const answer = reply(body, bodies.length);

			response.writeHead(answer.status, { 'content-type': 'application/json' });
			response.end(answer.body);
		})();
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

	const { port } = server.address() as AddressInfo;

	return {
		url: `http://127.0.0.1:${port}/api/groups`,
		bodies,
		stop: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error === undefined ? resolve() : reject(error)));
				server.closeAllConnections();
			})
	};
}

/** Настройки обмена, у которых заявка на группу уходит на этот приёмник. */
async function pointGroupsAt(url: string): Promise<void> {
	await setExchangeSettings(testActor(), {
		cmsInstance: 'itschool-site',
		cmsStatusUrl: `${cms.url}/api/applications/{externalId}/status`,
		cmsSecret: SECRET,
		cmsDefaultOwnerUserId: TEST_USER_IDS.manager,
		lmsInstance: 'moodle-itschool',
		lmsGroupsUrl: url,
		lmsSecret: SECRET
	});
}

/** Заявка с сайта, из которой дальше заводится учебная группа. */
async function acceptedInteraction(): Promise<string> {
	const response = await intake(apiEvent({ body: envelope(B2B_DATA), key: apiKey }));
	const { data } = (await response.json()) as { data: { interactionId: string } };

	return data.interactionId;
}

const GROUP_REPLY = JSON.stringify({ data: { groupExternalId: 'lms-group-1' } });

describe('конверт исходящего сообщения', () => {
	it('после временного отказа повтор уносит то же тело байт в байт', async () => {
		// Повтор — это то же самое сообщение, а не новое: `eventId` при повторе
		// тот же, и получатель, который сверяет повтор с принятым (а CRM на
		// входящих делает ровно это), вправе отвергнуть другое тело как подмену.
		const receiver = await startReceiver((_body, attempt) =>
			attempt === 1 ? { status: 503, body: '{}' } : { status: 200, body: GROUP_REPLY }
		);

		try {
			await pointGroupsAt(receiver.url);

			const interactionId = await acceptedInteraction();

			// Приём заявки поставил в очередь и снимок её статуса, а круг доставки
			// один на всех. Сцена здесь про конверт заявки на группу, поэтому статус
			// в этом кругу отвергается — управляемым сценарием имитатора и только по
			// ключу этой заявки, чтобы отказ не задел ничего другого.
			await fetch(`${cms.url}/__scenario`, {
				method: 'POST',
				body: JSON.stringify({ failNext: 5, status: 503, match: B2B_DATA.externalId })
			});

			const outcome = await requestLearningGroup(testActor(), {
				interactionId,
				streamNumber: 1,
				plannedSeats: 45,
				startsOn: '2026-10-01',
				endsOn: '2027-05-31'
			});

			expect(outcome.delivered).toBe(false);

			await makeDue();
			const report = await runExchangeCycle(testActor());

			// Ушло ровно одно сообщение — заявка на группу: статус остался в очереди
			// повторов по сценарию.
			expect(report.sent).toBe(1);
			expect(receiver.bodies).toHaveLength(2);
			expect(receiver.bodies[1]).toBe(receiver.bodies[0]);

			const [message] = await database.db
				.select()
				.from(exchangeMessages)
				.where(eq(exchangeMessages.eventType, 'learning_group.requested'));

			expect(message.state).toBe('sent');
			// Семя осталось семенем: из него собирают тело, и затирать его телом
			// значит лишить вторую попытку того, из чего собирать.
			expect(message.payload).toMatchObject({ interactionId, streamNumber: 1 });
			// Конверт лежит строкой: повтор обязан уйти байт в байт, а разобранное
			// значение порядка полей не хранит.
			expect(message.envelope).toBe(receiver.bodies[0]);
			expect(JSON.parse(message.envelope!)).toMatchObject({ eventId: message.eventId });

			const [group] = await listLearningGroups(testActor(), interactionId);

			expect(group.groupExternalId).toBe('lms-group-1');
		} finally {
			await receiver.stop();
		}
	});

	it('ручной повтор после отказа 4xx уносит то же тело', async () => {
		const receiver = await startReceiver((_body, attempt) =>
			attempt === 1 ? { status: 400, body: '{}' } : { status: 200, body: GROUP_REPLY }
		);

		try {
			await pointGroupsAt(receiver.url);

			const interactionId = await acceptedInteraction();
			await requestLearningGroup(testActor(), {
				interactionId,
				streamNumber: 1,
				plannedSeats: 45,
				startsOn: '2026-10-01',
				endsOn: '2027-05-31'
			});

			const [failed] = await database.db
				.select({ id: exchangeMessages.id, envelope: exchangeMessages.envelope })
				.from(exchangeMessages)
				.where(eq(exchangeMessages.eventType, 'learning_group.requested'));

			const retried = await retryExchangeMessage(testActor(), failed.id);

			expect(retried.ok).toBe(true);
			expect(receiver.bodies).toHaveLength(2);
			expect(receiver.bodies[1]).toBe(receiver.bodies[0]);

			const [message] = await database.db
				.select()
				.from(exchangeMessages)
				.where(eq(exchangeMessages.id, failed.id));

			expect(message.state).toBe('sent');
			expect(message.envelope).toEqual(failed.envelope);
		} finally {
			await receiver.stop();
		}
	});
});

describe('ответ системы обучения', () => {
	it('не считает заявку отправленной, пока группа не названа', async () => {
		// 2xx с телом не по контракту — это отказ доставки. Закрыть сообщение как
		// отправленное значило бы убить обратное направление молча: результат
		// потока ищет группу по её имени, а имени у нас нет.
		const receiver = await startReceiver(() => ({
			status: 200,
			body: JSON.stringify({ ok: true })
		}));

		try {
			await pointGroupsAt(receiver.url);

			const interactionId = await acceptedInteraction();
			const outcome = await requestLearningGroup(testActor(), {
				interactionId,
				streamNumber: 1,
				plannedSeats: 45,
				startsOn: '2026-10-01',
				endsOn: '2027-05-31'
			});

			expect(outcome.delivered).toBe(false);
			expect(outcome.error).toContain('не назвала идентификатор группы');

			const [message] = await database.db
				.select()
				.from(exchangeMessages)
				.where(eq(exchangeMessages.eventType, 'learning_group.requested'));

			expect(message).toMatchObject({ state: 'failed', responseStatus: 200 });

			const [group] = await listLearningGroups(testActor(), interactionId);

			expect(group.groupExternalId).toBeNull();
		} finally {
			await receiver.stop();
		}
	});
});

describe('ключ и подключение обмена', () => {
	const resultMessage = () => ({
		schemaVersion: '1.0',
		eventId: crypto.randomUUID(),
		eventType: 'learning_group.result',
		occurredAt: new Date().toISOString(),
		source: { system: 'lms', instance: 'moodle-itschool' },
		data: {
			groupExternalId: 'lms-group-1',
			requestExternalId: null,
			period: null,
			finishedOn: null,
			counters: { enrolled: 1, completed: 1, expelled: 0 },
			report: null
		}
	});

	it('ключ CMS не подаёт результат учебной группы', async () => {
		// Право `exchange.results` есть у любого ключа обмена — их различает не
		// право, а подключение, на которое ключ выпущен.
		const response = await results(
			apiEvent({
				body: resultMessage(),
				key: apiKey,
				route: '/api/v1/exchange/learning-groups/results'
			})
		);

		expect(response.status).toBe(403);
		expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
			'«cms»'
		);
	});

	it('ключ системы обучения не подаёт заявку с сайта', async () => {
		const response = await intake(apiEvent({ body: envelope(B2B_DATA), key: lmsApiKey }));

		expect(response.status).toBe(403);

		const messages = await database.db.select({ id: exchangeMessages.id }).from(exchangeMessages);

		expect(messages).toHaveLength(0);
	});

	it('не выпускает ключ внешней системы без подключения', async () => {
		await expect(
			createApiKey(testActor(), {
				name: 'Ключ ниоткуда',
				ownerUserId: TEST_USER_IDS.service,
				exchangeSystem: null
			})
		).rejects.toMatchObject({ code: 'validation' });
	});
});

describe('заявка по вузу, который ведёт другой сотрудник', () => {
	it('ведётся от имени действующего ответственного', async () => {
		const organizationId = await insertOrganization(database.db, {
			shortName: 'МТУСИ',
			inn: '0000000096'
		});
		const kam = await insertUser(database.db, {
			roleId: 'manager',
			email: `kam-${crypto.randomUUID()}@example.org`
		});

		await database.db.insert(organizationResponsibles).values({ organizationId, userId: kam });

		const response = await intake(apiEvent({ body: envelope(B2B_DATA), key: apiKey }));
		const body = (await response.json()) as {
			result: string;
			data: { interactionId: string; organizationId: string };
		};

		// Сотрудник из настройки этот вуз не видит: его область — его назначения.
		// Заявка по знакомому вузу ведётся от имени того, кто его ведёт.
		expect(response.status).toBe(200);
		expect(body.data.organizationId).toBe(organizationId);

		const [interaction] = await database.db
			.select({ ownerUserId: interactions.ownerUserId })
			.from(interactions)
			.where(eq(interactions.id, body.data.interactionId));

		expect(interaction.ownerUserId).toBe(kam);

		// Прежнее назначение не переписано и второго не появилось.
		const responsibles = await database.db
			.select({ userId: organizationResponsibles.userId })
			.from(organizationResponsibles)
			.where(eq(organizationResponsibles.organizationId, organizationId));

		expect(responsibles).toEqual([{ userId: kam }]);
	});
});

describe('статус по передаче', () => {
	it('нераспределённый статус попадает в комментарий приёма', async () => {
		// Статус ложится на позицию договора, а у новой заявки договора ещё нет.
		// Потерять присланное нельзя: сотрудник свяжет заявку с договором и
		// проставит статус сам, а по комментарию будет видно, какой именно.
		const response = await intake(
			apiEvent({
				body: envelope({ ...B2B_DATA, transferStatus: 'not_started' }),
				key: apiKey
			})
		);
		const { data } = (await response.json()) as { data: { interactionId: string } };

		const [comment] = await database.db
			.select({ body: comments.body })
			.from(comments)
			.where(eq(comments.interactionId, data.interactionId));

		expect(comment.body).toContain('Статус по передаче из каталога заказчика: not_started');
	});
});

describe('персональные данные в журнале обмена', () => {
	it('в теле сообщения остаются идентификаторы и отпечатки, а не контакты', async () => {
		const response = await intake(apiEvent({ body: envelope(B2C_DATA), key: apiKey }));

		expect(response.status).toBe(200);

		const [message] = await database.db
			.select()
			.from(exchangeMessages)
			.where(eq(exchangeMessages.direction, 'inbound'));

		const stored = JSON.stringify(message.payload);

		// ФИО и контакты уже легли в `people`, где работают маскирование, срок
		// хранения и обезличивание. Вторая копия здесь этих правил не знает.
		expect(stored).not.toContain('vetrov@example.org');
		expect(stored).not.toContain('Ветров');
		expect(stored).not.toContain('+7 900 000-00-22');
		expect(message.payload).toMatchObject({
			data: { externalId: 'site-2026-000124', form: 'b2c' }
		});
	});

	it('обезличивание уносит ФИО из названия контрагента, заголовка и тела обмена', async () => {
		const response = await intake(apiEvent({ body: envelope(B2C_DATA), key: apiKey }));
		const body = (await response.json()) as {
			data: { interactionId: string; organizationId: string };
		};

		const [organization] = await database.db
			.select({ personId: organizations.personId })
			.from(organizations)
			.where(eq(organizations.id, body.data.organizationId));

		await anonymizePerson(testActor(), organization.personId!);

		const [counterparty] = await database.db
			.select({ legalName: organizations.legalName, shortName: organizations.shortName })
			.from(organizations)
			.where(eq(organizations.id, body.data.organizationId));

		expect(counterparty).toEqual({ legalName: 'Обезличено', shortName: 'Обезличено' });

		const [interaction] = await database.db
			.select({ title: interactions.title })
			.from(interactions)
			.where(eq(interactions.id, body.data.interactionId));

		expect(interaction.title).not.toContain('Ветров');
		expect(interaction.title).toContain('Обезличено');

		const messages = await database.db
			.select({ payload: exchangeMessages.payload })
			.from(exchangeMessages)
			.where(eq(exchangeMessages.interactionId, body.data.interactionId));

		expect(messages.length).toBeGreaterThan(0);

		for (const message of messages) {
			expect(message.payload).toHaveProperty('anonymizedAt');
		}
	});
});
