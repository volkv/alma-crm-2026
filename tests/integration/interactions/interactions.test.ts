/**
 * Взаимодействие целиком: заведение со сторонами и составом, правка плана,
 * список с фильтрами и область доступа. Проверяется на настоящей базе — область
 * доступа живёт в SQL, а история правок опирается на внешние ключи.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInteractionSchema, updateInteractionSchema } from '$lib/contracts/interactions';
import {
	auditEvents,
	interactionChanges,
	interactions,
	products,
	programs
} from '$lib/server/db/schema';
import { ConflictError, ForbiddenError, NotFoundError } from '$lib/server/errors';
import {
	getInteraction,
	listInteractionChanges,
	listInteractions
} from '$lib/server/interactions/read';
import { getInteractionSummary } from '$lib/server/interactions/summary';
import { createInteraction, updateInteraction } from '$lib/server/interactions/write';
import { B2B_GROUP_KEY, B2B_PROCESS, B2C_GROUP_KEY } from '$lib/server/stages/definitions';
import {
	createDraft,
	ensureProcess,
	processDefinition,
	publishProcess,
	resolveProcessGroup,
	updateDraft
} from '$lib/server/stages/process';
import {
	cancelInteraction,
	completeInteraction,
	setResponsible
} from '$lib/server/stages/commands';
import { getInteractionStatus } from '$lib/server/stages/status';
import { interactionListQuerySchema } from '$lib/contracts/interactions';
import type { ActorContext } from '$lib/server/actor';
import {
	insertOrganization,
	insertUser,
	startTestDatabase,
	scopedActor,
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

afterAll(async () => {
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();
});

const admin = (): ActorContext => testActor({ roleId: 'admin' });
const emptyQuery = interactionListQuerySchema.parse({});

/** Процесс учебных заведений: без него взаимодействие завести нельзя. */
async function demoProcess(): Promise<string> {
	return database.db.transaction((tx) => ensureProcess(tx, B2B_GROUP_KEY, B2B_PROCESS));
}

async function insertProgram(code: string): Promise<string> {
	const [row] = await database.db
		.insert(programs)
		.values({ code, name: `Программа ${code}`, level: 'bachelor', status: 'active' })
		.returning({ id: programs.id });

	return row.id;
}

async function insertProduct(code: string): Promise<string> {
	const [row] = await database.db
		.insert(products)
		.values({ code, name: `Продукт ${code}`, status: 'active' })
		.returning({ id: products.id });

	return row.id;
}

