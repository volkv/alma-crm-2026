// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
import { vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WEBHOOK_TEST_EVENT } from '$lib/contracts/integrations';
import { systemActor } from '$lib/server/actor';
import { recordAuditEvent } from '$lib/server/audit';
import { auditEvents } from '$lib/server/db/schema';
import { MAX_DELIVERY_ATTEMPTS, verifySignature } from '$lib/server/integrations/delivery';
import { runDeliveryCycle, sendTestEvent } from '$lib/server/integrations/pump';
import { webhookPendingKey, webhookRetryQueueKey } from '$lib/server/integrations/redis-keys';
import {
	countPending,
	createWebhook,
	listDeliveries,
	readSubscription,
	updateWebhook
} from '$lib/server/integrations/subscriptions';
import { getRedis } from '$lib/server/redis';
import { startTestDatabase, testActor, type TestDatabase } from '../helpers/db';

/**
 * Доставка событий журнала в подписку — целиком, до настоящего приёмника.
 *
 * Приёмник поднимается прямо здесь обычным `http.createServer`: подделка,
 * которая «как будто приняла запрос», не проверила бы ни подпись, ни заголовки,
 * ни то, что мы вообще куда-то ходим.
 */
let database: TestDatabase;
let server: Server;
let port: number;

/** Что приёмник получил и чем он отвечает: и то и другое меняется по ходу. */
let received: { headers: Record<string, string>; body: string }[] = [];
let replyStatus = 200;

beforeAll(async () => {
	database = await startTestDatabase();

	server = createServer((request, response) => {
		let body = '';

		request.on('data', (chunk: Buffer) => {
			body += chunk.toString('utf8');
		});

		request.on('end', () => {
			received.push({
				headers: Object.fromEntries(
					Object.entries(request.headers).map(([name, value]) => [name, String(value)])
				),
				body
			});

			response.statusCode = replyStatus;
			response.end('ok');
		});
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
	received = [];
	replyStatus = 200;
});

afterEach(() => {
	replyStatus = 200;
});

const ctx = () => testActor();
const background = () => systemActor('00000000-0000-4000-8000-00000000c0de');

function receiverUrl(): string {
	return `http://127.0.0.1:${port}/hook`;
}

async function subscribe(events: string[] = ['organizations.*']) {
	return createWebhook(ctx(), {
		name: 'Портал партнёров',
		url: receiverUrl(),
		events,
		enabled: true
	});
}

/** Событие журнала, ради которого подписка и заведена. */
async function journalEvent(id: string): Promise<void> {
	await recordAuditEvent(ctx(), {
		type: 'organizations.created',
		outcome: 'success',
		subject: { type: 'organization', id }
	});
}

const ORG_ID = '00000000-0000-4000-8000-000000000101';
const OTHER_ORG_ID = '00000000-0000-4000-8000-000000000102';

async function eventTypes(): Promise<string[]> {
	const rows = await database.db
		.select({ type: auditEvents.eventType })
		.from(auditEvents)
		.orderBy(auditEvents.occurredAt);

	return rows.map((row) => row.type);
}

describe('доставка события журнала', () => {
	it('уходит подписанной и только за то, что случилось после подписки', async () => {
		// Событие до подписки: подписка — договорённость на будущее, а не повод
		// высыпать получателю накопленный журнал.
		await journalEvent(OTHER_ORG_ID);

		const created = await subscribe();

		await journalEvent(ORG_ID);

		const report = await runDeliveryCycle(background());

		expect(report).toMatchObject({ subscriptions: 1, delivered: 1, failed: 0 });
		expect(received).toHaveLength(1);

		const [delivery] = received;
		const payload = JSON.parse(delivery.body) as { type: string; subject: { id: string } };

		expect(payload.type).toBe('organizations.created');
		expect(payload.subject.id).toBe(ORG_ID);
		expect(delivery.headers['x-webhook-id']).toBe(created.webhook.id);

		// Подпись считается получателем по тому же правилу; без неё запрос ничем
		// не отличается от чужого.
		expect(
			verifySignature(
				created.secret,
				delivery.headers['x-webhook-timestamp'],
				delivery.body,
				delivery.headers['x-webhook-signature']
			)
		).toBe(true);
	});

	it('не отправляет одно событие дважды', async () => {
		await subscribe();
		await journalEvent(ORG_ID);

		await runDeliveryCycle(background());
		await runDeliveryCycle(background());

		expect(received).toHaveLength(1);
	});

	it('сводит успехи прохода в одну запись журнала', async () => {
		await subscribe();
		await journalEvent(ORG_ID);
		await journalEvent(OTHER_ORG_ID);

		await runDeliveryCycle(background());

		expect(received).toHaveLength(2);
		expect(
			(await eventTypes()).filter((type) => type === 'integrations.webhook_delivered')
		).toEqual(['integrations.webhook_delivered']);
	});

	it('не доставляет записи о самой доставке', async () => {
		// Иначе доставка порождает событие, которое снова нужно доставить, и цикл
		// кормит сам себя. Подписка нарочно взята на весь раздел `integrations`:
		// заведение подписки в неё попадает, а её собственные отчёты о доставке —
		// нет.
		await subscribe(['integrations.*', 'organizations.*']);
		await journalEvent(ORG_ID);

		await runDeliveryCycle(background());
		await runDeliveryCycle(background());

		const types = received.map((delivery) => (JSON.parse(delivery.body) as { type: string }).type);

		expect(types).toEqual(['integrations.webhook_created', 'organizations.created']);
	});

	it('молчит, когда событие не под фильтром или подписка выключена', async () => {
		const created = await subscribe(['documents.uploaded']);
		await journalEvent(ORG_ID);

		await runDeliveryCycle(background());
		expect(received).toHaveLength(0);

		await updateWebhook(ctx(), {
			id: created.webhook.id,
			name: created.webhook.name,
			url: created.webhook.url,
			events: ['organizations.*'],
			enabled: false
		});
		await journalEvent(OTHER_ORG_ID);

		const report = await runDeliveryCycle(background());

		expect(report.subscriptions).toBe(0);
		expect(received).toHaveLength(0);
	});
});

describe('повторы', () => {
	it('ставит неудавшееся в очередь и доводит со следующей попытки', async () => {
		const created = await subscribe();
		replyStatus = 500;

		await journalEvent(ORG_ID);
		await runDeliveryCycle(background());

		expect(received).toHaveLength(1);
		expect(await countPending(created.webhook.id)).toBe(1);

		const [attempt] = await listDeliveries(created.webhook.id);
		expect(attempt).toMatchObject({ attempt: 1, ok: false, status: 500 });
		expect(attempt.error).toContain('500');

		// Ждать пятнадцать секунд значило бы проверять терпение: срок повтора
		// двигается в очереди, а цикл остаётся тем же.
		const queue = webhookRetryQueueKey(created.webhook.id);
		const [eventId] = await getRedis().zrange(queue, '0', '0');
		await getRedis().zadd(queue, String(Date.now()), eventId);

		replyStatus = 200;
		const report = await runDeliveryCycle(background());

		expect(report).toMatchObject({ retried: 1, delivered: 1 });
		expect(received).toHaveLength(2);
		expect(await countPending(created.webhook.id)).toBe(0);
	});

	it('сдаётся после последней попытки и говорит об этом в журнале', async () => {
		const created = await subscribe();
		replyStatus = 500;

		await journalEvent(ORG_ID);
		await runDeliveryCycle(background());

		const queue = webhookRetryQueueKey(created.webhook.id);
		const [eventId] = await getRedis().zrange(queue, '0', '0');
		const raw = await getRedis().get(webhookPendingKey(created.webhook.id, eventId));
		const pending = JSON.parse(raw ?? '{}') as { attempt: number };

		// Последняя попытка: следующая неудача исчерпывает расписание.
		await getRedis().set(
			webhookPendingKey(created.webhook.id, eventId),
			JSON.stringify({ ...pending, attempt: MAX_DELIVERY_ATTEMPTS - 1 })
		);
		await getRedis().zadd(queue, String(Date.now()), eventId);

		const report = await runDeliveryCycle(background());

		expect(report.failed).toBe(1);
		expect(await countPending(created.webhook.id)).toBe(0);

		const rows = await database.db
			.select({ details: auditEvents.details })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'integrations.webhook_failed'));

		expect(rows).toHaveLength(1);
		expect(rows[0].details).toMatchObject({ webhookId: created.webhook.id, eventId });
	});
});

