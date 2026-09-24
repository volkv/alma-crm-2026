// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
import { vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EXCHANGE_SCHEMA_VERSION, type LearningGroupResultMessage } from '$lib/contracts/exchange';
import {
	auditEvents,
	exchangeMessages,
	interactionProducts,
	interactions,
	interactionPrograms,
	learningGroupProducts,
	learningGroups,
	products,
	programs,
	stageEntries
} from '$lib/server/db/schema';
import { runExchangeCycle } from '$lib/server/integrations/exchange/delivery';
import {
	listLearningGroups,
	markLearningGroupCompleted,
	requestLearningGroup
} from '$lib/server/integrations/exchange/groups';
import { receiveLearningGroupResult } from '$lib/server/integrations/exchange/results';
import { setExchangeSettings } from '$lib/server/integrations/settings';
import { getRedis } from '$lib/server/redis';
import { advanceStage } from '$lib/server/stages/commands';
import { B2B_PROCESS, B2B_WORKSPACE_KEY } from '$lib/server/stages/definitions';
import { ensureWorkflow } from '$lib/server/stages/process';
import { getInteractionStatus } from '$lib/server/stages/status';
import { LMS_NOT_COMPLETED } from '$lib/server/stages/transitions';
import {
	activeRevision,
	advanceTo,
	closeRequiredChecklist,
	createInteractionOn,
	stageId
} from '../stages/fixture';
import { startMockLms } from '../../../mocks/mock-lms/service.ts';
import type { MockService } from '../../../mocks/shared/http.ts';
import { startTestDatabase, testActor, TEST_USER_IDS, type TestDatabase } from '../helpers/db';

/**
 * Учебная группа закрепляет, что и для кого обучается, а стадию подтверждает
 * итог обучения нужной группы.
 *
 * Имитатор системы обучения поднят в этом же процессе: заявка уходит по сети и
 * возвращает имя группы так же, как на стенде. Результат подаётся прямо в
 * приёмник — сеть в обратную сторону проверяет `exchange.test.ts`, здесь
 * проверяются правила: что считается итогом, какая группа нужная и сколько
 * раз стадия подтверждается.
 */
let database: TestDatabase;
let lms: MockService;

const SECRET = 'stand-secret';
const INSTANCE = 'moodle-itschool';

/** Действующее лицо ключа обмена: роль `service` и ничего сверх её прав. */
const serviceActor = () => testActor({ roleId: 'service' });

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
		lmsInstance: INSTANCE,
		lmsGroupsUrl: `${lms.url}/api/groups`,
		lmsSecret: SECRET
	});
});

afterEach(async () => {
	await lms?.stop();
});

type Offering = { id: string; code: string };

async function insertProgram(): Promise<Offering> {
	const code = `P-${crypto.randomUUID().slice(0, 8)}`;
	const [row] = await database.db
		.insert(programs)
		.values({ code, name: `Программа ${code}`, level: 'bachelor', status: 'active' })
		.returning({ id: programs.id });

	return { id: row.id, code };
}

async function insertProduct(): Promise<Offering> {
	const code = `RT-${crypto.randomUUID().slice(0, 8)}`;
	const [row] = await database.db
		.insert(products)
		.values({ code, name: `Продукт ${code}`, status: 'active' })
		.returning({ id: products.id });

	return { id: row.id, code };
}

/** Взаимодействие с вузом и заданным составом программ и продуктов. */
async function interactionWith(options: { programs: number; products: number }): Promise<{
	interactionId: string;
	programs: Offering[];
	products: Offering[];
}> {
	const { interactionId } = await createInteractionOn(testActor(), database);
	const programList: Offering[] = [];
	const productList: Offering[] = [];

	for (let index = 0; index < options.programs; index += 1) {
		const program = await insertProgram();

		await database.db.insert(interactionPrograms).values({ interactionId, programId: program.id });
		programList.push(program);
	}

	for (let index = 0; index < options.products; index += 1) {
		const product = await insertProduct();

		await database.db.insert(interactionProducts).values({ interactionId, productId: product.id });
		productList.push(product);
	}

	return { interactionId, programs: programList, products: productList };
}

