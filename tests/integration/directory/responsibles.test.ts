/**
 * Назначения ответственных на настоящей базе.
 *
 * На этих строках держится вся область доступа, поэтому здесь проверяются не
 * запросы, а правила (`docs/access-matrix.md`, раздел 2): общее назначение и
 * назначения по направлениям не сосуществуют, на пару «вуз × направление»
 * действующий ответственный один, организации-оператору ответственного не
 * назначают, руководитель раздаёт вузы только себе и своим людям, а машинный
 * субъект вузов не ведёт вовсе.
 *
 * Отдельный раздел — те же правила под одновременными назначениями: проверка
 * перед записью держит правило ровно настолько, насколько назначения одного
 * вуза идут по очереди, а лишняя действующая строка означает лишнего человека
 * с доступом к вузу.
 *
 * Проверка про следствие, ради которого всё остальное и написано: снятое
 * назначение закрывает доступ немедленно, а не со следующего входа, и
 * закрывает его в обоих каналах — и на карточке вуза, и на его
 * взаимодействиях, где человек не владелец.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	auditEvents,
	directions,
	interactionChanges,
	interactionParties,
	interactionProducts,
	interactionPrograms,
	interactions,
	organizationResponsibles,
	organizations,
	productDirections,
	products,
	programs
} from '$lib/server/db/schema';
import { getOrganization } from '$lib/server/directory/read';
import {
	assignResponsible,
	listResponsibles,
	releaseResponsible
} from '$lib/server/directory/responsibles';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '$lib/server/errors';
import { getInteraction } from '$lib/server/interactions/read';
import type { PermissionKey } from '$lib/server/rbac/permissions';
import { defaultRolePermissions } from '$lib/server/rbac/seed';
import {
	allWorkspaceIds,
	insertInteractionWithStage,
	insertOrganization,
	insertUser,
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

afterAll(async () => {
	await database.stop();
});

beforeEach(async () => {
	await database.reset();
});

/** Направление работы: справочник приходит сидом, а тесту нужна пара строк. */
async function insertDirection(code: string, position: number): Promise<string> {
	const [row] = await database.db
		.insert(directions)
		.values({ code, name: `Направление ${code}`, position })
		.returning({ id: directions.id });

	return row.id;
}

/** Программа направления: по ней взаимодействие попадает в разрез ответственности. */
async function insertProgram(code: string, directionId: string): Promise<string> {
	const [row] = await database.db
		.insert(programs)
		.values({ code, name: `Программа ${code}`, level: 'bachelor', status: 'active', directionId })
		.returning({ id: programs.id });

	return row.id;
}

/** Продукт направления: второй путь взаимодействия в тот же разрез. */
async function insertProduct(code: string, directionId: string): Promise<string> {
	const [row] = await database.db
		.insert(products)
		.values({ code, name: `Продукт ${code}`, status: 'active' })
		.returning({ id: products.id });

	await database.db.insert(productDirections).values({ productId: row.id, directionId });

	return row.id;
}

/** Идентификатор действующего назначения вуза; их по правилу не больше одного на направление. */
async function activeAssignment(organizationId: string): Promise<string> {
	const [row] = await database.db
		.select({ id: organizationResponsibles.id })
		.from(organizationResponsibles)
		.where(
			and(
				eq(organizationResponsibles.organizationId, organizationId),
				isNull(organizationResponsibles.validTo)
			)
		);

	return row.id;
}