describe('заведение взаимодействия', () => {
	it('сохраняет стороны, состав и сразу ставит на первую стадию', async () => {
		const ctx = admin();
		await demoProcess();
		const institutionId = await insertOrganization(database.db, { shortName: 'СЗПУ' });
		const customerId = await insertOrganization(database.db, {
			shortName: 'Северный центр цифровых компетенций'
		});
		const programId = await insertProgram('09.03.01');
		const productId = await insertProduct('LMS-1');

		const created = await createInteraction(
			ctx,
			createInteractionSchema.parse({
				title: 'Подготовка по информационной безопасности',
				ownerUserId: TEST_USER_IDS.admin,
				agreementPeriodStart: '2026-09-01',
				agreementPeriodEnd: '2027-06-30',
				parties: [
					{ organizationId: institutionId, partyRole: 'educational_institution', isPrimary: true },
					{ organizationId: customerId, partyRole: 'customer' }
				],
				programs: [{ programId }],
				productIds: [productId]
			})
		);

		const card = await getInteraction(ctx, created.id);
		const status = await getInteractionStatus(ctx, created.id);

		expect(card.parties.map((party) => party.organizationName).sort()).toEqual([
			'СЗПУ',
			'Северный центр цифровых компетенций'
		]);
		expect(card.programs[0].code).toBe('09.03.01');
		expect(card.products[0].code).toBe('LMS-1');
		expect(card.agreementPeriodStart).toBe('2026-09-01');
		expect(status.current?.snapshot.position).toBe(1);
	});

	it('отказывает словами, когда процесс группы ещё не описан', async () => {
		const ctx = admin();
		// Заводим процесс только учебным заведениям; у физических и юридических
		// лиц его нет, и отказ обязан сказать об этом, а не упасть на пустой ленте.
		await demoProcess();

		const organizationId = await insertOrganization(database.db, {
			shortName: 'Заказчик без процесса',
			kind: 'legal_entity'
		});

		await expect(
			createInteraction(
				ctx,
				createInteractionSchema.parse({
					title: 'Обучение без процесса',
					ownerUserId: TEST_USER_IDS.admin,
					parties: [{ organizationId, partyRole: 'customer', isPrimary: true }]
				})
			)
		).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof ConflictError && /процесс ещё не описан/.test(error.message)
		);
	});

	it('выводит группу процесса из вида основной стороны', async () => {
		const ctx = admin();
		await demoProcess();

		const institutionId = await insertOrganization(database.db, { shortName: 'Вуз' });
		const created = await createInteraction(
			ctx,
			createInteractionSchema.parse({
				title: 'Работа с вузом',
				ownerUserId: TEST_USER_IDS.admin,
				parties: [
					{ organizationId: institutionId, partyRole: 'educational_institution', isPrimary: true }
				]
			})
		);

		const card = await getInteraction(ctx, created.id);

		expect(card.processGroupKey).toBe(B2B_GROUP_KEY);
		// Та же таблица соответствий, что и у приёма заявки: второго правила
		// выбора группы в продукте нет.
		expect((await resolveProcessGroup(database.db, 'legal_entity')).key).toBe(B2C_GROUP_KEY);
		await expect(resolveProcessGroup(database.db, 'operator')).rejects.toThrow(
			/не может быть основной стороной/
		);
	});
});

describe('область доступа при заведении', () => {
	/** Менеджер, который ведёт ровно перечисленные вузы, и его идентификатор. */
	async function managerFor(
		organizationIds: readonly string[]
	): Promise<{ ctx: ActorContext; userId: string }> {
		const userId = await insertUser(database.db, { roleId: 'manager' });
		const ctx = await scopedActor(database.db, { roleId: 'manager', userId, organizationIds });

		return { ctx, userId };
	}

	it('спрашивает область только с основной стороны', async () => {
		await demoProcess();
		const institutionId = await insertOrganization(database.db, { shortName: 'Свой вуз' });
		const customerId = await insertOrganization(database.db, {
			shortName: 'Заказчик',
			kind: 'customer_company'
		});
		const operatorId = await insertOrganization(database.db, {
			shortName: 'Оператор',
			kind: 'operator'
		});

		const { ctx: manager, userId: managerId } = await managerFor([institutionId]);

		// Обычный образец из сидов: вуз, заказчик и организация-оператор.
		// Ответственного у оператора и плательщика не бывает вовсе, поэтому
		// требование области от каждой стороны запрещало бы менеджеру завести
		// самую обычную запись.
		const created = await createInteraction(
			manager,
			createInteractionSchema.parse({
				title: 'Подготовка с заказчиком и оператором',
				ownerUserId: managerId,
				parties: [
					{ organizationId: institutionId, partyRole: 'educational_institution', isPrimary: true },
					{ organizationId: customerId, partyRole: 'customer' },
					{ organizationId: operatorId, partyRole: 'operator' }
				]
			})
		);

		const card = await getInteraction(manager, created.id);

		expect(card.parties.map((party) => party.organizationName).sort()).toEqual([
			'Заказчик',
			'Оператор',
			'Свой вуз'
		]);
	});

	it('отказывает, когда вне области основная сторона', async () => {
		await demoProcess();
		const mine = await insertOrganization(database.db, { shortName: 'Свой вуз' });
		const theirs = await insertOrganization(database.db, { shortName: 'Чужой вуз' });

		const { ctx: manager, userId: managerId } = await managerFor([mine]);

		// Свой вуз участником не выручает: процесс ведётся с основной стороной,
		// и область спрашивается именно с неё.
		await expect(
			createInteraction(
				manager,
				createInteractionSchema.parse({
					title: 'Чужая работа',
					ownerUserId: managerId,
					parties: [
						{ organizationId: theirs, partyRole: 'educational_institution', isPrimary: true },
						{ organizationId: mine, partyRole: 'customer' }
					]
				})
			)
		).rejects.toBeInstanceOf(NotFoundError);
	});

	it('даёт дописать сторону, не переспрашивая про неизменённую основную', async () => {
		await demoProcess();
		const institutionId = await insertOrganization(database.db, { shortName: 'Свой вуз' });
		const customerId = await insertOrganization(database.db, {
			shortName: 'Заказчик',
			kind: 'customer_company'
		});
		const operatorId = await insertOrganization(database.db, {
			shortName: 'Оператор',
			kind: 'operator'
		});

		const { ctx: manager, userId: managerId } = await managerFor([institutionId]);

		const created = await createInteraction(
			manager,
			createInteractionSchema.parse({
				title: 'Состав дополняется по ходу',
				ownerUserId: managerId,
				parties: [
					{ organizationId: institutionId, partyRole: 'educational_institution', isPrimary: true },
					{ organizationId: customerId, partyRole: 'customer' }
				]
			})
		);

		// Правка состава присылает список целиком, и основная сторона в нём та
		// же: проверять её заново незачем, а оператор в область не входит ни у
		// кого, кроме полного доступа.
		const updated = await updateInteraction(
			manager,
			updateInteractionSchema.parse({
				id: created.id,
				title: 'Состав дополняется по ходу',
				ownerUserId: managerId,
				reason: 'Добавили организацию-оператора',
				parties: [
					{ organizationId: institutionId, partyRole: 'educational_institution', isPrimary: true },
					{ organizationId: customerId, partyRole: 'customer' },
					{ organizationId: operatorId, partyRole: 'operator' }
				]
			})
		);

		expect(updated.parties.map((party) => party.organizationName).sort()).toEqual([
			'Заказчик',
			'Оператор',
			'Свой вуз'
		]);
	});
});

