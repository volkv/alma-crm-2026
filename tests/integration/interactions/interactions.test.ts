/**
 * Взаимодействие целиком: заведение со сторонами и составом, правка плана,
 * список с фильтрами и область доступа. Проверяется на настоящей базе — область
 * доступа живёт в SQL, а история правок опирается на внешние ключи.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInteractionSchema, updateInteractionSchema } from '$lib/contracts/interactions';
import { interactionChanges, products, programs } from '$lib/server/db/schema';
import { ConflictError, ForbiddenError, NotFoundError } from '$lib/server/errors';
import { getInteraction, listInteractions } from '$lib/server/interactions/read';
import { getInteractionSummary } from '$lib/server/interactions/summary';
import { createInteraction, updateInteraction } from '$lib/server/interactions/write';
import { createRoute, ensureDemoRoute, publishRoute, updateRoute } from '$lib/server/stages/routes';
import { setResponsible } from '$lib/server/stages/commands';
import { getInteractionStatus } from '$lib/server/stages/status';
import { interactionListQuerySchema } from '$lib/contracts/interactions';
import type { ActorContext } from '$lib/server/actor';
import {
	insertOrganization,
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

afterAll(async () => {
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();
});

const admin = (): ActorContext => testActor({ roleId: 'admin' });
const emptyQuery = interactionListQuerySchema.parse({});

async function demoRoute(): Promise<string> {
	return database.db.transaction((tx) => ensureDemoRoute(tx));
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
		const routeId = await demoRoute();
		const institutionId = await insertOrganization(database.db, { shortName: 'МГТУ' });
		const customerId = await insertOrganization(database.db, { shortName: 'РТК ИТ' });
		const programId = await insertProgram('09.03.01');
		const productId = await insertProduct('LMS-1');

		const created = await createInteraction(
			ctx,
			createInteractionSchema.parse({
				title: 'Подготовка по информационной безопасности',
				routeId,
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

		expect(card.parties.map((party) => party.organizationName).sort()).toEqual(['МГТУ', 'РТК ИТ']);
		expect(card.programs[0].code).toBe('09.03.01');
		expect(card.products[0].code).toBe('LMS-1');
		expect(card.agreementPeriodStart).toBe('2026-09-01');
		expect(status.current?.snapshot.position).toBe(1);
	});

	it('не ставит взаимодействие на неопубликованный маршрут', async () => {
		const ctx = admin();
		const organizationId = await insertOrganization(database.db);

		const draft = await createRoute(ctx, {
			key: 'draft-route',
			name: 'Черновик маршрута',
			description: null,
			isDefault: false,
			stages: [
				{
					key: 'only',
					name: 'Единственная стадия',
					category: 'contact',
					slaDays: 5,
					staleAfterDays: null,
					requiresResult: false,
					requiresConfirmation: false,
					checklist: []
				}
			],
			transitions: []
		});

		await expect(
			createInteraction(
				ctx,
				createInteractionSchema.parse({
					title: 'На черновике',
					routeId: draft.id,
					ownerUserId: TEST_USER_IDS.admin,
					parties: [{ organizationId, partyRole: 'educational_institution', isPrimary: true }]
				})
			)
		).rejects.toBeInstanceOf(ConflictError);
	});
});

describe('маршрут стадий', () => {
	it('правится черновиком и замораживается публикацией', async () => {
		const ctx = admin();

		const draft = await createRoute(ctx, {
			key: 'custom-route',
			name: 'Свой маршрут',
			description: 'Проверка неизменяемости',
			isDefault: false,
			stages: [
				{
					key: 'first',
					name: 'Первая стадия',
					category: 'contact',
					slaDays: 5,
					staleAfterDays: null,
					requiresResult: false,
					requiresConfirmation: false,
					checklist: []
				}
			],
			transitions: []
		});

		const definition = {
			id: draft.id,
			key: draft.key,
			name: 'Свой маршрут, второе имя',
			description: null,
			isDefault: false,
			stages: [
				{
					key: 'first',
					name: 'Первая стадия',
					category: 'contact' as const,
					slaDays: 8,
					staleAfterDays: null,
					requiresResult: false,
					requiresConfirmation: false,
					checklist: []
				}
			],
			transitions: []
		};

		const updated = await updateRoute(ctx, definition);
		expect(updated.stages[0].slaDays).toBe(8);

		const published = await publishRoute(ctx, draft.id);
		expect(published.publishedAt).not.toBeNull();

		// После публикации маршрут — свидетельство: по нему уже сделаны слепки
		// стадий, и правка задним числом переписала бы историю.
		await expect(updateRoute(ctx, definition)).rejects.toBeInstanceOf(ConflictError);
		await expect(publishRoute(ctx, draft.id)).rejects.toBeInstanceOf(ConflictError);
	});

	it('настраивается только с правом на настройку', async () => {
		const manager = testActor({ roleId: 'manager' });

		await expect(
			createRoute(manager, {
				key: 'forbidden',
				name: 'Чужой маршрут',
				description: null,
				isDefault: false,
				stages: [
					{
						key: 'only',
						name: 'Стадия',
						category: 'contact',
						slaDays: 5,
						staleAfterDays: null,
						requiresResult: false,
						requiresConfirmation: false,
						checklist: []
					}
				],
				transitions: []
			})
		).rejects.toBeInstanceOf(ForbiddenError);
	});
});

describe('правка плана', () => {
	it('пишет изменения полей в предметную историю', async () => {
		const ctx = admin();
		const routeId = await demoRoute();
		const organizationId = await insertOrganization(database.db, { shortName: 'Вуз' });

		const created = await createInteraction(
			ctx,
			createInteractionSchema.parse({
				title: 'Первое название',
				routeId,
				ownerUserId: TEST_USER_IDS.admin,
				parties: [{ organizationId, partyRole: 'educational_institution', isPrimary: true }]
			})
		);

		await updateInteraction(
			ctx,
			updateInteractionSchema.parse({
				id: created.id,
				title: 'Второе название',
				routeId,
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
		const routeId = await demoRoute();
		const organizationId = await insertOrganization(database.db);

		const created = await createInteraction(
			ctx,
			createInteractionSchema.parse({
				title: 'Смена ответственного',
				routeId,
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
});

describe('список и область доступа', () => {
	it('фильтрует, ищет и считает страницу', async () => {
		const ctx = admin();
		const routeId = await demoRoute();
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
					routeId,
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

	it('прячет чужие взаимодействия от пользователя с ограниченной областью', async () => {
		const ctx = admin();
		const routeId = await demoRoute();
		const mine = await insertOrganization(database.db, { shortName: 'Свой вуз' });
		const theirs = await insertOrganization(database.db, { shortName: 'Чужой вуз' });

		const visible = await createInteraction(
			ctx,
			createInteractionSchema.parse({
				title: 'Своё',
				routeId,
				ownerUserId: TEST_USER_IDS.admin,
				parties: [{ organizationId: mine, partyRole: 'educational_institution', isPrimary: true }]
			})
		);

		const hidden = await createInteraction(
			ctx,
			createInteractionSchema.parse({
				title: 'Чужое',
				routeId,
				ownerUserId: TEST_USER_IDS.admin,
				parties: [{ organizationId: theirs, partyRole: 'educational_institution', isPrimary: true }]
			})
		);

		const limited = testActor({ roleId: 'manager', organizationIds: [mine] });
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
		const routeId = await demoRoute();
		const organizationId = await insertOrganization(database.db);

		const created = await createInteraction(
			ctx,
			createInteractionSchema.parse({
				title: 'Что могу сейчас',
				routeId,
				ownerUserId: TEST_USER_IDS.admin,
				parties: [{ organizationId, partyRole: 'educational_institution', isPrimary: true }]
			})
		);

		const managerSummary = await getInteractionSummary(
			testActor({ roleId: 'manager' }),
			created.id
		);
		const viewerSummary = await getInteractionSummary(testActor({ roleId: 'viewer' }), created.id);

		expect(managerSummary.canDo.actions).toContain('pause');
		expect(managerSummary.canDo.transitions.some((option) => !option.allowed)).toBe(true);
		// Наблюдателю не предлагается ничего, что он не имеет права сделать.
		expect(viewerSummary.canDo.actions).toEqual([]);
		expect(viewerSummary.canDo.transitions.every((option) => !option.allowed)).toBe(true);
	});
});
