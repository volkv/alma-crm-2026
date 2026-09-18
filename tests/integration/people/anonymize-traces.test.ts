// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
import { vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ANONYMIZED_TEXT } from '$lib/contracts/directory';
import {
	applicationSubmittedSchema,
	type ApplicationSubmittedMessage
} from '$lib/contracts/exchange';
import { updateInteractionSchema } from '$lib/contracts/interactions';
import { systemActor } from '$lib/server/actor';
import {
	comments,
	exchangeMessages,
	interactionChanges,
	interactions,
	notificationDeliveries,
	organizations,
	stageEntries
} from '$lib/server/db/schema';
import { receiveApplication } from '$lib/server/integrations/exchange/intake';
import { setExchangeSettings } from '$lib/server/integrations/settings';
import { updateInteraction } from '$lib/server/interactions/write';
import { runNotificationCycle } from '$lib/server/notifications/watch';
import { hashEmail } from '$lib/server/people/pii';
import { anonymizePerson } from '$lib/server/people/retention';
import { getRedis } from '$lib/server/redis';
import { addComment } from '$lib/server/stages/commands';
import {
	B2B_GROUP_KEY,
	B2B_PROCESS,
	B2C_GROUP_KEY,
	B2C_PROCESS
} from '$lib/server/stages/definitions';
import { ensureProcess } from '$lib/server/stages/process';
import { startTestDatabase, testActor, TEST_USER_IDS, type TestDatabase } from '../helpers/db';

/**
 * Что остаётся от человека после уничтожения его данных.
 *
 * Проверка идёт **сырым SQL по всем текстовым колонкам всех таблиц** — так на
 * базу смотрит тот, от кого защищаются, и так же она переживает добавление
 * новой колонки: перечислить таблицы руками значило бы проверять сегодняшнюю
 * схему, а следующая копия ФИО появится в той, про которую никто не вспомнил.
 *
 * Сцена настоящая, а не собранная запросами: заявка физического лица с сайта
 * заводит контрагента, названного его ФИО, взаимодействие с тем же ФИО в
 * заголовке, строку в журнале обмена и первый комментарий с текстом, который
 * заявитель написал о себе сам. Дальше заголовок правят (его прежнее значение
 * уходит в предметную историю) и по записи уходит напоминание (заголовок и
 * название стороны уходят в журнал доставок темой и телом).
 */
let database: TestDatabase;

/** Заявитель: ФИО, почта и телефон, которых после уничтожения быть не должно. */
const APPLICANT = {
	lastName: 'Ветров',
	firstName: 'Илья',
	email: 'vetrov@example.org',
	phone: '+7 900 000-00-22'
};

/** Второй номер — внутри свободного текста заявки, а не в колонке контакта. */
const APPLICANT_TEXT_PHONE = '+7 900 000-00-33';

/** Контактное лицо вуза: у него организации-физлица нет вовсе. */
const INSTITUTION_CONTACT = {
	lastName: 'Кузьмина',
	firstName: 'Наталья',
	email: 'kuzmina@mtuci.example.org',
	phone: '+7 900 000-00-11'
};

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
		await ensureProcess(tx, B2B_GROUP_KEY, B2B_PROCESS);
		await ensureProcess(tx, B2C_GROUP_KEY, B2C_PROCESS);
	});

	await setExchangeSettings(testActor(), {
		cmsInstance: 'itschool-site',
		// Ходить по этому адресу тест не будет: снимок статуса встаёт в очередь,
		// а цикл доставки здесь не крутится.
		cmsStatusUrl: 'http://127.0.0.1:9/api/applications/{externalId}/status',
		cmsSecret: 'stand-secret',
		cmsDefaultOwnerUserId: TEST_USER_IDS.manager,
		lmsInstance: 'moodle-itschool',
		lmsGroupsUrl: 'http://127.0.0.1:9/api/groups',
		lmsSecret: 'stand-secret'
	});
});

/** Действующее лицо ключа обмена: роль `service` и ничего сверх её прав. */
const serviceActor = () => testActor({ roleId: 'service' });