describe('правка плана', () => {
	it('пишет изменения полей в предметную историю', async () => {
		const ctx = admin();
		await demoProcess();
		const organizationId = await insertOrganization(database.db, { shortName: 'Вуз' });

		const created = await createInteraction(
			ctx,
			createInteractionSchema.parse({
				title: 'Первое название',
				ownerUserId: TEST_USER_IDS.admin,
				parties: [{ organizationId, partyRole: 'educational_institution', isPrimary: true }]
			})
		);

		await updateInteraction(
			ctx,
			updateInteractionSchema.parse({
				id: created.id,
				title: 'Второе название',
				ownerUserId: TEST_USER_IDS.admin,
				agreementPeriodStart: '2026-10-01',
				agreementPeriodEnd: '2027-05-31',
				reason: 'Вуз попросил сдвинуть сроки',
				parties: [{ organizationId, partyRole: 'educational_institution', isPrimary: true }]
			})
		);

		const changes = await database.db
			.select()
			.from(interactionChanges)
			.where(eq(interactionChanges.interactionId, created.id));

		const fields = changes.map((change) => change.field).sort();

		expect(fields).toEqual(['agreementPeriodEnd', 'agreementPeriodStart', 'title']);
		expect(changes.every((change) => change.reason === 'Вуз попросил сдвинуть сроки')).toBe(true);
		expect((await getInteraction(ctx, created.id)).title).toBe('Второе название');
	});

	it('записывает смену ответственного и переносит её на текущую стадию', async () => {
		const ctx = admin();
		await demoProcess();
		const organizationId = await insertOrganization(database.db);

		const created = await createInteraction(
			ctx,
			createInteractionSchema.parse({
				title: 'Смена ответственного',
				ownerUserId: TEST_USER_IDS.admin,
				parties: [{ organizationId, partyRole: 'educational_institution', isPrimary: true }]
			})
		);

		const changed = await setResponsible(ctx, {
			interactionIds: [created.id],
			userId: TEST_USER_IDS.manager
		});

		const status = await getInteractionStatus(ctx, created.id);
		const [change] = await database.db
			.select()
			.from(interactionChanges)
			.where(eq(interactionChanges.interactionId, created.id));

		expect(changed).toBe(1);
		expect((await getInteraction(ctx, created.id)).ownerUserId).toBe(TEST_USER_IDS.manager);
		expect(status.current?.responsibleUserId).toBe(TEST_USER_IDS.manager);
		expect(change.field).toBe('ownerUserId');
		expect(change.newValue).toBe(TEST_USER_IDS.manager);

		// Повторная команда с тем же ответственным ничего не меняет и не плодит
		// записей в истории: «изменение», которого не было, — это шум.
		expect(
			await setResponsible(ctx, { interactionIds: [created.id], userId: TEST_USER_IDS.manager })
		).toBe(0);
	});

	it('пускает к смене владельца только с правом на передачу работы', async () => {
		const ctx = admin();
		await demoProcess();
		const organizationId = await insertOrganization(database.db);

		const created = await createInteraction(
			ctx,
			createInteractionSchema.parse({
				title: 'Передача работы',
				ownerUserId: TEST_USER_IDS.admin,
				parties: [{ organizationId, partyRole: 'educational_institution', isPrimary: true }]
			})
		);

		// Передать чужую работу себе — не то же самое, что вести свою: у
		// менеджера есть `interactions.write`, но не `interactions.reassign`.
		const manager = testActor({ roleId: 'manager' });

		expect(manager.user?.permissions.has('interactions.write')).toBe(true);
		expect(manager.user?.permissions.has('interactions.reassign')).toBe(false);

		await expect(
			setResponsible(manager, { interactionIds: [created.id], userId: TEST_USER_IDS.manager })
		).rejects.toBeInstanceOf(ForbiddenError);

		// Та же дорога через правку плана закрыта тем же правом: новое право,
		// поставленное только на одну команду, оставило бы второй обход.
		const current = await getInteraction(ctx, created.id);

		await expect(
			updateInteraction(manager, {
				id: created.id,
				title: current.title,
				ownerUserId: TEST_USER_IDS.manager,
				agreementPeriodStart: null,
				agreementPeriodEnd: null,
				academicPeriodStart: null,
				academicPeriodEnd: null,
				externalSource: null,
				externalId: null,
				reason: null,
				parties: [
					{
						organizationId,
						partyRole: 'educational_institution',
						isPrimary: true,
						contactAffiliationId: null,
						siteIds: []
					}
				],
				programs: [],
				productIds: []
			})
		).rejects.toBeInstanceOf(ForbiddenError);

		expect((await getInteraction(ctx, created.id)).ownerUserId).toBe(TEST_USER_IDS.admin);

		// У руководителя право есть, и передача проходит вместе со своим событием.
		const lead = testActor({ roleId: 'lead' });

		expect(
			await setResponsible(lead, { interactionIds: [created.id], userId: TEST_USER_IDS.lead })
		).toBe(1);
		expect((await getInteraction(ctx, created.id)).ownerUserId).toBe(TEST_USER_IDS.lead);

		const events = await database.db
			.select({ type: auditEvents.eventType, outcome: auditEvents.outcome })
			.from(auditEvents)
			.where(eq(auditEvents.subjectId, created.id));

		expect(events.filter((event) => event.type === 'interactions.owner_changed')).toEqual([
			{ type: 'interactions.owner_changed', outcome: 'success' }
		]);
	});
});