describe('правила назначения', () => {
	it('не даёт назначить по направлению, пока есть ответственный за вуз целиком', async () => {
		const admin = testActor();
		const organizationId = await insertOrganization(database.db, { shortName: 'СЗПУ' });
		const directionId = await insertDirection('devops', 1);
		const general = await insertUser(database.db, { roleId: 'manager' });
		const byDirection = await insertUser(database.db, { roleId: 'manager' });

		await assignResponsible(admin, {
			organizationId,
			userId: general,
			directionId: null,
			transferInteractions: false
		});

		// Иначе по DevOps ответственных стало бы двое — общий и направленческий, —
		// и правило «один действующий на направление» перестало бы что-либо значить.
		await expect(
			assignResponsible(admin, {
				organizationId,
				userId: byDirection,
				directionId,
				transferInteractions: false
			})
		).rejects.toBeInstanceOf(ConflictError);
	});

	it('не даёт назначить за вуз целиком, пока есть ответственные по направлениям', async () => {
		const admin = testActor();
		const organizationId = await insertOrganization(database.db, { shortName: 'ПУПИ' });
		const directionId = await insertDirection('security', 1);
		const byDirection = await insertUser(database.db, { roleId: 'manager' });
		const general = await insertUser(database.db, { roleId: 'manager' });

		await assignResponsible(admin, {
			organizationId,
			userId: byDirection,
			directionId,
			transferInteractions: false
		});

		await expect(
			assignResponsible(admin, {
				organizationId,
				userId: general,
				directionId: null,
				transferInteractions: false
			})
		).rejects.toBeInstanceOf(ConflictError);
	});

	it('держит на паре «вуз × направление» одного действующего ответственного', async () => {
		const admin = testActor();
		const organizationId = await insertOrganization(database.db, { shortName: 'СЗПУ' });
		const previous = await insertUser(database.db, { roleId: 'manager' });
		const successor = await insertUser(database.db, { roleId: 'manager' });

		await assignResponsible(admin, {
			organizationId,
			userId: previous,
			directionId: null,
			transferInteractions: false
		});
		await assignResponsible(admin, {
			organizationId,
			userId: successor,
			directionId: null,
			transferInteractions: false
		});

		const rows = await listResponsibles(admin, organizationId);
		const active = rows.filter((row) => row.validTo === null);
		const closed = rows.filter((row) => row.validTo !== null);

		expect(active.map((row) => row.userId)).toStrictEqual([successor]);
		expect(closed.map((row) => row.userId)).toStrictEqual([previous]);
		// Момент один на обе строки: иначе между ними осталась бы щель, в которую
		// попадает отчёт за период, и вуз оказался бы ничьим.
		expect(closed[0].validTo?.getTime()).toBe(active[0].validFrom.getTime());
	});

	it('не назначает второй раз того, кто уже ведёт вуз по этому направлению', async () => {
		const admin = testActor();
		const organizationId = await insertOrganization(database.db, { shortName: 'СЗПУ' });
		const kam = await insertUser(database.db, { roleId: 'manager' });

		await assignResponsible(admin, {
			organizationId,
			userId: kam,
			directionId: null,
			transferInteractions: false
		});

		await expect(
			assignResponsible(admin, {
				organizationId,
				userId: kam,
				directionId: null,
				transferInteractions: false
			})
		).rejects.toBeInstanceOf(ConflictError);
	});

	it('не назначает ответственного организации-оператору', async () => {
		const admin = testActor();
		const organizationId = await insertOrganization(database.db, {
			shortName: 'Оператор',
			kind: 'operator'
		});
		const kam = await insertUser(database.db, { roleId: 'manager' });

		// Оператор стоит стороной почти в каждом взаимодействии: назначить на него
		// ответственного значило бы отдать ему все записи продукта разом.
		await expect(
			assignResponsible(admin, {
				organizationId,
				userId: kam,
				directionId: null,
				transferInteractions: false
			})
		).rejects.toBeInstanceOf(ValidationError);

		expect(await listResponsibles(admin, organizationId)).toStrictEqual([]);
	});

	it('не назначает машинный субъект: вузов он не ведёт', async () => {
		const admin = testActor();
		const organizationId = await insertOrganization(database.db, { shortName: 'СЗПУ' });

		// От имени `service` работают ключи обмена; область у них своя, и вуз ей
		// не принадлежит.
		await expect(
			assignResponsible(admin, {
				organizationId,
				userId: TEST_USER_IDS.service,
				directionId: null,
				transferInteractions: false
			})
		).rejects.toBeInstanceOf(ValidationError);
	});

	it('даёт руководителю назначать своих людей и отказывает на чужом', async () => {
		const leadId = await insertUser(database.db, { roleId: 'lead' });
		const subordinate = await insertUser(database.db, { roleId: 'manager' });
		const stranger = await insertUser(database.db, { roleId: 'manager' });

		const organizationId = await insertOrganization(database.db, { shortName: 'СЗПУ' });
		await scopedActor(database.db, {
			roleId: 'lead',
			userId: leadId,
			organizationIds: [organizationId]
		});

		// Область руководителя — он сам и его подчинённые; вуз в ней есть, потому
		// что ведёт его пока он.
		const lead = testActor({
			roleId: 'lead',
			userId: leadId,
			scopeUserIds: [leadId, subordinate],
			workspaceIds: await allWorkspaceIds(database.db)
		});

		await assignResponsible(lead, {
			organizationId,
			userId: subordinate,
			directionId: null,
			transferInteractions: false
		});

		expect(
			(await listResponsibles(lead, organizationId))
				.filter((row) => row.validTo === null)
				.map((row) => row.userId)
		).toStrictEqual([subordinate]);

		// Человек вне подчинения: раздавать ему вузы значило бы раздавать работу,
		// которой руководитель потом не увидит.
		await expect(
			assignResponsible(lead, {
				organizationId,
				userId: stranger,
				directionId: null,
				transferInteractions: false
			})
		).rejects.toBeInstanceOf(ForbiddenError);
	});

	it('не даёт руководителю распоряжаться вузом вне своей области', async () => {
		const leadId = await insertUser(database.db, { roleId: 'lead' });
		const foreign = await insertOrganization(database.db, { shortName: 'Чужой вуз' });

		const lead = testActor({
			roleId: 'lead',
			userId: leadId,
			scopeUserIds: [leadId],
			workspaceIds: await allWorkspaceIds(database.db)
		});

		// «Нет в области» и «нет вовсе» отвечаются одинаково: разный ответ выдал
		// бы существование чужого вуза.
		await expect(
			assignResponsible(lead, {
				organizationId: foreign,
				userId: leadId,
				directionId: null,
				transferInteractions: false
			})
		).rejects.toBeInstanceOf(NotFoundError);
	});
});