/**
 * Сообщение разбирается той же схемой, что и на маршруте: заявка, которую
 * контракт бы не принял, ничего не проверяет.
 */
function envelope(data: Record<string, unknown>): ApplicationSubmittedMessage {
	return applicationSubmittedSchema.parse({
		schemaVersion: '1.0',
		eventId: crypto.randomUUID(),
		eventType: 'application.submitted',
		occurredAt: new Date().toISOString(),
		source: { system: 'cms', instance: 'itschool-site' },
		data
	});
}

/** Заявка физического лица: заявитель и контакт — один человек. */
function individualApplication(externalId: string): ApplicationSubmittedMessage {
	return envelope({
		externalId,
		revision: 1,
		form: 'b2c',
		applicant: {
			kind: 'individual',
			lastName: APPLICANT.lastName,
			firstName: APPLICANT.firstName
		},
		contact: {
			lastName: APPLICANT.lastName,
			firstName: APPLICANT.firstName,
			email: APPLICANT.email,
			phone: APPLICANT.phone
		},
		interest: 'Управление проектами',
		comment: `Прошу вечернюю группу, звонить лучше на ${APPLICANT_TEXT_PHONE} после шести. Илья Ветров.`,
		consent: { given: true, at: '2026-09-16T09:40:55Z', policyVersion: '2026-01' }
	});
}

/** Заявка вуза: человек в ней — контактное лицо, а не заявитель. */
function institutionApplication(): ApplicationSubmittedMessage {
	return envelope({
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
			lastName: INSTITUTION_CONTACT.lastName,
			firstName: INSTITUTION_CONTACT.firstName,
			email: INSTITUTION_CONTACT.email,
			phone: INSTITUTION_CONTACT.phone,
			position: 'Проректор по цифровому развитию'
		},
		interest: 'Программа подготовки DevOps-инженеров'
	});
}

/** Человек, которым заявка представила контрагента-физлицо. */
async function counterpartyPersonId(organizationId: string): Promise<string> {
	const [row] = await database.db
		.select({ personId: organizations.personId })
		.from(organizations)
		.where(eq(organizations.id, organizationId));

	expect(row.personId).not.toBeNull();

	return row.personId as string;
}

/**
 * Где в базе встречается любая из строк — по всем текстовым и `jsonb` колонкам
 * всех таблиц, одним запросом на таблицу. Возвращает «таблица.колонка», чтобы
 * упавшая проверка называла место, а не просто факт.
 */
async function tracesOf(needles: readonly string[]): Promise<string[]> {
	const columns = await database.raw<{ table: string; column: string }[]>`
		select c.table_name as "table", c.column_name as "column"
		from information_schema.columns c
		join information_schema.tables t
			on t.table_schema = c.table_schema and t.table_name = c.table_name
		where c.table_schema = 'public'
			and t.table_type = 'BASE TABLE'
			and c.data_type in ('text', 'character varying', 'character', 'json', 'jsonb')
		order by c.table_name, c.column_name
	`;

	const byTable = new Map<string, string[]>();

	for (const column of columns) {
		byTable.set(column.table, [...(byTable.get(column.table) ?? []), column.column]);
	}

	const patterns = needles.map((needle) => `%${needle}%`);
	const found: string[] = [];

	for (const [table, names] of byTable) {
		const query = names
			.map(
				(name) =>
					`select '${table}.${name}' as place, count(*)::int as hits from "${table}" where "${name}"::text ilike any ($1::text[])`
			)
			.join(' union all ');

		const rows = await database.raw.unsafe<{ place: string; hits: number }[]>(query, [patterns]);

		for (const row of rows) {
			if (row.hits > 0) {
				found.push(row.place);
			}
		}
	}

	return found.sort();
}

