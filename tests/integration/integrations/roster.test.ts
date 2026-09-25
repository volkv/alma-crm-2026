// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
import { vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import { and, eq } from 'drizzle-orm';
import { formatIsoDay } from '$lib/format';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	affiliations,
	auditEvents,
	consents,
	exchangeMessages,
	interactionPrograms,
	learningGroupLearners,
	people,
	programs
} from '$lib/server/db/schema';
import { createPerson } from '$lib/server/directory/write';
import { requestLearningGroup } from '$lib/server/integrations/exchange/groups';
import {
	exportLearningGroupRoster,
	importLearningGroupRoster,
	previewLearningGroupRoster,
	readRosterFile,
	removeLearner,
	sendLearningGroupRoster
} from '$lib/server/integrations/exchange/roster';
import { setExchangeSettings } from '$lib/server/integrations/settings';
import { anonymizePerson } from '$lib/server/people/retention';
import { getRedis } from '$lib/server/redis';
import { B2B_PROCESS, B2B_WORKSPACE_KEY } from '$lib/server/stages/definitions';
import { ensureWorkflow } from '$lib/server/stages/process';
import { createInteractionOn } from '../stages/fixture';
import { startMockLms } from '../../../mocks/mock-lms/service.ts';
import type { MockService } from '../../../mocks/shared/http.ts';
import { startTestDatabase, testActor, TEST_USER_IDS, type TestDatabase } from '../helpers/db';

/**
 * Поимённый список группы: человек узнаётся по почте, дубль файла и уже
 * заведённый человек второй записи не дают, список уходит в систему обучения
 * заявкой на ту же группу, а обезличивание убирает человека и из списка, и из
 * отправленного конверта.
 */
let database: TestDatabase;
let lms: MockService;

const SECRET = 'stand-secret';

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
	});

	lms = await startMockLms({ port: 0, exchangeSecret: SECRET });

	await setExchangeSettings(testActor(), {
		cmsInstance: 'itschool-site',
		cmsStatusUrl: '',
		cmsSecret: null,
		cmsDefaultOwnerUserId: TEST_USER_IDS.manager,
		lmsInstance: 'moodle-itschool',
		lmsGroupsUrl: `${lms.url}/api/groups`,
		lmsSecret: SECRET
	});
});

afterEach(async () => {
	await lms?.stop();
});

/** Список, каким его присылает деканат: CSV с разделителем «;». */
const ROSTER = [
	'ФИО;Почта;Телефон',
	'Иванов Иван Иванович;ivanov@vuz.example;+7 999 111-22-33',
	// Уже в справочнике — под этим адресом в другом регистре.
	'Петрова Анна;PETROVA@vuz.example;',
	'Сидоров Пётр;sidorov@vuz.example;',
	// Дубль почты в файле: загрузится только первая строка.
	'Сидоров Пётр Петрович; Sidorov@VUZ.example ;',
	';empty@vuz.example;',
	'Козлов Олег;not-an-email;'
].join('\n');

const file = () => ({ name: 'поток-1.csv', bytes: new TextEncoder().encode(ROSTER) });