/**
 * Одновременные назначения на один вуз.
 *
 * Правила раздела 2 проверяются чтением, а область доступа считается
 * подзапросом по действующим строкам, — значит, всё решает то, что назначение
 * успело увидеть. Две вкладки руководителя, две кнопки и загрузка каталога
 * рядом с ними — обычный день; если бы назначения шли параллельно, вуз получил
 * бы двух действующих ответственных, а вместе со вторым — лишнего человека,
 * который видит чужие записи. Поэтому здесь проверяется не результат
 * последовательных вызовов, а исход одновременных.
 */
describe('одновременные назначения', () => {
	function sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/** Причина отказа печатается прямо в ожидании: «rejected» без текста ничего не объясняет. */
	function outcomeOf(result: PromiseSettledResult<unknown>): string {
		return result.status === 'fulfilled' ? 'fulfilled' : `rejected: ${String(result.reason)}`;
	}

	/** Действующие назначения вуза — ровно то, по чему считается область доступа. */
	async function currentAssignments(
		organizationId: string
	): Promise<{ userId: string; directionId: string | null }[]> {
		return database.db
			.select({
				userId: organizationResponsibles.userId,
				directionId: organizationResponsibles.directionId
			})
			.from(organizationResponsibles)
			.where(
				and(
					eq(organizationResponsibles.organizationId, organizationId),
					isNull(organizationResponsibles.validTo)
				)
			);
	}

	it('детерминированно: назначение решает по состоянию, сложившемуся к его очереди', async () => {
		const admin = testActor();
		const organizationId = await insertOrganization(database.db, { shortName: 'СЗПУ' });
		const directionId = await insertDirection('devops', 1);
		const byDirection = await insertUser(database.db, { roleId: 'manager' });
		const general = await insertUser(database.db, { roleId: 'manager' });

		// Транзакция A — соседнее назначение, которое ещё не дошло до конца: она
		// держит строку вуза и уже завела ответственного по направлению.
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});

		const holder = database.db.transaction(async (tx) => {
			await tx
				.select({ id: organizations.id })
				.from(organizations)
				.where(eq(organizations.id, organizationId))
				.for('update');

			await tx
				.insert(organizationResponsibles)
				.values({ organizationId, userId: byDirection, directionId });

			await held;
		});

		await sleep(100);

		const assignment = assignResponsible(admin, {
			organizationId,
			userId: general,
			directionId: null,
			transferInteractions: false
		});
		let settled = false;
		void assignment.then(
			() => (settled = true),
			() => (settled = true)
		);
		await sleep(300);

		// Назначение стоит в очереди и ничего ещё не решило.
		expect(settled).toBe(false);

		release();
		await holder;

		// И решает по тому, что застало, когда очередь дошла: общее назначение
		// поверх направленческого — отказ. Прочитай оно состояние до очереди —
		// увидело бы пустой вуз, и у вуза стало бы два действующих ответственных,
		// то есть лишний человек с доступом.
		await expect(assignment).rejects.toBeInstanceOf(ConflictError);

		expect(await currentAssignments(organizationId)).toStrictEqual([
			{ userId: byDirection, directionId }
		]);
	});

	it('состязательно: два назначения на одну пару выстраиваются в историю', async () => {
		const admin = testActor();

		for (let run = 0; run < 5; run += 1) {
			await database.reset();

			const organizationId = await insertOrganization(database.db, { shortName: 'СЗПУ' });
			const first = await insertUser(database.db, { roleId: 'manager' });
			const second = await insertUser(database.db, { roleId: 'manager' });

			const outcomes = await Promise.allSettled([
				assignResponsible(admin, {
					organizationId,
					userId: first,
					directionId: null,
					transferInteractions: false
				}),
				assignResponsible(admin, {
					organizationId,
					userId: second,
					directionId: null,
					transferInteractions: false
				})
			]);

			// Оба вызова законны: второй не отказывает, а встаёт следующим — он
			// читает состояние вуза уже после первого, а не вместе с ним.
			expect(outcomes.map(outcomeOf)).toStrictEqual(['fulfilled', 'fulfilled']);

			const rows = await listResponsibles(admin, organizationId);
			const active = rows.filter((row) => row.validTo === null);
			const closed = rows.filter((row) => row.validTo !== null);

			expect(active).toHaveLength(1);
			expect(closed).toHaveLength(1);
			expect(active[0].userId).not.toBe(closed[0].userId);
			expect([first, second]).toContain(active[0].userId);

			// История без щели: прежнее закрыто ровно тем моментом, которым открыто
			// следующее. Строгий порядок внутри строки держит `check`
			// `organization_responsibles_period_ordered`.
			expect(closed[0].validTo?.getTime()).toBe(active[0].validFrom.getTime());
		}
	}, 60_000);

	it('состязательно: общее назначение и назначение по направлению не расходятся вдвоём', async () => {
		const admin = testActor();

		for (let run = 0; run < 5; run += 1) {
			await database.reset();

			const organizationId = await insertOrganization(database.db, { shortName: 'ПУПИ' });
			const directionId = await insertDirection('devops', 1);
			const general = await insertUser(database.db, { roleId: 'manager' });
			const byDirection = await insertUser(database.db, { roleId: 'manager' });

			const outcomes = await Promise.allSettled([
				assignResponsible(admin, {
					organizationId,
					userId: general,
					directionId: null,
					transferInteractions: false
				}),
				assignResponsible(admin, {
					organizationId,
					userId: byDirection,
					directionId,
					transferInteractions: false
				})
			]);

			// Это правило уникальным индексом не выражается: общее назначение и
			// назначение по направлению — разные ключи. Проходит ровно один, и
			// второй читает отказ, а не код PostgreSQL.
			const refused = outcomes.flatMap((outcome) =>
				outcome.status === 'rejected' ? [outcome.reason] : []
			);

			expect(refused).toHaveLength(1);
			expect(refused[0]).toBeInstanceOf(ConflictError);
			expect(await currentAssignments(organizationId)).toHaveLength(1);
		}
	}, 60_000);

	it('второй действующей строки на ту же пару база не принимает', async () => {
		const admin = testActor();
		const organizationId = await insertOrganization(database.db, { shortName: 'СЗПУ' });
		const kam = await insertUser(database.db, { roleId: 'manager' });
		const other = await insertUser(database.db, { roleId: 'manager' });

		await assignResponsible(admin, {
			organizationId,
			userId: kam,
			directionId: null,
			transferInteractions: false
		});

		// Путь мимо сервиса — ручной SQL, сид, завтрашний код — упирается в тот же
		// индекс: правило «один действующий на пару вуз × направление» держит база,
		// а не проверка перед записью.
		const refusal = await database.db
			.insert(organizationResponsibles)
			.values({ organizationId, userId: other, directionId: null })
			.then(
				() => null,
				(error: unknown) => error
			);

		// Имя ограничения лежит в причине: Drizzle заворачивает ошибку драйвера в
		// свою, и словарь `directory/conflicts.ts` ищет её там же.
		expect(String((refusal as Error | null)?.cause)).toContain(
			'organization_responsibles_current_key'
		);
	});
});