describe('следы человека после обезличивания', () => {
	/**
	 * Сцена: две заявки одного человека, напоминание по каждой, комментарий
	 * сотрудника и переименование одной из записей.
	 *
	 * Заявок две, потому что копии ФИО расходятся по-разному: у второй записи
	 * заголовок остался тем, что собрала заявка, а у первой сотрудник его
	 * переписал — и прежнее ФИО осталось только в предметной истории, откуда
	 * замена заголовка его уже не достанет.
	 *
	 * Записей справочника у одного человека тоже две: заявка физического лица
	 * заводит контрагента с его ФИО и отдельно контактное лицо организации.
	 * Уничтожают обе — это две записи об одном человеке, и проверка смотрит,
	 * что после этого не осталось ничего.
	 */
	async function b2cScene(): Promise<{
		interactionIds: string[];
		organizationId: string;
		personIds: string[];
	}> {
		const first = await receiveApplication(
			serviceActor(),
			individualApplication('site-2026-000124')
		);
		const second = await receiveApplication(
			serviceActor(),
			individualApplication('site-2026-000125')
		);

		expect(first.result).toBe('created');
		expect(second.result).toBe('created');

		const organizationId = first.data.organizationId;

		// Тот же человек — тот же контрагент: вторая заявка узнаётся по ключу
		// сравнения почты, а не заводит вторую карточку.
		expect(second.data.organizationId).toBe(organizationId);

		const manager = testActor({ roleId: 'manager', userId: TEST_USER_IDS.manager });

		// Комментарий сотрудника рядом с комментарием заявки: уничтожение данных
		// обязано различать их по источнику, а не по автору — подписаны оба одним
		// и тем же сотрудником, принимающим входящие.
		await addComment(manager, {
			interactionId: first.data.interactionId,
			body: 'Перезвонил, договорились о вечерней группе.'
		});

		// Записи стадий стоят дольше порога — наблюдатель уносит заголовок и
		// название стороны в журнал доставок темой и телом.
		await database.db.update(stageEntries).set({ enteredAt: sql`now() - interval '30 days'` });

		const report = await runNotificationCycle(systemActor(crypto.randomUUID()));

		expect(report.scanned).toBe(2);

		// И только теперь — переименование: письмо уже ушло с прежним заголовком,
		// а прежний заголовок лёг в предметную историю.
		await updateInteraction(
			manager,
			updateInteractionSchema.parse({
				id: first.data.interactionId,
				title: 'Заявка на курс, физическое лицо',
				ownerUserId: TEST_USER_IDS.manager,
				reason: 'Название по правилам отдела',
				parties: [{ organizationId, partyRole: 'customer', isPrimary: true }]
			})
		);

		const counterpartyId = await counterpartyPersonId(organizationId);
		const contactId = second.data.contactPersonId as string;

		expect(contactId).not.toBe(counterpartyId);

		return {
			interactionIds: [first.data.interactionId, second.data.interactionId],
			organizationId,
			personIds: [counterpartyId, contactId]
		};
	}

	/** Уничтожение обеих записей справочника, которыми представлен человек. */
	async function anonymizeAll(personIds: readonly string[]): Promise<void> {
		for (const personId of personIds) {
			await anonymizePerson(testActor(), personId);
		}
	}

	it('сцена заявки до уничтожения держит ФИО и текст заявителя в шести таблицах', async () => {
		await b2cScene();

		// Не декорация: без этой проверки следующая ничего бы не доказывала —
		// пустой ответ можно получить и на сцене, где данных не было вовсе.
		expect(await tracesOf([APPLICANT.lastName, APPLICANT.email, APPLICANT_TEXT_PHONE])).toEqual([
			'comments.body',
			'interaction_changes.old_value',
			'interactions.title',
			'notification_deliveries.body',
			'notification_deliveries.subject',
			'organizations.legal_name',
			'organizations.short_name',
			'people.last_name'
		]);
	});

	it('после уничтожения ни одна колонка базы не содержит ни ФИО, ни почты, ни телефона', async () => {
		const scene = await b2cScene();

		await anonymizeAll(scene.personIds);

		expect(await tracesOf([APPLICANT.lastName, APPLICANT.email, APPLICANT_TEXT_PHONE])).toEqual([]);
	});

	it('на месте уничтоженного текста стоит пометка, а не пустота', async () => {
		const scene = await b2cScene();

		await anonymizeAll(scene.personIds);

		const deliveries = await database.db
			.select({ subject: notificationDeliveries.subject, body: notificationDeliveries.body })
			.from(notificationDeliveries);

		expect(deliveries).toEqual([
			{ subject: ANONYMIZED_TEXT, body: ANONYMIZED_TEXT },
			{ subject: ANONYMIZED_TEXT, body: ANONYMIZED_TEXT }
		]);

		const titleChanges = await database.db
			.select({ oldValue: interactionChanges.oldValue, newValue: interactionChanges.newValue })
			.from(interactionChanges)
			.where(eq(interactionChanges.field, 'title'));

		expect(titleChanges).toEqual([{ oldValue: ANONYMIZED_TEXT, newValue: ANONYMIZED_TEXT }]);

		// Заголовок, который собрала заявка, остаётся читаемым: пропадает из него
		// ровно название контрагента.
		const [untouched] = await database.db
			.select({ title: interactions.title })
			.from(interactions)
			.where(eq(interactions.id, scene.interactionIds[1]));

		expect(untouched.title).toBe('Заявка с сайта: Обезличено — Управление проектами');
	});

	it('комментарий сотрудника остаётся: уничтожается текст заявителя, а не работа', async () => {
		const scene = await b2cScene();

		await anonymizeAll(scene.personIds);

		const rows = await database.db
			.select({ body: comments.body, source: comments.source })
			.from(comments)
			.where(eq(comments.interactionId, scene.interactionIds[0]));

		expect(rows.sort((left, right) => left.source.localeCompare(right.source))).toEqual([
			{ body: ANONYMIZED_TEXT, source: 'application_intake' },
			{ body: 'Перезвонил, договорились о вечерней группе.', source: 'manual' }
		]);
	});
});