/** Поток, заведённый заявкой: имя группы выдаёт имитатор системы обучения. */
async function requestGroup(
	interactionId: string,
	options: { streamNumber?: number; programId?: string | null; productIds?: string[] } = {}
): Promise<{ learningGroupId: string; groupExternalId: string; requestKey: string }> {
	const streamNumber = options.streamNumber ?? 1;
	const outcome = await requestLearningGroup(testActor(), {
		interactionId,
		streamNumber,
		plannedSeats: 45,
		startsOn: '2026-10-01',
		endsOn: '2027-05-31',
		programId: options.programId ?? null,
		productIds: options.productIds ?? [],
		purpose: 'students'
	});

	expect(outcome.delivered).toBe(true);

	const [group] = await database.db
		.select({ groupExternalId: learningGroups.groupExternalId })
		.from(learningGroups)
		.where(eq(learningGroups.id, outcome.learningGroupId));

	expect(group.groupExternalId).not.toBeNull();

	return {
		learningGroupId: outcome.learningGroupId,
		groupExternalId: group.groupExternalId!,
		requestKey: `crm-group-${interactionId}-${streamNumber}`
	};
}

function resultMessage(
	group: { groupExternalId: string; requestKey: string },
	options: {
		occurredAt: string;
		completed: number;
		finishedOn: string | null;
		eventId?: string;
	}
): LearningGroupResultMessage {
	return {
		schemaVersion: EXCHANGE_SCHEMA_VERSION,
		eventId: options.eventId ?? crypto.randomUUID(),
		eventType: 'learning_group.result',
		occurredAt: options.occurredAt,
		source: { system: 'lms', instance: INSTANCE },
		data: {
			groupExternalId: group.groupExternalId,
			requestExternalId: group.requestKey,
			period: { start: '2026-10-01', end: '2027-05-31' },
			finishedOn: options.finishedOn,
			counters: { enrolled: 45, completed: options.completed, expelled: 2 },
			report: null
		}
	};
}

async function openEntry(interactionId: string) {
	const [entry] = await database.db
		.select()
		.from(stageEntries)
		.where(and(eq(stageEntries.interactionId, interactionId), isNull(stageEntries.leftAt)));

	return entry;
}

/** Сколько раз стадию подтверждали фактом этой группы. */
async function confirmationsBy(learningGroupId: string): Promise<number> {
	const rows = await database.db
		.select({ id: auditEvents.id })
		.from(auditEvents)
		.where(
			and(
				eq(auditEvents.eventType, 'interactions.confirmed'),
				sql`${auditEvents.details} ->> 'learningGroupId' = ${learningGroupId}`
			)
		);

	return rows.length;
}

/** Шаг вперёд с «Ведения занятий»: его запрещает незавершённое обучение. */
async function leaveClasses(interactionId: string): Promise<void> {
	const revision = await activeRevision(database, B2B_WORKSPACE_KEY);
	const status = await getInteractionStatus(testActor(), interactionId);

	await closeRequiredChecklist(testActor(), interactionId);
	await advanceStage(testActor(), {
		interactionId,
		revision: status.revision,
		fromStageId: stageId(revision, 'classes'),
		toStageId: stageId(revision, 'documentation_update'),
		reason: null,
		resultText: 'Занятия проведены',
		checklistState: {}
	});
}

