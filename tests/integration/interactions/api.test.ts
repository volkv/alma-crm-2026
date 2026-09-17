/**
 * Эндпоинты взаимодействий целиком: ключ, область доступа, схема ответа и
 * идемпотентность перехода. Обработчики зовутся так же, как их зовёт SvelteKit,
 * поэтому проверяется и обёртка, и наш код — в том числе то, что ответ сходится
 * со своей схемой (иначе он наружу не уходит вовсе).
 */
import type { RequestEvent } from '@sveltejs/kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInteractionSchema, type ProcessRevisionView } from '$lib/contracts/interactions';
import { createApiKey } from '$lib/server/api/keys';
import { createInteraction } from '$lib/server/interactions/write';
import { getRedis } from '$lib/server/redis';
import { B2B_GROUP_KEY, B2B_PROCESS, B2C_GROUP_KEY } from '$lib/server/stages/definitions';
import { ensureProcess, readGroupByKey, requireActiveRevision } from '$lib/server/stages/process';
import { setChecklistItem } from '$lib/server/stages/commands';
import { getInteractionStatus } from '$lib/server/stages/status';
import {
	insertOrganization,
	startTestDatabase,
	testActor,
	TEST_USER_IDS,
	type TestDatabase
} from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

type Endpoint = (event: RequestEvent) => Response | Promise<Response>;

const listEndpoint = (await import('../../../src/routes/api/v1/interactions/+server'))
	.GET as Endpoint;
const detailEndpoint = (await import('../../../src/routes/api/v1/interactions/[id]/+server'))
	.GET as Endpoint;
const transitionEndpoint = (
	await import('../../../src/routes/api/v1/interactions/[id]/transitions/+server')
).POST as Endpoint;

let database: TestDatabase;

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await getRedis().quit();
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();
});

type EventOptions = {
	method?: string;
	path: string;
	query?: Record<string, string>;
	headers?: Record<string, string>;
	body?: string;
	params?: Record<string, string>;
	routeId: string;
};

/**
 * Событие запроса в том виде, в каком его собирает SvelteKit: обработчик берёт
 * из него адрес, заголовки и параметры пути, поэтому остальное в подделке не
 * участвует.
 */
function apiEvent(options: EventOptions): RequestEvent {
	const url = new URL(`http://localhost${options.path}`);

	for (const [name, value] of Object.entries(options.query ?? {})) {
		url.searchParams.set(name, value);
	}

	const request = new Request(url, {
		method: options.method ?? 'GET',
		headers: options.headers,
		body: options.body
	});

	return {
		request,
		url,
		params: options.params ?? {},
		route: { id: options.routeId },
		locals: { requestId: crypto.randomUUID(), user: null, apiKey: null },
		getClientAddress: () => `198.51.100.${Math.ceil(Math.random() * 250)}`,
		setHeaders: () => {},
		isDataRequest: false,
		isSubRequest: false
	} as unknown as RequestEvent;
}