describe('поимённый список слушателей', () => {
	it('не плодит людей, связывает найденных и уходит в систему обучения снимком', async () => {
		const { interactionId, organizationId } = await createInteractionOn(testActor(), database);
		const [program] = await database.db
			.insert(programs)
			.values({ code: 'P-ROSTER', name: 'Программа', level: 'bachelor', status: 'active' })
			.returning({ id: programs.id });

		await database.db.insert(interactionPrograms).values({ interactionId, programId: program.id });

		const group = await requestLearningGroup(testActor(), {
			interactionId,
			streamNumber: 1,
			plannedSeats: 30,
			startsOn: null,
			endsOn: null,
			programId: null,
			productIds: [],
			purpose: 'students'
		});
		const input = { interactionId, learningGroupId: group.learningGroupId };

		const existing = await createPerson(testActor(), {
			lastName: 'Петрова',
			firstName: 'Анна',
			middleName: null,
			email: 'petrova@vuz.example',
			phone: null,
			notes: null
		});

		const preview = await previewLearningGroupRoster(testActor(), input, file());

		expect(preview.counts).toEqual({ create: 2, link: 1, present: 0, error: 3 });
		expect(preview.rows.find((row) => row.rowNo === 5)?.issues).toContain(
			'Почта повторяет строку 4: загрузится только первая'
		);
		// Предпросмотр ничего не пишет.
		expect(await database.db.select().from(learningGroupLearners)).toHaveLength(0);

		await importLearningGroupRoster(testActor(), input, file());
		const again = await importLearningGroupRoster(testActor(), input, file());

		// Повтор того же файла: все трое уже в группе, новых людей и связей нет.
		expect(again.counts).toEqual({ create: 0, link: 0, present: 3, error: 3 });
		expect(await database.db.select({ id: people.id }).from(people)).toHaveLength(3);

		const links = await database.db
			.select({ personId: learningGroupLearners.personId })
			.from(learningGroupLearners);

		expect(links).toHaveLength(3);
		expect(links.map((link) => link.personId)).toContain(existing.id);

		// Новые люди — с основанием «договор», найденная — без чужого основания;
		// роль в вузе у всех троих.
		const bases = await database.db.select({ basis: consents.basis }).from(consents);

		expect(bases).toEqual([{ basis: 'contract' }, { basis: 'contract' }]);
		expect(
			await database.db
				.select({ id: affiliations.id })
				.from(affiliations)
				.where(eq(affiliations.organizationId, organizationId))
		).toHaveLength(3);

		const sent = await sendLearningGroupRoster(testActor(), input);

		expect(sent.delivered).toBe(true);

		const [message] = await database.db
			.select({ envelope: exchangeMessages.envelope })
			.from(exchangeMessages)
			.where(eq(exchangeMessages.id, sent.messageId));
		const envelope = JSON.parse(message.envelope!) as {
			schemaVersion: string;
			data: { externalId: string; learners: { personId: string; email: string }[] };
		};

		expect(envelope.schemaVersion).toBe('2.1');
		expect(envelope.data.externalId).toBe(`crm-group-${interactionId}-1`);
		expect(envelope.data.learners.map((learner) => learner.email).sort()).toEqual([
			'ivanov@vuz.example',
			'petrova@vuz.example',
			'sidorov@vuz.example'
		]);
		expect(
			await database.db
				.select()
				.from(learningGroupLearners)
				.where(eq(learningGroupLearners.status, 'transferred'))
		).toHaveLength(3);

		const state = (await (await fetch(`${lms.url}/__state`)).json()) as {
			objects: { groups: { learnerCount: number | null }[] };
		};

		// Та же группа, а не вторая, и состав у неё — снимок из трёх человек.
		expect(state.objects.groups).toHaveLength(1);
		expect(state.objects.groups[0].learnerCount).toBe(3);

		// Обезличивание убирает человека из списка и стирает отправленный конверт.
		const ivanov = envelope.data.learners.find(
			(learner) => learner.email === 'ivanov@vuz.example'
		)!;

		await anonymizePerson(testActor(), ivanov.personId);

		expect(
			await database.db
				.select()
				.from(learningGroupLearners)
				.where(eq(learningGroupLearners.personId, ivanov.personId))
		).toHaveLength(0);

		const [erased] = await database.db
			.select({ envelope: exchangeMessages.envelope })
			.from(exchangeMessages)
			.where(and(eq(exchangeMessages.id, sent.messageId)));

		expect(erased.envelope).toBeNull();
	});

	it('пустой состав уходит после переданного, а ждущая старая передача гасится новой', async () => {
		const { interactionId } = await createInteractionOn(testActor(), database);
		const [program] = await database.db
			.insert(programs)
			.values({ code: 'P-EMPTY', name: 'Программа', level: 'bachelor', status: 'active' })
			.returning({ id: programs.id });

		await database.db.insert(interactionPrograms).values({ interactionId, programId: program.id });
		const group = await requestLearningGroup(testActor(), {
			interactionId,
			streamNumber: 1,
			plannedSeats: 30,
			startsOn: null,
			endsOn: null,
			programId: null,
			productIds: [],
			purpose: 'students'
		});
		const input = { interactionId, learningGroupId: group.learningGroupId };

		// Пока состав не передавали, пустой список уходить не должен.
		await expect(sendLearningGroupRoster(testActor(), input)).rejects.toThrowError(
			'Список не передан'
		);

		await importLearningGroupRoster(testActor(), input, file());
		expect((await sendLearningGroupRoster(testActor(), input)).delivered).toBe(true);

		// Старая передача того же состава ждёт повтора: её отложенный повтор
		// затёр бы новый состав.
		const [stale] = await database.db
			.insert(exchangeMessages)
			.values({
				direction: 'outbound',
				system: 'lms',
				instance: 'moodle-itschool',
				eventType: 'learning_group.requested',
				eventId: crypto.randomUUID(),
				externalId: `crm-group-${interactionId}-1`,
				interactionId,
				state: 'retrying',
				attempt: 1,
				nextAttemptAt: new Date(Date.now() + 3_600_000),
				payload: { interactionId, streamNumber: 1, plannedSeats: 30, includeLearners: true }
			})
			.returning({ id: exchangeMessages.id });

		for (const link of await database.db.select().from(learningGroupLearners)) {
			await removeLearner(testActor(), { ...input, personId: link.personId });
		}

		const empty = await sendLearningGroupRoster(testActor(), input);

		expect(empty.delivered).toBe(true);

		const [sentEmpty] = await database.db
			.select({ envelope: exchangeMessages.envelope })
			.from(exchangeMessages)
			.where(eq(exchangeMessages.id, empty.messageId));

		expect(
			(JSON.parse(sentEmpty.envelope!) as { data: { learners: unknown } }).data.learners
		).toEqual([]);

		const [dismissed] = await database.db
			.select({ state: exchangeMessages.state, lastError: exchangeMessages.lastError })
			.from(exchangeMessages)
			.where(eq(exchangeMessages.id, stale.id));

		expect(dismissed.state).toBe('dismissed');
		expect(dismissed.lastError).toContain('заменено новой передачей состава');

		const state = (await (await fetch(`${lms.url}/__state`)).json()) as {
			objects: { groups: { learnerCount: number | null }[] };
		};

		expect(state.objects.groups[0].learnerCount).toBe(0);
	});
	it('отозвавший согласие не уходит ни в выгрузку для LMS, ни в передачу списка', async () => {
		const { interactionId } = await createInteractionOn(testActor(), database);
		const [program] = await database.db
			.insert(programs)
			.values({ code: 'P-CONSENT', name: 'Программа', level: 'bachelor', status: 'active' })
			.returning({ id: programs.id });

		await database.db.insert(interactionPrograms).values({ interactionId, programId: program.id });
		const group = await requestLearningGroup(testActor(), {
			interactionId,
			streamNumber: 1,
			plannedSeats: 30,
			startsOn: null,
			endsOn: null,
			programId: null,
			productIds: [],
			purpose: 'students'
		});
		const input = { interactionId, learningGroupId: group.learningGroupId };

		await importLearningGroupRoster(testActor(), input, file());

		const [ivanov] = await database.db
			.select({ id: people.id })
			.from(people)
			.where(eq(people.lastName, 'Иванов'));

		await database.db
			.update(consents)
			.set({ withdrawnAt: formatIsoDay() })
			.where(eq(consents.personId, ivanov.id));

		const exported = await exportLearningGroupRoster(testActor(), input);
		const book = readRosterFile(exported.fileName, exported.body);

		expect(exported.skippedCount).toBe(1);
		expect(book.rows.map((row) => row.email?.toLowerCase()).sort()).toEqual([
			'petrova@vuz.example',
			'sidorov@vuz.example'
		]);

		const [event] = await database.db
			.select({ details: auditEvents.details })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'exchange.roster_exported'));

		expect(event.details).toMatchObject({ rowCount: 2, skippedCount: 1 });

		const sent = await sendLearningGroupRoster(testActor(), input);
		const [message] = await database.db
			.select({ envelope: exchangeMessages.envelope })
			.from(exchangeMessages)
			.where(eq(exchangeMessages.id, sent.messageId));
		const envelope = JSON.parse(message.envelope!) as {
			data: { learners: { personId: string }[] };
		};

		expect(envelope.data.learners).toHaveLength(2);
		expect(envelope.data.learners.map((learner) => learner.personId)).not.toContain(ivanov.id);
	});
});