describe('что закрепляет группа', () => {
	it('при двух программах требует выбора и закрепляет выбранную, а не первую', async () => {
		const {
			interactionId,
			programs: offered,
			products: goods
		} = await interactionWith({
			programs: 2,
			products: 2
		});

		const refusal = await requestLearningGroup(testActor(), {
			interactionId,
			streamNumber: 1,
			plannedSeats: 45,
			startsOn: null,
			endsOn: null,
			programId: null,
			productIds: [],
			purpose: 'teachers'
		}).catch((error: unknown) => error);

		expect(refusal).toMatchObject({
			code: 'validation',
			issues: [
				'Выберите программу группы: у взаимодействия их несколько',
				'Выберите продукты группы: у взаимодействия их несколько'
			]
		});
		// Отказ не оставляет ни группы, ни сообщения в очереди.
		expect(await database.db.select().from(learningGroups)).toHaveLength(0);
		expect(await database.db.select().from(exchangeMessages)).toHaveLength(0);

		const chosen = offered[1];
		const product = goods[1];

		await requestLearningGroup(testActor(), {
			interactionId,
			streamNumber: 1,
			plannedSeats: 45,
			startsOn: null,
			endsOn: null,
			programId: chosen.id,
			productIds: [product.id],
			purpose: 'teachers'
		});

		const [group] = await listLearningGroups(testActor(), interactionId);

		expect(group).toMatchObject({
			program: { id: chosen.id, code: chosen.code },
			products: [{ id: product.id, code: product.code }],
			purpose: 'teachers',
			trainingState: 'awaiting',
			// Программа та, но «Ведение занятий» засчитывает только поток
			// студентов: итог потока преподавателей занятий не доказывает.
			countsForStage: false
		});

		// В систему обучения ушло именно выбранное: и в конверте, и у получателя.
		const [message] = await database.db
			.select({ envelope: exchangeMessages.envelope })
			.from(exchangeMessages)
			.where(eq(exchangeMessages.eventType, 'learning_group.requested'));
		const sent = JSON.parse(message.envelope!) as {
			schemaVersion: string;
			data: Record<string, unknown>;
		};

		expect(sent.schemaVersion).toBe(EXCHANGE_SCHEMA_VERSION);
		// Состав продуктов ездит только списком: одиночного поля в заявке нет.
		expect(sent.data).not.toHaveProperty('product');
		expect(sent.data).toMatchObject({
			program: { id: chosen.id, code: chosen.code },
			products: [{ id: product.id, code: product.code }],
			purpose: 'teachers'
		});

		const state = (await (await fetch(`${lms.url}/__state`)).json()) as {
			objects: { groups: { programCode: string; productCodes: string[]; purpose: string }[] };
		};

		expect(state.objects.groups[0]).toMatchObject({
			programCode: chosen.code,
			productCodes: [product.code],
			purpose: 'teachers'
		});
	});

	it('не принимает программу и продукт, которых нет у взаимодействия', async () => {
		const { interactionId } = await interactionWith({ programs: 2, products: 1 });
		const stranger = await insertProgram();
		const strangerProduct = await insertProduct();

		await expect(
			requestLearningGroup(testActor(), {
				interactionId,
				streamNumber: 1,
				plannedSeats: 10,
				startsOn: null,
				endsOn: null,
				programId: stranger.id,
				productIds: [strangerProduct.id],
				purpose: 'students'
			})
		).rejects.toMatchObject({
			code: 'validation',
			issues: [
				'Выбранная программа не входит во взаимодействие',
				'Выбранный продукт не входит во взаимодействие'
			]
		});
	});

	it('единственную программу и продукт подставляет сам, без программы не заводит', async () => {
		const single = await interactionWith({ programs: 1, products: 1 });

		await requestGroup(single.interactionId);

		const [group] = await listLearningGroups(testActor(), single.interactionId);

		expect(group.program?.id).toBe(single.programs[0].id);
		expect(group.products.map((product) => product.id)).toEqual([single.products[0].id]);

		// Без программы непонятно, что обучается: заявка не уходит, кнопка
		// объясняет почему.
		const bare = await interactionWith({ programs: 0, products: 0 });

		await expect(
			requestLearningGroup(testActor(), {
				interactionId: bare.interactionId,
				streamNumber: 1,
				plannedSeats: 10,
				startsOn: null,
				endsOn: null,
				programId: null,
				productIds: [],
				purpose: 'students'
			})
		).rejects.toMatchObject({
			code: 'validation',
			issues: [
				'У взаимодействия нет программы обучения: добавьте её в карточке — группа заводится по программе'
			]
		});
	});

	it('собирает тело заявки из группы и тогда, когда отправка пошла повтором', async () => {
		const { interactionId, programs: offered } = await interactionWith({
			programs: 2,
			products: 0
		});

		// Система обучения недоступна: заявка остаётся в очереди, тело соберёт
		// цикл доставки — и собрать его обязан из строки группы.
		await fetch(`${lms.url}/__scenario`, {
			method: 'POST',
			body: JSON.stringify({ failNext: 1, status: 503 })
		});

		const outcome = await requestLearningGroup(testActor(), {
			interactionId,
			streamNumber: 1,
			plannedSeats: 10,
			startsOn: null,
			endsOn: null,
			programId: offered[0].id,
			productIds: [],
			purpose: 'upskilling'
		});

		expect(outcome.delivered).toBe(false);

		await database.db
			.update(exchangeMessages)
			.set({ nextAttemptAt: sql`now()` })
			.where(eq(exchangeMessages.id, outcome.messageId));
		await runExchangeCycle(testActor());

		const [message] = await database.db
			.select({ state: exchangeMessages.state, envelope: exchangeMessages.envelope })
			.from(exchangeMessages)
			.where(eq(exchangeMessages.id, outcome.messageId));

		expect(message.state).toBe('sent');
		expect(JSON.parse(message.envelope!).data).toMatchObject({
			program: { id: offered[0].id },
			products: [],
			purpose: 'upskilling'
		});
	});
});

