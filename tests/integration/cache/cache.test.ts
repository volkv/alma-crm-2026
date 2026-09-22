/**
 * Кэш повторного открытия (`F13`) на настоящих PostgreSQL и Redis.
 *
 * Проверяется то, чего не проверить на заглушке: что из кэша приходит ровно то
 * же, что из базы; что поколение обесценивает собранное; что ключ разводит
 * области доступа — и подбор одного человека не достаётся другому.
 *
 * Приём один и тот же: сначала чтение кладёт ответ в Redis, потом данные
 * меняются **мимо сервиса**, и повторное чтение обязано отдать прежнее — так
 * видно, что ответ действительно пришёл из кэша, а не собрался заново.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANONYMIZED_PERSON_LAST_NAME } from '$lib/contracts/directory';
import type { ActorContext } from '$lib/server/actor';
import { invalidateDirectoryOptions } from '$lib/server/cache/directory';
import {
	affiliations,
	auditEvents,
	comments,
	interactionChanges,
	interactionParties,
	interactions,
	organizationResponsibles,
	organizations,
	stages
} from '$lib/server/db/schema';
import { listOrganizationOptions, listPersonOptions } from '$lib/server/directory/read';
import { createOrganization, createPerson } from '$lib/server/directory/write';
import { anonymizePerson } from '$lib/server/people/retention';
import {
	getInteraction,
	listComments,
	listInteractionChanges
} from '$lib/server/interactions/read';
import { getRedis } from '$lib/server/redis';
import { readFilterOptions } from '$lib/server/reports/options';
import { addComment } from '$lib/server/stages/commands';
import { B2B_WORKSPACE_KEY, B2B_PROCESS } from '$lib/server/stages/definitions';
import {
	createDraft,
	ensureProcess,
	processDefinition,
	publishProcess,
	readActiveRevisionCached,
	readWorkspaceByKey,
	updateDraft
} from '$lib/server/stages/process';
import {
	insertInteractionWithStage,
	insertOrganization,
	insertPerson,
	scopedActor,
	startTestDatabase,
	testActor,
	TEST_USER_IDS,
	type TestDatabase
} from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

let database: TestDatabase;

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

beforeEach(async () => {
	await database.reset();
});

afterAll(async () => {
	await getRedis().quit();
	await database.stop();
});

/** Организация мимо сервиса: сервис обесценил бы кэш, а тесту нужен именно он. */
async function insertOrganizationDirectly(shortName: string): Promise<string> {
	return insertOrganization(database.db, { shortName });
}