describe('снятие назначения', () => {
	it('закрывает прежнему ответственному и карточку вуза, и его взаимодействия', async () => {
		const admin = testActor();
		const organizationId = await insertOrganization(database.db, { shortName: 'СЗПУ' });
		const owner = await insertUser(database.db, { roleId: 'manager' });

		// Запись ведёт другой человек: так видно, что доступ к ней давало именно
		// назначение на вуз, а не владение записью.
		const { interactionId } = await insertInteractionWithStage(database.db, {
			ownerUserId: owner
		});
		await database.db.insert(interactionParties).values({
			interactionId,
			organizationId,
			partyRole: 'educational_institution',
			isPrimary: true
		});

		const curator = await scopedActor(database.db, {
			roleId: 'manager',
			organizationIds: [organizationId]
		});

		expect((await getOrganization(curator, organizationId)).id).toBe(organizationId);
		expect((await getInteraction(curator, interactionId)).id).toBe(interactionId);

		await releaseResponsible(admin, await activeAssignment(organizationId));

		// Область считается подзапросом в момент выборки, поэтому доступ пропадает
		// в ту же секунду — и отвечает 404, а не 403: чужого вуза для прежнего
		// ответственного больше не существует.
		await expect(getOrganization(curator, organizationId)).rejects.toBeInstanceOf(NotFoundError);
		await expect(getInteraction(curator, interactionId)).rejects.toBeInstanceOf(NotFoundError);

		// Владелец записи её не терял: смена ответственного за вуз не обрывает
		// незавершённую работу.
		const ownerContext = testActor({
			roleId: 'manager',
			userId: owner,
			scopeUserIds: [owner],
			workspaceIds: await allWorkspaceIds(database.db)
		});

		expect((await getInteraction(ownerContext, interactionId)).id).toBe(interactionId);
	});

	it('не снимает назначение дважды', async () => {
		const admin = testActor();
		const organizationId = await insertOrganization(database.db, { shortName: 'СЗПУ' });
		const kam = await insertUser(database.db, { roleId: 'manager' });

		await assignResponsible(admin, {
			organizationId,
			userId: kam,
			directionId: null,
			transferInteractions: false
		});

		const assignmentId = await activeAssignment(organizationId);
		await releaseResponsible(admin, assignmentId);

		// Закрытое назначение не закрывается заново: иначе вторая кнопка сдвинула
		// бы `valid_to` и переписала историю вуза.
		await expect(releaseResponsible(admin, assignmentId)).rejects.toBeInstanceOf(ConflictError);
	});
});

