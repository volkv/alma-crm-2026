// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
import { vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import { readFileSync } from 'node:fs';
import { and, count, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	applicationSubmittedSchema,
	EXCHANGE_EVENT_TYPES,
	EXCHANGE_SCHEMA_VERSION
} from '$lib/contracts/exchange';
import { PAYMENT_CHECKLIST_KEY } from '$lib/contracts/payments';
import {
	exchangeMessages,
	interactions,
	people,
	programs,
	stageEntries
} from '$lib/server/db/schema';
import { receiveApplication } from '$lib/server/integrations/exchange/intake';
import { importPayments, previewPayments } from '$lib/server/integrations/exchange/payments';
import { setExchangeSettings } from '$lib/server/integrations/settings';
import { hashEmail } from '$lib/server/people/pii';
import { getRedis } from '$lib/server/redis';
import {
	B2B_WORKSPACE_KEY,
	B2B_PROCESS,
	B2C_WORKSPACE_KEY,
	B2C_PROCESS
} from '$lib/server/stages/definitions';
import { ensureWorkflow } from '$lib/server/stages/process';
import { advanceTo } from '../stages/fixture';
import { startTestDatabase, testActor, TEST_USER_IDS, type TestDatabase } from '../helpers/db';

/**
 * Загрузка оплат с сайта на синтетической выгрузке с той же грязью, что у
 * настоящей: `null` посреди списка, неизвестный курс, поток 1 у двух разных
 * курсов, номер заявки с невалидной датой внутри, почта в другом регистре у
 * уже известного человека.
 */
let database: TestDatabase;

const INSTANCE = 'itschool-site';

const FILE = {
	name: 'payments-sample.json',
	bytes: new Uint8Array(
		readFileSync(new URL('../../fixtures/payments-sample.json', import.meta.url))
	)
};

/** Заказ из выгрузки, по которому заявка с сайта уже пришла раньше. */
const KNOWN_ORDER = 'ORD-20260313051569-QWERTY';
/** Заказ нового слушателя: дела по нему ещё нет. */
const NEW_ORDER = 'ORD-202604011234-ASDFGH';

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await getRedis().quit();
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();

	await database.db.transaction(async (tx) => {
		await ensureWorkflow(tx, B2B_WORKSPACE_KEY, B2B_PROCESS);
		await ensureWorkflow(tx, B2C_WORKSPACE_KEY, B2C_PROCESS);
	});

	await database.db.insert(programs).values(
		[
			'Анализ данных без программирования',
			'Инженер-тестировщик',
			'Управление ИТ-проектами на базе программного продукта ПАО «Ростелеком»'
		].map((name, index) => ({
			code: `SCH-T${index + 1}`,
			name,
			level: 'school' as const,
			status: 'active' as const
		}))
	);

	// Адрес карточки заявки задан: снимок статуса встал бы в очередь, если бы
	// загрузка оплат его ставила, — и проверка «ничего не встало» не пустая.
	await setExchangeSettings(testActor(), {
		cmsInstance: INSTANCE,
		cmsStatusUrl: 'http://127.0.0.1:9/api/applications/{externalId}/status',
		cmsSecret: 'stand-secret',
		cmsDefaultOwnerUserId: TEST_USER_IDS.manager,
		lmsInstance: 'moodle-itschool',
		lmsGroupsUrl: '',
		lmsSecret: null
	});
});

/** Заявка с сайта по заказу, оплату которого потом привезёт выгрузка. */
async function receiveKnownApplication(): Promise<string> {
	const response = await receiveApplication(
		testActor({ roleId: 'service' }),
		applicationSubmittedSchema.parse({
			schemaVersion: EXCHANGE_SCHEMA_VERSION,
			eventId: crypto.randomUUID(),
			eventType: EXCHANGE_EVENT_TYPES.applicationSubmitted,
			occurredAt: new Date().toISOString(),
			source: { system: 'cms', instance: INSTANCE },
			data: {
				externalId: KNOWN_ORDER,
				revision: 1,
				form: 'b2c',
				applicant: { kind: 'individual', lastName: 'Петрова', firstName: 'Елена' },
				contact: {
					lastName: 'Петрова',
					firstName: 'Елена',
					email: 'e.petrova@example.test',
					phone: '+7 900 000-00-01'
				},
				consent: { given: true, at: '2026-03-13T10:00:00Z', policyVersion: '2026-01' }
			}
		})
	);

	return response.data.interactionId;
}