describe('что подтверждает стадию', () => {
	/** Взаимодействие на «Ведении занятий» с заведённым потоком. */
	async function atClasses(): Promise<{
		interactionId: string;
		group: Awaited<ReturnType<typeof requestGroup>>;
	}> {
		const { interactionId } = await interactionWith({ programs: 1, products: 0 });
		const group = await requestGroup(interactionId);

		await advanceTo(testActor(), database, interactionId, 'classes');

		return { interactionId, group };
	}

	it('промежуточный результат — «данные получены», но стадию не подтверждает', async () => {
		const { interactionId, group } = await atClasses();

		// Выпускников ещё нет.
		const early = await receiveLearningGroupResult(
			serviceActor(),
			resultMessage(group, { occurredAt: '2027-01-10T06:00:00Z', completed: 0, finishedOn: null })
		);
		// Числа есть, а даты окончания нет — поток не закончен.
		const partial = await receiveLearningGroupResult(
			serviceActor(),
			resultMessage(group, { occurredAt: '2027-03-10T06:00:00Z', completed: 20, finishedOn: null })
		);

		for (const response of [early, partial]) {
			expect(response.result).toBe('created');
			expect(response.data.stageConfirmed).toBe(false);
			expect(response.data.note).toMatch(/обучение не завершено/);
		}

		const entry = await openEntry(interactionId);

		expect(entry.lmsEvidence).toBeNull();
		expect(entry.confirmation).toBeNull();

		const [view] = await listLearningGroups(testActor(), interactionId);

		expect(view).toMatchObject({ trainingState: 'in_progress', completed: 20, finishedOn: null });

		await expect(leaveClasses(interactionId)).rejects.toSatisfy(
			(error: unknown) => error instanceof Error && error.message.includes(LMS_NOT_COMPLETED)
		);
	});

	it('итоговый результат подтверждает, а повтор и следующий итог — не плодят подтверждений', async () => {
		const { interactionId, group } = await atClasses();
		const eventId = crypto.randomUUID();
		const final = resultMessage(group, {
			occurredAt: '2027-05-21T06:00:00Z',
			completed: 38,
			finishedOn: '2027-05-20',
			eventId
		});

		const first = await receiveLearningGroupResult(serviceActor(), final);

		expect(first.data.stageConfirmed).toBe(true);

		const confirmed = await openEntry(interactionId);

		expect(confirmed.lmsEvidence).toMatchObject({
			kind: 'result',
			completed: 38,
			finishedOn: '2027-05-20',
			occurredAt: '2027-05-21T06:00:00.000Z'
		});
		expect(confirmed.confirmation).toMatchObject({
			kind: 'lms_record',
			recordId: group.groupExternalId
		});

		// Тот же `eventId` — сохранённый ответ, ничего не применяется заново.
		const replay = await receiveLearningGroupResult(serviceActor(), final);

		expect(replay.result).toBe('unchanged');

		// Более свежий итог — новая строка истории, но не второе подтверждение.
		const later = await receiveLearningGroupResult(
			serviceActor(),
			resultMessage(group, {
				occurredAt: '2027-06-01T06:00:00Z',
				completed: 39,
				finishedOn: '2027-05-31'
			})
		);

		expect(later.result).toBe('created');
		expect(later.data.stageConfirmed).toBe(false);
		expect(later.data.note).toMatch(/уже подтверждена/);

		const after = await openEntry(interactionId);

		expect(after.lmsEvidence).toMatchObject({ occurredAt: '2027-05-21T06:00:00.000Z' });
		expect(after.confirmedAt?.getTime()).toBe(confirmed.confirmedAt?.getTime());
		expect(await confirmationsBy(group.learningGroupId)).toBe(1);

		await leaveClasses(interactionId);
	});

	it('итог другого взаимодействия и чужого потока стадию не подтверждает', async () => {
		const { interactionId, group } = await atClasses();
		const other = await interactionWith({ programs: 1, products: 0 });
		const foreign = await requestGroup(other.interactionId);

		const response = await receiveLearningGroupResult(
			serviceActor(),
			resultMessage(foreign, {
				occurredAt: '2027-05-21T06:00:00Z',
				completed: 38,
				finishedOn: '2027-05-20'
			})
		);

		// Итог засчитан тому взаимодействию, чья группа, — нашего не касается.
		expect(response.data.interactionId).toBe(other.interactionId);
		expect((await openEntry(interactionId)).lmsEvidence).toBeNull();

		// Итог второго потока, названный ключом заявки первого, — это не наш
		// поток: результат отвергается целиком, и ничего не подтверждается.
		const second = await requestGroup(interactionId, { streamNumber: 2 });

		await expect(
			receiveLearningGroupResult(
				serviceActor(),
				resultMessage(
					{ groupExternalId: second.groupExternalId, requestKey: group.requestKey },
					{ occurredAt: '2027-05-21T06:00:00Z', completed: 38, finishedOn: '2027-05-20' }
				)
			)
		).rejects.toMatchObject({ code: 'conflict' });

		expect((await openEntry(interactionId)).lmsEvidence).toBeNull();
		expect(await confirmationsBy(second.learningGroupId)).toBe(0);
	});

	it('группа по программе, которую из взаимодействия убрали, стадию не подтверждает', async () => {
		const { interactionId, group } = await atClasses();

		await database.db
			.delete(interactionPrograms)
			.where(eq(interactionPrograms.interactionId, interactionId));

		const response = await receiveLearningGroupResult(
			serviceActor(),
			resultMessage(group, {
				occurredAt: '2027-05-21T06:00:00Z',
				completed: 38,
				finishedOn: '2027-05-20'
			})
		);

		expect(response.data.stageConfirmed).toBe(false);
		expect(response.data.note).toMatch(/программа группы не входит/);
		expect((await openEntry(interactionId)).lmsEvidence).toBeNull();

		const [view] = await listLearningGroups(testActor(), interactionId);

		expect(view).toMatchObject({ trainingState: 'completed', countsForStage: false });
	});

	it('итог, пришедший до входа на стадию, засчитывается при входе', async () => {
		const { interactionId } = await interactionWith({ programs: 1, products: 0 });
		const group = await requestGroup(interactionId);

		await receiveLearningGroupResult(
			serviceActor(),
			resultMessage(group, {
				occurredAt: '2027-05-21T06:00:00Z',
				completed: 38,
				finishedOn: '2027-05-20'
			})
		);

		await advanceTo(testActor(), database, interactionId, 'classes');

		const entry = await openEntry(interactionId);

		expect(entry.stageSnapshot.key).toBe('classes');
		expect(entry.lmsEvidence).toMatchObject({
			kind: 'result',
			learningGroupId: group.learningGroupId
		});
		expect(entry.confirmation).toMatchObject({
			kind: 'lms_record',
			recordId: group.groupExternalId
		});
	});

	it('отметка «обучение завершено» подтверждает стадию один раз и остаётся в журнале', async () => {
		const { interactionId, group } = await atClasses();

		await receiveLearningGroupResult(
			serviceActor(),
			resultMessage(group, { occurredAt: '2027-01-10T06:00:00Z', completed: 0, finishedOn: null })
		);

		const outcome = await markLearningGroupCompleted(testActor(), {
			interactionId,
			learningGroupId: group.learningGroupId,
			comment: 'Итоговая ведомость пришла бумагой: 38 из 45 завершили'
		});

		expect(outcome.confirmed).toBe(true);

		const entry = await openEntry(interactionId);

		expect(entry.lmsEvidence).toMatchObject({
			kind: 'manual',
			learningGroupId: group.learningGroupId,
			markedByUserId: TEST_USER_IDS.admin,
			comment: 'Итоговая ведомость пришла бумагой: 38 из 45 завершили'
		});
		expect(entry.confirmation).toMatchObject({ kind: 'mark', byUserId: TEST_USER_IDS.admin });

		const journal = await database.db
			.select({ details: auditEvents.details })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'exchange.group_completed'));

		expect(journal).toEqual([{ details: { learningGroupId: group.learningGroupId } }]);

		const [view] = await listLearningGroups(testActor(), interactionId);

		expect(view).toMatchObject({
			trainingState: 'completed',
			completionMark: { comment: 'Итоговая ведомость пришла бумагой: 38 из 45 завершили' }
		});

		// Вторая отметка — отказ, а не второе подтверждение.
		await expect(
			markLearningGroupCompleted(testActor(), {
				interactionId,
				learningGroupId: group.learningGroupId,
				comment: 'Ещё раз'
			})
		).rejects.toMatchObject({ code: 'conflict' });
		expect(await confirmationsBy(group.learningGroupId)).toBe(1);

		await leaveClasses(interactionId);
	});

	it('отметка не нужна там, где итог уже пришёл, и не ставится без права', async () => {
		const { interactionId, group } = await atClasses();

		await receiveLearningGroupResult(
			serviceActor(),
			resultMessage(group, {
				occurredAt: '2027-05-21T06:00:00Z',
				completed: 38,
				finishedOn: '2027-05-20'
			})
		);

		await expect(
			markLearningGroupCompleted(testActor(), {
				interactionId,
				learningGroupId: group.learningGroupId,
				comment: 'Обучение закончилось'
			})
		).rejects.toMatchObject({ code: 'conflict' });

		await expect(
			markLearningGroupCompleted(testActor({ permissions: ['interactions.read'] }), {
				interactionId,
				learningGroupId: group.learningGroupId,
				comment: 'Обучение закончилось'
			})
		).rejects.toMatchObject({ code: 'forbidden' });

		expect(
			await database.db
				.select({ id: learningGroups.id })
				.from(learningGroups)
				.where(sql`${learningGroups.completionMarkedAt} is not null`)
		).toHaveLength(0);
		expect(await database.db.select().from(learningGroupProducts)).toHaveLength(0);
	});

	/**
	 * Ручная отметка держит взаимодействие и ждёт группу; приём итога, взявший
	 * группу раньше взаимодействия, ждал бы взаимодействие — PostgreSQL нашёл бы
	 * взаимную блокировку и уронил одну из команд. Порядок общий: взаимодействие,
	 * затем группа.
	 *
	 * Порядок подстроен явно. Третья транзакция держит строку взаимодействия;
	 * отметка встаёт за ней первой, итог — вторым. Когда держатель отпускает
	 * строку, её получает отметка и идёт за группой: при обратном порядке у
	 * приёма группа была бы уже его.
	 */
	it('ручная отметка и итог из системы обучения не встают во взаимную блокировку', async () => {
		const { interactionId, group } = await atClasses();

		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		let taken: () => void = () => {};
		const locked = new Promise<void>((resolve) => (taken = resolve));

		const holder = database.db.transaction(async (tx) => {
			await tx
				.select({ id: interactions.id })
				.from(interactions)
				.where(eq(interactions.id, interactionId))
				.for('update');
			taken();
			await held;
		});

		await locked;

		const mark = markLearningGroupCompleted(testActor(), {
			interactionId,
			learningGroupId: group.learningGroupId,
			comment: 'Итоговая ведомость пришла бумагой'
		});
		await waitForLockWaiters(1);

		const result = receiveLearningGroupResult(
			serviceActor(),
			resultMessage(group, {
				occurredAt: '2027-05-21T06:00:00Z',
				completed: 38,
				finishedOn: '2027-05-20'
			})
		);
		await waitForLockWaiters(2);

		release();
		await holder;

		const [marked, received] = await Promise.allSettled([mark, result]);

		// Оба исхода предметные: отметка подтвердила стадию, итог сохранён и
		// второго подтверждения не дал.
		expect(marked).toMatchObject({ status: 'fulfilled', value: { confirmed: true } });
		expect(received).toMatchObject({
			status: 'fulfilled',
			value: { result: 'created', data: { stageConfirmed: false } }
		});
		expect(await confirmationsBy(group.learningGroupId)).toBe(1);
	});
});

/** Сколько соединений базы этого файла ждут блокировку. */
async function lockWaiters(): Promise<number> {
	const [row] = await database.raw<{ waiting: number }[]>`
		select count(*)::int as waiting
		from pg_stat_activity
		where datname = current_database() and wait_event_type = 'Lock'
	`;

	return row.waiting;
}

/** Ждёт, пока в очереди блокировок встанет `count` команд. */
async function waitForLockWaiters(count: number): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if ((await lockWaiters()) >= count) {
			return;
		}

		await new Promise((resolve) => setTimeout(resolve, 25));
	}

	throw new Error(`В очереди блокировок так и не встало ${count} команд`);
}