describe('проверочная отправка', () => {
	it('уходит тем же телом и подписью, но своим кодом события', async () => {
		const created = await subscribe();
		const subscription = await readSubscription(created.webhook.id);

		expect(subscription).not.toBeNull();

		const outcome = await sendTestEvent(ctx(), subscription!);

		expect(outcome).toMatchObject({ ok: true, status: 200 });
		expect(received).toHaveLength(1);

		const payload = JSON.parse(received[0].body) as { type: string };
		expect(payload.type).toBe(WEBHOOK_TEST_EVENT);

		expect(
			verifySignature(
				created.secret,
				received[0].headers['x-webhook-timestamp'],
				received[0].body,
				received[0].headers['x-webhook-signature']
			)
		).toBe(true);
	});

	it('сообщает об отказе получателя словами', async () => {
		const created = await subscribe();
		const subscription = await readSubscription(created.webhook.id);
		replyStatus = 503;

		const outcome = await sendTestEvent(ctx(), subscription!);

		expect(outcome.ok).toBe(false);
		expect(outcome.error).toContain('503');
	});
});

describe('след в журнале', () => {
	it('остаётся от заведения и правки подписки', async () => {
		const created = await subscribe();

		await updateWebhook(ctx(), {
			id: created.webhook.id,
			name: 'Портал партнёров (тест)',
			url: created.webhook.url,
			events: created.webhook.events,
			enabled: created.webhook.enabled
		});

		const rows = await database.db
			.select({
				type: auditEvents.eventType,
				subjectId: auditEvents.subjectId,
				details: auditEvents.details
			})
			.from(auditEvents)
			.where(eq(auditEvents.subjectType, 'webhook'));

		expect(rows).toMatchObject([
			{ type: 'integrations.webhook_created', subjectId: created.webhook.id },
			{
				type: 'integrations.webhook_updated',
				subjectId: created.webhook.id,
				details: { changedFields: ['name'] }
			}
		]);
	});

	it('отказывает без права и пишет отказ', async () => {
		const reader = testActor({ roleId: 'viewer' });

		await expect(
			createWebhook(reader, {
				name: 'Чужая подписка',
				url: receiverUrl(),
				events: ['organizations.*'],
				enabled: true
			})
		).rejects.toMatchObject({ code: 'forbidden' });

		const rows = await database.db
			.select({ type: auditEvents.eventType, outcome: auditEvents.outcome })
			.from(auditEvents);

		expect(rows).toMatchObject([{ type: 'integrations.webhook_created', outcome: 'denied' }]);
	});
});