async function body(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

async function issueKey(roleId: string): Promise<string> {
	const created = await createApiKey(testActor(), {
		name: `Ключ ${roleId}`,
		ownerUserId: TEST_USER_IDS[roleId],
		exchangeSystem: null
	});

	return created.key;
}

/** Действующая редакция группы: по ней тесты адресуют стадии. */
async function revisionOf(groupKey: string): Promise<ProcessRevisionView> {
	return requireActiveRevision(database.db, await readGroupByKey(database.db, groupKey));
}

async function seedInteraction(): Promise<{ id: string; revision: ProcessRevisionView }> {
	const ctx = testActor();
	await database.db.transaction((tx) => ensureProcess(tx, B2B_GROUP_KEY, B2B_PROCESS));
	const organizationId = await insertOrganization(database.db, { shortName: 'Вуз для API' });

	const interaction = await createInteraction(
		ctx,
		createInteractionSchema.parse({
			title: 'Взаимодействие для API',
			ownerUserId: TEST_USER_IDS.admin,
			parties: [{ organizationId, partyRole: 'educational_institution', isPrimary: true }]
		})
	);

	return { id: interaction.id, revision: await revisionOf(B2B_GROUP_KEY) };
}

/**
 * Взаимодействие на процессе, где объяснения требует шаг вперёд. В процессе
 * учебных заведений такого перехода нет, а интеграция обязана уметь пройти и
 * его: правило, которое нельзя выполнить через API, запирает процесс. Группа
 * другая, потому что в одной группе действует ровно один процесс.
 */
async function seedReasonInteraction(): Promise<{ id: string; route: ProcessRevisionView }> {
	const ctx = testActor();

	await database.db.transaction((tx) =>
		ensureProcess(tx, B2C_GROUP_KEY, {
			name: 'Процесс с объяснением шага вперёд',
			note: null,
			migrationRules: [],
			stages: [
				{
					key: 'first',
					name: 'Первая стадия',
					category: 'contact',
					slaDays: 5,
					staleAfterDays: null,
					requiresResult: false,
					requiresConfirmation: false,
					requiresLmsData: false,
					isFinal: false,
					checklist: []
				},
				{
					key: 'second',
					name: 'Вторая стадия',
					category: 'control',
					slaDays: 5,
					staleAfterDays: null,
					requiresResult: false,
					requiresConfirmation: false,
					requiresLmsData: false,
					isFinal: true,
					checklist: []
				}
			],
			transitions: [
				{
					fromStageKey: 'first',
					toStageKey: 'second',
					kind: 'forward',
					requiredPermissionKey: 'stages.transition',
					requiresReason: true
				}
			]
		})
	);

	const organizationId = await insertOrganization(database.db, {
		shortName: 'Заказчик с объяснением для API',
		kind: 'legal_entity'
	});

	const interaction = await createInteraction(
		ctx,
		createInteractionSchema.parse({
			title: 'Переход с объяснением через API',
			ownerUserId: TEST_USER_IDS.admin,
			parties: [{ organizationId, partyRole: 'customer', isPrimary: true }]
		})
	);

	return { id: interaction.id, route: await revisionOf(B2C_GROUP_KEY) };
}

describe('GET /v1/interactions', () => {
	it('отдаёт страницу списка со сроком текущей стадии', async () => {
		const interaction = await seedInteraction();
		const key = await issueKey('admin');

		const response = await listEndpoint(
			apiEvent({
				path: '/api/v1/interactions',
				routeId: '/api/v1/interactions',
				headers: { authorization: `Bearer ${key}` }
			})
		);

		const page = await body(response);
		const items = page.items as Record<string, unknown>[];

		expect(response.status).toBe(200);
		expect(page.total).toBe(1);
		expect(items[0].id).toBe(interaction.id);
		expect(items[0].stageKey).toBe('contact_search');
		expect(items[0].institutionName).toBe('Вуз для API');
		// Наружу уезжает строка ISO 8601, а не внутренний `Date`.
		expect(items[0].dueAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it('не пускает без ключа', async () => {
		await seedInteraction();

		const response = await listEndpoint(
			apiEvent({ path: '/api/v1/interactions', routeId: '/api/v1/interactions' })
		);

		expect(response.status).toBe(401);
	});
});

describe('GET /v1/interactions/{id}', () => {
	it('отдаёт карточку с лентой стадий', async () => {
		const interaction = await seedInteraction();
		const key = await issueKey('admin');

		const response = await detailEndpoint(
			apiEvent({
				path: `/api/v1/interactions/${interaction.id}`,
				routeId: '/api/v1/interactions/[id]',
				params: { id: interaction.id },
				headers: { authorization: `Bearer ${key}` }
			})
		);

		const card = await body(response);

		expect(response.status).toBe(200);
		expect(card.processGroupKey).toBe(B2B_GROUP_KEY);
		expect(card.processRevision).toBe(interaction.revision.version);
		expect((card.progress as unknown[]).length).toBe(14);
		expect((card.parties as Record<string, unknown>[])[0].partyRole).toBe(
			'educational_institution'
		);
	});

	it('отдаёт 404 на чужой идентификатор', async () => {
		const key = await issueKey('admin');
		const id = '00000000-0000-4000-8000-0000000000ff';

		const response = await detailEndpoint(
			apiEvent({
				path: `/api/v1/interactions/${id}`,
				routeId: '/api/v1/interactions/[id]',
				params: { id },
				headers: { authorization: `Bearer ${key}` }
			})
		);

		expect(response.status).toBe(404);
	});
});

describe('POST /v1/interactions/{id}/transitions', () => {
	async function transition(
		key: string,
		interactionId: string,
		payload: Record<string, unknown>,
		idempotencyKey?: string
	): Promise<Response> {
		return transitionEndpoint(
			apiEvent({
				method: 'POST',
				path: `/api/v1/interactions/${interactionId}/transitions`,
				routeId: '/api/v1/interactions/[id]/transitions',
				params: { id: interactionId },
				headers: {
					authorization: `Bearer ${key}`,
					'content-type': 'application/json',
					...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey })
				},
				body: JSON.stringify(payload)
			})
		);
	}

	it('двигает по процессу и не выполняет повтор с тем же ключом дважды', async () => {
		const ctx = testActor();
		const interaction = await seedInteraction();
		const route = interaction.revision;
		const key = await issueKey('admin');

		const first = route.stages[0];
		const second = route.stages[1];

		for (const item of first.checklist) {
			if (item.required) {
				await setChecklistItem(ctx, { interactionId: interaction.id, key: item.key, done: true });
			}
		}

		const payload = {
			kind: 'forward',
			fromStageId: first.id,
			toStageId: second.id,
			revision: route.version
		};
		const response = await transition(key, interaction.id, payload, 'idem-transition-1');
		const result = await body(response);

		expect(response.status).toBe(200);
		expect(result.stageKey).toBe(second.key);
		expect(result.stagePosition).toBe(2);

		const replay = await transition(key, interaction.id, payload, 'idem-transition-1');

		expect(replay.headers.get('Idempotency-Replay')).toBe('true');
		expect(await body(replay)).toEqual(result);

		// Повтор не двинул взаимодействие дальше: в истории одна пройденная стадия.
		const status = await getInteractionStatus(ctx, interaction.id);
		expect(status.history).toHaveLength(1);
		expect(status.current?.snapshot.key).toBe(second.key);
	});

	it('отказывает с 409, если взаимодействие уже сдвинули', async () => {
		const interaction = await seedInteraction();
		const route = interaction.revision;
		const key = await issueKey('admin');

		const response = await transition(key, interaction.id, {
			kind: 'forward',
			fromStageId: route.stages[1].id,
			toStageId: route.stages[2].id,
			revision: route.version
		});

		expect(response.status).toBe(409);
	});

	it('везёт объяснение шага вперёд туда, где его требует процесс', async () => {
		const ctx = testActor();
		const seeded = await seedReasonInteraction();
		const key = await issueKey('admin');

		const [first, second] = seeded.route.stages;
		const payload = {
			kind: 'forward',
			fromStageId: first.id,
			toStageId: second.id,
			revision: seeded.route.version
		};

		const withoutReason = await transition(key, seeded.id, payload);

		expect(withoutReason.status).toBe(409);
		expect(JSON.stringify(await body(withoutReason))).toContain('Нужно объяснить причину');

		const withReason = await transition(key, seeded.id, {
			...payload,
			reason: 'Договорённости зафиксированы протоколом'
		});

		expect(withReason.status).toBe(200);
		expect((await body(withReason)).stageKey).toBe(second.key);

		// Объяснение доехало до истории, а не осталось в теле запроса.
		const status = await getInteractionStatus(ctx, seeded.id);
		expect(status.history[0].outcomeReason).toBe('Договорённости зафиксированы протоколом');
	});

	it('требует причину для возврата, а вне области не показывает запись', async () => {
		const interaction = await seedInteraction();
		const route = interaction.revision;

		const admin = await issueKey('admin');
		// Ключ менеджера: право на переход у него есть, а вот записи он не видит —
		// ни ответственным за её вуз, ни владельцем он не числится. Вне области
		// ответ обязан быть «не найдено», а не «нельзя»: иначе перебором
		// идентификаторов узнают, что за её пределами существует.
		const outsideScope = await issueKey('manager');

		const withoutReason = await transition(admin, interaction.id, {
			kind: 'return',
			fromStageId: route.stages[0].id,
			toStageId: route.stages[1].id,
			revision: route.version
		});

		expect(withoutReason.status).toBe(400);
		// Отказ по существу, а не «что-то не так»: причина возврата обязательна.
		expect(JSON.stringify(await body(withoutReason))).toContain(
			'Опишите, почему взаимодействие возвращается назад'
		);

		const unseen = await transition(outsideScope, interaction.id, {
			kind: 'forward',
			fromStageId: route.stages[0].id,
			toStageId: route.stages[1].id,
			revision: route.version
		});

		expect(unseen.status).toBe(404);
	});
});