async function interactionOf(externalId: string): Promise<string> {
	const [row] = await database.db
		.select({ id: interactions.id })
		.from(interactions)
		.where(eq(interactions.externalId, externalId));

	return row.id;
}

/** Отметка об оплате на открытой записи стадии и ключ этой стадии. */
async function openEntry(
	interactionId: string
): Promise<{ key: string; paymentReceived: boolean | undefined }> {
	const [entry] = await database.db
		.select({ snapshot: stageEntries.stageSnapshot, state: stageEntries.checklistState })
		.from(stageEntries)
		.where(and(eq(stageEntries.interactionId, interactionId), isNull(stageEntries.leftAt)));

	return { key: entry.snapshot.key, paymentReceived: entry.state[PAYMENT_CHECKLIST_KEY] };
}

/** Сколько записей в базе: дела, люди, входящие и исходящие строки журнала. */
async function totals() {
	const [[interactionCount], [personCount], [inbound], [outbound]] = await Promise.all([
		database.db.select({ value: count() }).from(interactions),
		database.db.select({ value: count() }).from(people),
		database.db
			.select({ value: count() })
			.from(exchangeMessages)
			.where(eq(exchangeMessages.direction, 'inbound')),
		database.db
			.select({ value: count() })
			.from(exchangeMessages)
			.where(eq(exchangeMessages.direction, 'outbound'))
	]);

	return {
		interactions: interactionCount.value,
		people: personCount.value,
		inbound: inbound.value,
		outbound: outbound.value
	};
}

describe('загрузка оплат с сайта', () => {
	it('применяет записи по одной, отмечает оплату по стадии и повтор ничего не меняет', async () => {
		const known = await receiveKnownApplication();
		await advanceTo(testActor(), database, known, 'contract_payment');

		const preview = await previewPayments(testActor(), FILE);

		// Пустой элемент, неизвестный курс и поток 0 — ошибки своих записей, а не
		// файла: остальные три идут дальше.
		expect(preview.counts).toEqual({ create: 2, update: 1, unchanged: 0, error: 3 });
		expect(preview.rows[1]).toMatchObject({ place: 'элемент 1', action: 'error' });
		expect(preview.rows[3].issues.join(' ')).toContain('не найден в справочнике программ');

		const before = await totals();
		const loaded = await importPayments(testActor(), FILE);

		expect(loaded.counts).toEqual({ create: 2, update: 1, unchanged: 0, error: 3 });

		// Дело уже на стадии договора и оплаты — отметка сразу, стадия та же.
		expect(await openEntry(known)).toEqual({ key: 'contract_payment', paymentReceived: true });

		// Человек с почтой в другом регистре узнан: второй записи о нём нет.
		const [petrova] = await database.db
			.select({ value: count() })
			.from(people)
			.where(eq(people.emailHash, hashEmail('e.petrova@example.test') as string));
		expect(petrova.value).toBe(1);

		const after = await totals();
		// Два новых дела и два новых человека, строка журнала на каждую
		// применённую оплату — и ни одного снимка статуса для сайта.
		expect(after).toEqual({
			interactions: before.interactions + 2,
			people: before.people + 2,
			inbound: before.inbound + 3,
			outbound: before.outbound
		});

		// Новое дело стоит на первой стадии: загрузка стадию не двигает, а
		// отметку ставит вход на стадию оплаты по сохранённому факту.
		const fresh = await interactionOf(NEW_ORDER);
		expect((await openEntry(fresh)).key).toBe('lead_intake');

		await advanceTo(testActor(), database, fresh, 'contract_payment');
		expect(await openEntry(fresh)).toEqual({ key: 'contract_payment', paymentReceived: true });

		const beforeRepeat = await totals();
		const repeated = await importPayments(testActor(), FILE);

		expect(repeated.counts).toEqual({ create: 0, update: 0, unchanged: 3, error: 3 });
		expect(await totals()).toEqual(beforeRepeat);
	});
});