describe('кэш подбора из справочника', () => {
	it('отдаёт то же, что база, и переживает изменение в обход сервиса', async () => {
		const ctx = testActor();
		await insertOrganizationDirectly('Альфа');

		expect((await listOrganizationOptions(ctx)).map((option) => option.label)).toStrictEqual([
			'Альфа'
		]);

		await insertOrganizationDirectly('Бета');

		// Ответ из Redis: заведённой мимо сервиса организации в нём нет.
		expect((await listOrganizationOptions(ctx)).map((option) => option.label)).toStrictEqual([
			'Альфа'
		]);

		await invalidateDirectoryOptions();

		expect((await listOrganizationOptions(ctx)).map((option) => option.label)).toStrictEqual([
			'Альфа',
			'Бета'
		]);
	});

	it('показывает организацию, заведённую сервисом, сразу же', async () => {
		const ctx = testActor();
		await insertOrganizationDirectly('Альфа');

		// Первое чтение кладёт подбор в Redis — дальше проверяется, что запись
		// справочника его обесценивает, а не ждёт истечения срока.
		expect((await listOrganizationOptions(ctx)).map((option) => option.label)).toStrictEqual([
			'Альфа'
		]);

		await createOrganization(ctx, {
			kind: 'educational_institution',
			educationLevel: 'vo',
			legalName: 'Федеральное государственное учреждение высшего образования',
			shortName: 'Бета',
			inn: null,
			kpp: null,
			ogrn: null,
			region: 'Москва',
			website: null,
			notes: null,
			isActive: true,
			externalSource: null,
			externalId: null
		});

		expect((await listOrganizationOptions(ctx)).map((option) => option.label)).toStrictEqual([
			'Альфа',
			'Бета'
		]);
	});

	it('показывает человека, заведённого сервисом, сразу же — и убирает обезличенного', async () => {
		const ctx = testActor();
		await insertPerson(database.db, { lastName: 'Сидоров' });

		expect((await listPersonOptions(ctx)).map((option) => option.label)).toStrictEqual([
			'Сидоров Тест'
		]);

		const added = await createPerson(ctx, {
			lastName: 'Кузнецов',
			firstName: 'Пётр',
			middleName: null,
			email: 'kuznetsov@vuz.ru',
			phone: '+7 999 123-45-67',
			notes: null
		});

		expect((await listPersonOptions(ctx)).map((option) => option.label)).toStrictEqual([
			'Кузнецов Пётр',
			'Сидоров Тест'
		]);

		await anonymizePerson(ctx, added.id);

		// Обезличенного в подборе нет: выбирать контактом того, чьи данные
		// уничтожены, незачем, и ждать этого минуту тоже.
		expect((await listPersonOptions(ctx)).map((option) => option.label)).toStrictEqual([
			'Сидоров Тест'
		]);
	});

	it('не отдаёт подбор одной области доступа другой', async () => {
		const admin = testActor();
		const mine = await insertOrganizationDirectly('Свой вуз');
		await insertOrganizationDirectly('Чужой вуз');

		// Администратор собирает подбор первым и кладёт его в кэш.
		expect((await listOrganizationOptions(admin)).map((option) => option.label)).toStrictEqual([
			'Свой вуз',
			'Чужой вуз'
		]);

		const curator = await scopedActor(database.db, {
			roleId: 'manager',
			organizationIds: [mine]
		});

		expect((await listOrganizationOptions(curator)).map((option) => option.label)).toStrictEqual([
			'Свой вуз'
		]);
	});

	it('перестаёт предлагать вуз прежнему ответственному сразу после снятия', async () => {
		const mine = await insertOrganizationDirectly('Свой вуз');
		const curator = await scopedActor(database.db, {
			roleId: 'manager',
			organizationIds: [mine]
		});

		expect((await listOrganizationOptions(curator)).map((option) => option.label)).toStrictEqual([
			'Свой вуз'
		]);

		// Назначение закрыто мимо сервиса: ключ кэша считается по самим
		// действующим назначениям, поэтому ответ меняется в ту же секунду, а не
		// по сроку жизни записи в Redis.
		await database.db
			.update(organizationResponsibles)
			.set({ validTo: sql`now()` })
			.where(
				and(
					eq(organizationResponsibles.organizationId, mine),
					isNull(organizationResponsibles.validTo)
				)
			);

		expect(await listOrganizationOptions(curator)).toStrictEqual([]);
	});

	it('держит подбор людей отдельно от подбора организаций', async () => {
		const ctx = testActor();
		await insertOrganizationDirectly('Альфа');
		await insertPerson(database.db, { lastName: 'Сидоров' });

		expect((await listPersonOptions(ctx)).map((option) => option.label)).toStrictEqual([
			'Сидоров Тест'
		]);

		await insertPerson(database.db, { lastName: 'Кузнецов' });

		// Своя часть ключа: организации и люди обесцениваются вместе, но
		// подбираются по-разному, и общая запись выдала бы одно за другое.
		expect((await listPersonOptions(ctx)).map((option) => option.label)).toStrictEqual([
			'Сидоров Тест'
		]);
		expect((await listOrganizationOptions(ctx)).map((option) => option.label)).toStrictEqual([
			'Альфа'
		]);
	});
});

/** Взаимодействие, по которому «давно ничего не происходило». */
async function settledInteraction(): Promise<string> {
	const { interactionId } = await insertInteractionWithStage(database.db, {
		ownerUserId: TEST_USER_IDS.admin
	});

	await database.db
		.update(interactions)
		.set({ lastActivityAt: sql`now() - interval '1 hour'` })
		.where(eq(interactions.id, interactionId));

	return interactionId;
}