/**
 * Передача незавершённых взаимодействий при замене ответственного.
 *
 * Смена куратора вуза без передачи работы оставляла бы половину картины у
 * человека, который вуз уже не ведёт: карточку он не видит, а записи по ней
 * остаются его. Отбор узкий намеренно — основная сторона, прежний ответственный
 * владельцем, только записи в работе, — и здесь проверяется каждая граница.
 */
describe('передача взаимодействий при замене', () => {
	/** Взаимодействие вуза: организация стоит основной стороной. */
	async function interactionFor(
		organizationId: string,
		options: { ownerUserId: string; isPrimary?: boolean; status?: 'active' | 'completed' }
	): Promise<string> {
		const { interactionId } = await insertInteractionWithStage(database.db, {
			ownerUserId: options.ownerUserId
		});

		await database.db.insert(interactionParties).values({
			interactionId,
			organizationId,
			partyRole: 'educational_institution',
			isPrimary: options.isPrimary ?? true
		});

		if (options.status === 'completed') {
			await database.db
				.update(interactions)
				.set({ status: 'completed' })
				.where(eq(interactions.id, interactionId));
		}

		return interactionId;
	}

	/** Владелец записи прямо из базы: сервисы её могут уже не показывать. */
	async function ownerOf(interactionId: string): Promise<string | null> {
		const [row] = await database.db
			.select({ ownerUserId: interactions.ownerUserId })
			.from(interactions)
			.where(eq(interactions.id, interactionId));

		return row.ownerUserId;
	}

	it('передаёт новому ответственному только работу прежнего по этому вузу', async () => {
		const admin = testActor();
		const organizationId = await insertOrganization(database.db, { shortName: 'СЗПУ' });
		const other = await insertOrganization(database.db, { shortName: 'Другой вуз' });
		const previous = await insertUser(database.db, { roleId: 'manager' });
		const successor = await insertUser(database.db, { roleId: 'manager' });
		const stranger = await insertUser(database.db, { roleId: 'manager' });

		await assignResponsible(admin, {
			organizationId,
			userId: previous,
			directionId: null,
			transferInteractions: false
		});

		const inWork = await interactionFor(organizationId, { ownerUserId: previous });
		const finished = await interactionFor(organizationId, {
			ownerUserId: previous,
			status: 'completed'
		});
		// Сторона не основная: оператор стоит стороной почти везде, и передача по
		// любой стороне унесла бы половину продукта.
		const asideParty = await interactionFor(organizationId, {
			ownerUserId: previous,
			isPrimary: false
		});
		// Работа третьего человека: вуз ему когда-то передали поштучно, и смена
		// куратора вуза его записи не трогает.
		const foreignOwner = await interactionFor(organizationId, { ownerUserId: stranger });
		const elsewhere = await interactionFor(other, { ownerUserId: previous });

		await assignResponsible(admin, {
			organizationId,
			userId: successor,
			directionId: null,
			transferInteractions: true
		});

		expect(await ownerOf(inWork)).toBe(successor);
		expect(await ownerOf(finished)).toBe(previous);
		expect(await ownerOf(asideParty)).toBe(previous);
		expect(await ownerOf(foreignOwner)).toBe(stranger);
		expect(await ownerOf(elsewhere)).toBe(previous);

		// Передача идёт той же командой, что и с карточки: строка предметной
		// истории и событие журнала на каждую запись.
		const changes = await database.db
			.select({ field: interactionChanges.field, newValue: interactionChanges.newValue })
			.from(interactionChanges)
			.where(eq(interactionChanges.interactionId, inWork));

		expect(changes).toStrictEqual([{ field: 'ownerUserId', newValue: successor }]);

		const owned = await database.db
			.select({ type: auditEvents.eventType })
			.from(auditEvents)
			.where(eq(auditEvents.subjectId, inWork));

		expect(owned.map((event) => event.type)).toContain('interactions.owner_changed');

		// Сколько записей уехало, видно в событии переназначения: иначе «передали»
		// и «передавать было нечего» в журнале неразличимы.
		const [reassigned] = await database.db
			.select({ details: auditEvents.details })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'directory.responsible_reassigned'));

		expect(reassigned.details).toMatchObject({ previousUserId: previous, transferredCount: 1 });
	});

	it('оставляет работу прежнему владельцу, когда передача не запрошена', async () => {
		const admin = testActor();
		const organizationId = await insertOrganization(database.db, { shortName: 'СЗПУ' });
		const previous = await insertUser(database.db, { roleId: 'manager' });
		const successor = await insertUser(database.db, { roleId: 'manager' });

		await assignResponsible(admin, {
			organizationId,
			userId: previous,
			directionId: null,
			transferInteractions: false
		});

		const inWork = await interactionFor(organizationId, { ownerUserId: previous });

		await assignResponsible(admin, {
			organizationId,
			userId: successor,
			directionId: null,
			transferInteractions: false
		});

		expect(await ownerOf(inWork)).toBe(previous);

		const [reassigned] = await database.db
			.select({ details: auditEvents.details })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'directory.responsible_reassigned'));

		expect(reassigned.details).toMatchObject({ transferredCount: 0 });
	});

	it('при назначении по направлению передаёт только работу этого направления', async () => {
		const admin = testActor();
		const organizationId = await insertOrganization(database.db, { shortName: 'СЗПУ' });
		const devops = await insertDirection('devops', 1);
		const security = await insertDirection('security', 2);
		const previous = await insertUser(database.db, { roleId: 'manager' });
		const successor = await insertUser(database.db, { roleId: 'manager' });

		await assignResponsible(admin, {
			organizationId,
			userId: previous,
			directionId: devops,
			transferInteractions: false
		});

		// Направление взаимодействия считается так же, как в отчётах: по
		// программам и по продуктам, а не отдельным полем.
		const byProgram = await interactionFor(organizationId, { ownerUserId: previous });
		await database.db
			.insert(interactionPrograms)
			.values({ interactionId: byProgram, programId: await insertProgram('devops-1', devops) });

		const byProduct = await interactionFor(organizationId, { ownerUserId: previous });
		await database.db
			.insert(interactionProducts)
			.values({ interactionId: byProduct, productId: await insertProduct('devops-2', devops) });

		const otherDirection = await interactionFor(organizationId, { ownerUserId: previous });
		await database.db.insert(interactionPrograms).values({
			interactionId: otherDirection,
			programId: await insertProgram('security-1', security)
		});

		// Ни программ, ни продуктов: направления у записи нет, и назначение по
		// направлению её не касается.
		const withoutDirection = await interactionFor(organizationId, { ownerUserId: previous });

		await assignResponsible(admin, {
			organizationId,
			userId: successor,
			directionId: devops,
			transferInteractions: true
		});

		expect(await ownerOf(byProgram)).toBe(successor);
		expect(await ownerOf(byProduct)).toBe(successor);
		expect(await ownerOf(otherDirection)).toBe(previous);
		expect(await ownerOf(withoutDirection)).toBe(previous);
	});

	it('не передаёт без права на смену владельца взаимодействия', async () => {
		const organizationId = await insertOrganization(database.db, { shortName: 'СЗПУ' });
		const previous = await insertUser(database.db, { roleId: 'manager' });
		const successor = await insertUser(database.db, { roleId: 'manager' });

		await assignResponsible(testActor(), {
			organizationId,
			userId: previous,
			directionId: null,
			transferInteractions: false
		});

		const inWork = await interactionFor(organizationId, { ownerUserId: previous });

		// Раздавать вузы и передавать чужую работу — разные права: у того, кто
		// распределяет кураторов, второго может не быть.
		const withoutReassign = testActor({
			permissions: [...defaultRolePermissions('admin')].filter(
				(key) => key !== 'interactions.reassign'
			) as PermissionKey[]
		});

		await expect(
			assignResponsible(withoutReassign, {
				organizationId,
				userId: successor,
				directionId: null,
				transferInteractions: true
			})
		).rejects.toBeInstanceOf(ForbiddenError);

		// Отказ до единой записи: назначение тоже не состоялось.
		expect(await ownerOf(inWork)).toBe(previous);
		expect(
			(await listResponsibles(testActor(), organizationId))
				.filter((row) => row.validTo === null)
				.map((row) => row.userId)
		).toStrictEqual([previous]);

		// Без передачи то же назначение проходит: право требуется на передачу, а
		// не на смену куратора.
		await assignResponsible(withoutReassign, {
			organizationId,
			userId: successor,
			directionId: null,
			transferInteractions: false
		});

		expect(await ownerOf(inWork)).toBe(previous);
	});

	it('при снятии без замены оставляет работу прежнему ответственному', async () => {
		const admin = testActor();
		const organizationId = await insertOrganization(database.db, { shortName: 'СЗПУ' });
		const kam = await insertUser(database.db, { roleId: 'manager' });

		await assignResponsible(admin, {
			organizationId,
			userId: kam,
			directionId: null,
			transferInteractions: false
		});

		const inWork = await interactionFor(organizationId, { ownerUserId: kam });

		// Снятие без замены передавать некому: работа остаётся у своего
		// владельца, и он продолжает видеть её слагаемым «мои взаимодействия».
		await releaseResponsible(admin, await activeAssignment(organizationId));

		expect(await ownerOf(inWork)).toBe(kam);
	});
});