describe('отпечаток почты в журнале обмена', () => {
	it('считается тем же ключом сравнения, что лежит в справочнике', async () => {
		await receiveApplication(serviceActor(), institutionApplication());

		const [message] = await database.db
			.select({ payload: exchangeMessages.payload })
			.from(exchangeMessages)
			.where(eq(exchangeMessages.direction, 'inbound'));

		// Неключевой SHA-256 от адреса разворачивается словарём: адреса вузов
		// перебираемы. HMAC на ключе установки — не разворачивается, и он же
		// совпадает с `people.email_hash`, по которому уничтожение данных эти
		// строки и находит.
		expect(
			(message.payload as { data: { contact: { emailHash: string } } }).data.contact.emailHash
		).toBe(hashEmail(INSTITUTION_CONTACT.email));
	});

	it('стирается при уничтожении данных контактного лица вуза', async () => {
		const applied = await receiveApplication(serviceActor(), institutionApplication());
		const personId = applied.data.contactPersonId;

		expect(personId).not.toBeNull();

		await anonymizePerson(testActor(), personId as string);

		const [message] = await database.db
			.select({ payload: exchangeMessages.payload })
			.from(exchangeMessages)
			.where(eq(exchangeMessages.direction, 'inbound'));

		// Тело сообщения остаётся: это история обмена с вузом, а не данные
		// человека. Пропадает ровно отпечаток — и на его месте видно, что было.
		const payload = message.payload as {
			data: { externalId: string; contact: Record<string, unknown> };
		};

		expect(payload.data.externalId).toBe('site-2026-000123');
		expect(payload.data.contact).not.toHaveProperty('emailHash');
		expect(payload.data.contact).toHaveProperty('anonymizedAt');

		expect(await tracesOf([hashEmail(INSTITUTION_CONTACT.email) as string])).toEqual([]);
	});

	it('взаимодействие вуза после этого читается как прежде', async () => {
		const applied = await receiveApplication(serviceActor(), institutionApplication());

		await anonymizePerson(testActor(), applied.data.contactPersonId as string);

		const [row] = await database.db
			.select({ title: interactions.title })
			.from(interactions)
			.where(eq(interactions.id, applied.data.interactionId));

		// Заявитель здесь — вуз, и его название персональными данными не является:
		// уничтожение контакта не стирает заявку организации.
		expect(row.title).toContain('Московский технический университет');
	});
});