describe('список и область доступа', () => {
	it('фильтрует, ищет и считает страницу', async () => {
		const ctx = admin();
		await demoProcess();
		const first = await insertOrganization(database.db, { shortName: 'Политех' });
		const second = await insertOrganization(database.db, { shortName: 'Педагогический' });

		for (const [title, organizationId] of [
			['Взаимодействие с политехом', first],
			['Взаимодействие с педагогическим', second]
		] as const) {
			await createInteraction(
				ctx,
				createInteractionSchema.parse({
					title,
					ownerUserId: TEST_USER_IDS.admin,
					parties: [{ organizationId, partyRole: 'educational_institution', isPrimary: true }]
				})
			);
		}

		const all = await listInteractions(ctx, emptyQuery);
		const searched = await listInteractions(
			ctx,
			interactionListQuerySchema.parse({ q: 'Политех' })
		);
		const byCategory = await listInteractions(
			ctx,
			interactionListQuerySchema.parse({ stageCategory: 'contact' })
		);
		const overdue = await listInteractions(
			ctx,
			interactionListQuerySchema.parse({ overdue: 'true' })
		);

		expect(all.total).toBe(2);
		expect(all.items[0].stage?.key).toBe('contact_search');
		expect(all.items[0].progress).toHaveLength(14);
		// Поиск идёт и по названию взаимодействия, и по наименованию стороны.
		expect(searched.total).toBe(1);
		expect(searched.items[0].institutionName).toBe('Политех');
		expect(byCategory.total).toBe(2);
		expect(overdue.total).toBe(0);
	});

	it('держит порядок страниц, когда ключ сортировки у строк одинаковый', async () => {
		const ctx = admin();
		await demoProcess();
		const organizationId = await insertOrganization(database.db, { shortName: 'Политех' });

		for (const title of ['Первое', 'Второе', 'Третье', 'Четвёртое', 'Пятое', 'Шестое']) {
			await createInteraction(
				ctx,
				createInteractionSchema.parse({
					title,
					ownerUserId: TEST_USER_IDS.admin,
					parties: [{ organizationId, partyRole: 'educational_institution', isPrimary: true }]
				})
			);
		}

		// Один и тот же момент последнего события — обычное дело: записи заводят
		// пачкой, импортом, набором. Порядок строк с равным ключом Postgres не
		// обещает вовсе, и без второго ключа страницы разъезжаются.
		await database.db
			.update(interactions)
			.set({ lastActivityAt: new Date('2026-05-01T10:00:00.000Z') });

		const whole = await listInteractions(ctx, interactionListQuerySchema.parse({ pageSize: '50' }));
		const ids = whole.items.map((item) => item.id);

		// Второй ключ — идентификатор: он же делает порядок воспроизводимым.
		expect(ids).toStrictEqual([...ids].sort());

		const paged: string[] = [];

		for (const page of [1, 2, 3, 4, 5, 6]) {
			const slice = await listInteractions(
				ctx,
				interactionListQuerySchema.parse({ page: String(page), pageSize: '1' })
			);

			paged.push(...slice.items.map((item) => item.id));
		}

		// Ни одна запись не показана дважды и ни одна не пропущена.
		expect(paged).toStrictEqual(ids);
		expect(new Set(paged).size).toBe(6);
	});

	it('прячет чужие взаимодействия от пользователя с ограниченной областью', async () => {
		const ctx = admin();
		await demoProcess();
		const mine = await insertOrganization(database.db, { shortName: 'Свой вуз' });
		const theirs = await insertOrganization(database.db, { shortName: 'Чужой вуз' });

		const visible = await createInteraction(
			ctx,
			createInteractionSchema.parse({
				title: 'Своё',
				ownerUserId: TEST_USER_IDS.admin,
				parties: [{ organizationId: mine, partyRole: 'educational_institution', isPrimary: true }]
			})
		);

		const hidden = await createInteraction(
			ctx,
			createInteractionSchema.parse({
				title: 'Чужое',
				ownerUserId: TEST_USER_IDS.admin,
				parties: [{ organizationId: theirs, partyRole: 'educational_institution', isPrimary: true }]
			})
		);

		const limited = await scopedActor(database.db, { roleId: 'manager', organizationIds: [mine] });
		const page = await listInteractions(limited, emptyQuery);

		expect(page.total).toBe(1);
		expect(page.items[0].id).toBe(visible.id);
		// Запись вне области неотличима от несуществующей: иначе перебором
		// идентификаторов видно, что существует за её пределами.
		await expect(getInteraction(limited, hidden.id)).rejects.toBeInstanceOf(NotFoundError);
		await expect(getInteractionStatus(limited, hidden.id)).rejects.toBeInstanceOf(NotFoundError);
		await expect(getInteractionSummary(limited, hidden.id)).rejects.toBeInstanceOf(NotFoundError);
	});

	it('предлагает наблюдателю только то, что ему доступно', async () => {
		const ctx = admin();
		await demoProcess();
		const organizationId = await insertOrganization(database.db);

		const created = await createInteraction(
			ctx,
			createInteractionSchema.parse({
				title: 'Что могу сейчас',
				ownerUserId: TEST_USER_IDS.admin,
				parties: [{ organizationId, partyRole: 'educational_institution', isPrimary: true }]
			})
		);

		const managerSummary = await getInteractionSummary(
			testActor({ roleId: 'manager' }),
			created.id
		);
		const readOnlySummary = await getInteractionSummary(
			testActor({ roleId: 'manager', permissions: ['interactions.read'] }),
			created.id
		);

		expect(managerSummary.canDo.actions).toContain('pause');
		expect(managerSummary.canDo.transitions.some((option) => !option.allowed)).toBe(true);
		// Наблюдателю не предлагается ничего, что он не имеет права сделать.
		expect(readOnlySummary.canDo.actions).toEqual([]);
		expect(readOnlySummary.canDo.transitions.every((option) => !option.allowed)).toBe(true);
	});
});