describe('кэш карточки взаимодействия', () => {
	it('отдаёт ленту комментариев из кэша и обновляет её командой движка', async () => {
		const ctx = testActor();
		const interactionId = await settledInteraction();

		await database.db
			.insert(comments)
			.values({ interactionId, authorId: TEST_USER_IDS.admin, body: 'Первый разговор' });

		expect((await listComments(ctx, interactionId)).map((row) => row.body)).toStrictEqual([
			'Первый разговор'
		]);

		await database.db
			.insert(comments)
			.values({ interactionId, authorId: TEST_USER_IDS.admin, body: 'Мимо сервиса' });

		expect((await listComments(ctx, interactionId)).map((row) => row.body)).toStrictEqual([
			'Первый разговор'
		]);

		// Команда движка двигает момент последнего события — вместе с ним
		// меняется поколение, и лента собирается заново целиком.
		await addComment(ctx, { interactionId, body: 'Через сервис' });

		expect((await listComments(ctx, interactionId)).map((row) => row.body)).toStrictEqual([
			'Через сервис',
			'Мимо сервиса',
			'Первый разговор'
		]);
	});

	it('возвращает из кэша даты датами, а не строками', async () => {
		const ctx = testActor();
		const interactionId = await settledInteraction();

		await database.db
			.insert(comments)
			.values({ interactionId, authorId: TEST_USER_IDS.admin, body: 'Первый разговор' });

		const [fromDatabase] = await listComments(ctx, interactionId);
		const [fromCache] = await listComments(ctx, interactionId);

		expect(fromCache.createdAt).toBeInstanceOf(Date);
		expect(fromCache.createdAt.getTime()).toBe(fromDatabase.createdAt.getTime());
	});

	it('кэширует историю правок и различает её с лентой комментариев', async () => {
		const ctx = testActor();
		const interactionId = await settledInteraction();

		await database.db.insert(interactionChanges).values({
			interactionId,
			authorId: TEST_USER_IDS.admin,
			field: 'title',
			oldValue: 'Было',
			newValue: 'Стало'
		});

		const first = await listInteractionChanges(ctx, interactionId);

		expect(first.map((row) => row.field)).toStrictEqual(['title']);
		expect(first[0].changedAt).toBeInstanceOf(Date);

		await database.db.insert(interactionChanges).values({
			interactionId,
			authorId: TEST_USER_IDS.admin,
			field: 'ownerUserId',
			oldValue: null,
			newValue: TEST_USER_IDS.admin
		});

		expect(
			(await listInteractionChanges(ctx, interactionId)).map((row) => row.field)
		).toStrictEqual(['title']);
		expect((await listComments(ctx, interactionId)).map((row) => row.body)).toStrictEqual([]);
	});

	it('не кэширует запись, по которой только что работали', async () => {
		const ctx = testActor();
		const { interactionId } = await insertInteractionWithStage(database.db, {
			ownerUserId: TEST_USER_IDS.admin
		});

		// Момент последнего события — сейчас, и точности `Date` не хватило бы,
		// чтобы отличить два события внутри одной миллисекунды. Пока запись
		// свежая, чтение идёт мимо кэша.
		expect(await listComments(ctx, interactionId)).toStrictEqual([]);

		await database.db
			.insert(comments)
			.values({ interactionId, authorId: TEST_USER_IDS.admin, body: 'Сразу же' });

		expect((await listComments(ctx, interactionId)).map((row) => row.body)).toStrictEqual([
			'Сразу же'
		]);
	});

	it('кэширует общую половину карточки и возвращает даты датами', async () => {
		const ctx = testActor();
		const interactionId = await settledInteraction();

		const first = await getInteraction(ctx, interactionId);

		expect(first.title).toBe('Тестовое взаимодействие');
		expect(first.createdAt).toBeInstanceOf(Date);

		await database.db
			.update(interactions)
			.set({ title: 'Правка мимо сервиса' })
			.where(eq(interactions.id, interactionId));

		const second = await getInteraction(ctx, interactionId);

		expect(second.title).toBe('Тестовое взаимодействие');
		expect(second.createdAt).toBeInstanceOf(Date);
		expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
	});

	it('читает стороны из базы даже на попадании в кэш: след просмотра контактов обязан остаться', async () => {
		const ctx = testActor();
		const interactionId = await settledInteraction();

		const organizationId = await insertOrganizationDirectly('Вуз со стороной');
		const personId = await insertPerson(database.db, { lastName: 'Контактов' });

		const [affiliation] = await database.db
			.insert(affiliations)
			.values({
				personId,
				organizationId,
				position: 'Проректор',
				roleKind: 'vice_rector',
				validFrom: '2026-01-01'
			})
			.returning({ id: affiliations.id });

		await database.db.insert(interactionParties).values({
			interactionId,
			organizationId,
			partyRole: 'educational_institution',
			isPrimary: true,
			contactAffiliationId: affiliation.id
		});

		for (const pass of [1, 2]) {
			const view = await getInteraction(ctx, interactionId);

			expect(view.parties[0].contact?.email, `проход ${pass}`).toBe('test@example.org');
		}

		const trace = await database.db
			.select({ id: auditEvents.id })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'people.pii_viewed'));

		// Два открытия — два события: кэш ускоряет ответ, но не отменяет закон.
		expect(trace).toHaveLength(2);
	});

	it('не показывает данные обезличенного человека, даже собрав карточку до этого', async () => {
		const ctx = testActor();

		// Заявка физического лица: контрагент назван его ФИО, и то же ФИО стоит в
		// заголовке взаимодействия (`exchange/intake.ts`).
		const personId = await insertPerson(database.db, { lastName: 'Соловьёв' });
		const [counterparty] = await database.db
			.insert(organizations)
			.values({
				kind: 'individual',
				personId,
				legalName: 'Соловьёв Тест',
				shortName: 'Соловьёв Тест'
			})
			.returning({ id: organizations.id });

		const interactionId = await settledInteraction();

		await database.db
			.update(interactions)
			.set({ title: 'Заявка: Соловьёв Тест' })
			.where(eq(interactions.id, interactionId));

		await database.db.insert(interactionParties).values({
			interactionId,
			organizationId: counterparty.id,
			partyRole: 'customer',
			isPrimary: true
		});

		expect((await getInteraction(ctx, interactionId)).title).toBe('Заявка: Соловьёв Тест');

		await anonymizePerson(ctx, personId);

		// Обезличивание переписывает заголовок, но момента последнего события по
		// записи не двигает — работы по ней не было. Поколение области обязано
		// обесценить собранное само, иначе карточка до минуты отдаёт из Redis то,
		// что объявлено уничтоженным.
		const after = await getInteraction(ctx, interactionId);

		expect(after.title).not.toContain('Соловьёв');
		expect(after.title).toBe(`Заявка: ${ANONYMIZED_PERSON_LAST_NAME}`);
	});

	it('не отдаёт карточку тому, кто её не видит, даже когда она уже в кэше', async () => {
		const owner = testActor();
		const interactionId = await settledInteraction();

		await database.db
			.insert(comments)
			.values({ interactionId, authorId: TEST_USER_IDS.admin, body: 'Служебная заметка' });

		expect(await listComments(owner, interactionId)).toHaveLength(1);

		const stranger = await scopedActor(database.db, {
			roleId: 'manager',
			organizationIds: [await insertOrganizationDirectly('Чужой вуз')]
		});

		// Видимость проверяется по базе до всякого кэша, и чужая запись отвечает
		// «не найдено», а не отказом.
		await expect(listComments(stranger, interactionId)).rejects.toThrow('не найдено');
	});
});