/**
 * Закрытие взаимодействия по устаревшей карточке.
 *
 * Завершение и отмена принимают решение по финальной стадии и её требованиям,
 * а применение изменённого процесса меняет и то и другое. Поэтому обе команды
 * несут номер редакции, с которой была отрисована карточка, и сверяют его так
 * же, как переход.
 */
describe('закрытие по номеру редакции', () => {
	/** Взаимодействие на первой стадии и номер редакции, с которой оно отрисовано. */
	async function stale(
		ctx: ActorContext,
		title: string
	): Promise<{ interactionId: string; before: number; after: number }> {
		const organizationId = await insertOrganization(database.db);

		const created = await createInteraction(
			ctx,
			createInteractionSchema.parse({
				title,
				ownerUserId: TEST_USER_IDS.admin,
				parties: [{ organizationId, partyRole: 'educational_institution', isPrimary: true }]
			})
		);

		const before = (await getInteractionStatus(ctx, created.id)).revision;

		// Администратор применил изменение процесса: структура та же, редакция
		// другая — ровно тот случай, который одной сверкой стадии не поймать.
		const draft = await createDraft(ctx, B2B_GROUP_KEY);
		await updateDraft(ctx, B2B_GROUP_KEY, processDefinition(draft));
		await publishProcess(ctx, B2B_GROUP_KEY);

		const after = (await getInteractionStatus(ctx, created.id)).revision;

		expect(after).toBe(before + 1);

		return { interactionId: created.id, before, after };
	}

	it('отказывает завершению по прежней редакции и пропускает по текущей', async () => {
		const ctx = admin();
		await demoProcess();
		const { interactionId, before, after } = await stale(ctx, 'Завершение по старой карточке');

		await expect(
			completeInteraction(ctx, {
				interactionId,
				revision: before,
				summary: 'Вуз передумал',
				force: true
			})
		).rejects.toBeInstanceOf(ConflictError);

		// Отказ до единой записи: взаимодействие осталось в работе.
		expect((await getInteraction(ctx, interactionId)).status).toBe('active');

		await completeInteraction(ctx, {
			interactionId,
			revision: after,
			summary: 'Вуз передумал',
			force: true
		});

		expect((await getInteraction(ctx, interactionId)).status).toBe('completed');
	});

	it('отказывает отмене по прежней редакции и пропускает по текущей', async () => {
		const ctx = admin();
		await demoProcess();
		const { interactionId, before, after } = await stale(ctx, 'Отмена по старой карточке');

		await expect(
			cancelInteraction(ctx, {
				interactionId,
				revision: before,
				reason: 'Вуз отказался от программы'
			})
		).rejects.toBeInstanceOf(ConflictError);

		expect((await getInteraction(ctx, interactionId)).status).toBe('active');

		await cancelInteraction(ctx, {
			interactionId,
			revision: after,
			reason: 'Вуз отказался от программы'
		});

		expect((await getInteraction(ctx, interactionId)).status).toBe('cancelled');
	});
});

/**
 * Подписи ссылочных значений в истории правок.
 *
 * В `interaction_changes` лежат идентификаторы: по ним считается, что
 * поменялось. На экране идентификатор не объясняет ничего, поэтому имена
 * разрешаются на весь список сразу, а запись, которой не стало, честно
 * называется недоступной.
 */
describe('история правок: имена вместо идентификаторов', () => {
	it('подписывает ответственного, стороны, программы и продукты', async () => {
		const ctx = admin();
		await demoProcess();
		const institutionId = await insertOrganization(database.db, { shortName: 'СЗПУ' });
		const customerId = await insertOrganization(database.db, { shortName: 'Заказчик' });
		const programId = await insertProgram('09.03.01');
		const productId = await insertProduct('LMS-1');
		const successor = await insertUser(database.db, { roleId: 'manager' });

		const created = await createInteraction(
			ctx,
			createInteractionSchema.parse({
				title: 'История с именами',
				ownerUserId: TEST_USER_IDS.admin,
				parties: [
					{ organizationId: institutionId, partyRole: 'educational_institution', isPrimary: true }
				]
			})
		);

		await updateInteraction(
			ctx,
			updateInteractionSchema.parse({
				id: created.id,
				title: 'История с именами',
				ownerUserId: successor,
				reason: 'Передали работу и дополнили состав',
				parties: [
					{ organizationId: institutionId, partyRole: 'educational_institution', isPrimary: true },
					{ organizationId: customerId, partyRole: 'customer' }
				],
				programs: [{ programId }],
				productIds: [productId]
			})
		);

		const byField = new Map(
			(await listInteractionChanges(ctx, created.id)).map((change) => [change.field, change])
		);

		expect(byField.get('ownerUserId')?.newLabel).toBe('Тестовый Пользователь');
		expect(byField.get('parties')?.oldLabel).toBe('СЗПУ (учебное заведение)');
		expect(byField.get('parties')?.newLabel).toBe(
			'СЗПУ (учебное заведение), Заказчик (компания-заказчик)'
		);
		expect(byField.get('programs')?.oldLabel).toBe('—');
		expect(byField.get('programs')?.newLabel).toBe('Программа 09.03.01');
		expect(byField.get('products')?.newLabel).toBe('Продукт LMS-1');

		// Название ссылкой не является: подписывать нечего, и показывается само
		// значение.
		expect(byField.get('title')).toBeUndefined();
	});

	it('называет недоступной запись, которой не стало', async () => {
		const ctx = admin();
		await demoProcess();
		const organizationId = await insertOrganization(database.db, { shortName: 'СЗПУ' });
		const productId = await insertProduct('LMS-OLD');

		const created = await createInteraction(
			ctx,
			createInteractionSchema.parse({
				title: 'История с удалённым продуктом',
				ownerUserId: TEST_USER_IDS.admin,
				parties: [{ organizationId, partyRole: 'educational_institution', isPrimary: true }],
				productIds: [productId]
			})
		);

		await updateInteraction(
			ctx,
			updateInteractionSchema.parse({
				id: created.id,
				title: 'История с удалённым продуктом',
				ownerUserId: TEST_USER_IDS.admin,
				reason: 'Продукт убрали из состава',
				parties: [{ organizationId, partyRole: 'educational_institution', isPrimary: true }],
				productIds: []
			})
		);

		await database.db.delete(products).where(eq(products.id, productId));

		const [change] = (await listInteractionChanges(ctx, created.id)).filter(
			(row) => row.field === 'products'
		);

		// Сырой идентификатор на экран не выходит: он ничего не объясняет и
		// никуда не ведёт.
		expect(change.oldLabel).toBe('недоступно');
		expect(change.newLabel).toBe('—');
	});
});