describe('ключи кэша', () => {
	it('лежат под общим префиксом, по одному на область и запись', async () => {
		const ctx = testActor();
		await insertOrganizationDirectly('Альфа');
		await listOrganizationOptions(ctx);

		const keys = await getRedis().keys('lct:cache:*');

		expect(keys).toStrictEqual(['lct:cache:directory-options:0:all:all:organizations']);
	});

	it('у карточки несут версию состава, поколение области, запись и момент события', async () => {
		const ctx = testActor();
		const interactionId = await settledInteraction();

		await getInteraction(ctx, interactionId);

		const [key] = await getRedis().keys('lct:cache:interaction-card:*');
		const [, , , shape, epoch, id] = key.split(':');

		// Версия состава стоит первой: собранное прежним кодом обязано перестать
		// находиться сразу после выката, а не через минуту.
		expect(shape).toMatch(/^\d+$/);
		// Поколение области — следом: без него обезличивание, которое не двигает
		// момент последнего события, не смогло бы обесценить собранное.
		expect(epoch).toBe('0');
		expect(id).toBe(interactionId);
		expect(key.endsWith(':base')).toBe(true);
	});
});

/** Процесс учебных заведений: его читают карточка, список и доска. */
async function demoProcess(): Promise<void> {
	await database.db.transaction((tx) => ensureProcess(tx, B2B_WORKSPACE_KEY, B2B_PROCESS));
}

/** Черновик с переименованной первой стадией, применённый ко всем. */
async function publishRenamedFirstStage(ctx: ActorContext, name: string): Promise<void> {
	const draft = await createDraft(ctx, B2B_WORKSPACE_KEY);
	const definition = processDefinition(draft);

	await updateDraft(ctx, B2B_WORKSPACE_KEY, {
		...definition,
		stages: definition.stages.map((stage, index) => (index === 0 ? { ...stage, name } : stage))
	});
	await publishProcess(ctx, B2B_WORKSPACE_KEY);
}

describe('кэш действующей редакции процесса', () => {
	async function activeRevision() {
		return readActiveRevisionCached(await readWorkspaceByKey(database.db, B2B_WORKSPACE_KEY));
	}

	it('отдаёт то же, что база, и переживает правку в обход сервиса', async () => {
		await demoProcess();

		const before = await activeRevision();

		expect(before?.stages[0].name).toBeDefined();

		await database.db
			.update(stages)
			.set({ name: 'Переименовано мимо сервиса' })
			.where(eq(stages.revisionId, before!.id));

		// Ответ из Redis: правку, сделанную мимо публикации, он не видит.
		expect((await activeRevision())?.stages[0].name).toBe(before!.stages[0].name);
	});

	it('после применения изменённого процесса читатель видит новую редакцию', async () => {
		await demoProcess();

		const ctx = testActor();
		const before = await activeRevision();

		expect(before?.stages[0].name).not.toBe('Поиск контактов заново');

		await publishRenamedFirstStage(ctx, 'Поиск контактов заново');

		// Публикация — единственная точка, где структура меняется, и она же
		// обесценивает кэш: без сброса читатель целую минуту показывал бы стадии
		// редакции, которая уже не действует.
		expect((await activeRevision())?.stages[0].name).toBe('Поиск контактов заново');
	});
});

describe('кэш списков фильтров отчёта', () => {
	it('отдаёт то же, что база, и обесценивается записью в справочник', async () => {
		const ctx = testActor();
		await insertOrganizationDirectly('Альфа');

		expect(
			(await readFilterOptions(ctx)).organizations.map((option) => option.label)
		).toStrictEqual(['Альфа']);

		await insertOrganizationDirectly('Бета');

		// Ответ из Redis: заведённой мимо сервиса организации в нём нет.
		expect(
			(await readFilterOptions(ctx)).organizations.map((option) => option.label)
		).toStrictEqual(['Альфа']);

		await invalidateDirectoryOptions();

		expect(
			(await readFilterOptions(ctx)).organizations.map((option) => option.label)
		).toStrictEqual(['Альфа', 'Бета']);
	});

	it('после применения изменённого процесса называет стадии по-новому', async () => {
		const ctx = testActor();
		await demoProcess();

		const before = await readFilterOptions(ctx);

		expect(before.stages.map((option) => option.label)).not.toContain('Поиск контактов заново');

		await publishRenamedFirstStage(ctx, 'Поиск контактов заново');

		// Поколение процесса стоит в имени записи кэша: публикация меняет имя, и
		// списки собираются заново, не дожидаясь срока жизни.
		expect((await readFilterOptions(ctx)).stages.map((option) => option.label)).toContain(
			'Поиск контактов заново'
		);
	});
});
