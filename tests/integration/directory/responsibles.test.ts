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
 * Последняя проверка — про следствие, ради которого всё остальное и написано:
 * снятое назначение закрывает доступ немедленно, а не со следующего входа, и
 * закрывает его в обоих каналах — и на карточке вуза, и на его
 * взаимодействиях, где человек не владелец.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { directions, interactionParties, organizationResponsibles } from '$lib/server/db/schema';
import { getOrganization } from '$lib/server/directory/read';
import {
	assignResponsible,
	listResponsibles,
	releaseResponsible
} from '$lib/server/directory/responsibles';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '$lib/server/errors';
import { getInteraction } from '$lib/server/interactions/read';
import {
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

		await assignResponsible(admin, { organizationId, userId: general, directionId: null });

		// Иначе по DevOps ответственных стало бы двое — общий и направленческий, —
		// и правило «один действующий на направление» перестало бы что-либо значить.
		await expect(
			assignResponsible(admin, { organizationId, userId: byDirection, directionId })
		).rejects.toBeInstanceOf(ConflictError);
	});

	it('не даёт назначить за вуз целиком, пока есть ответственные по направлениям', async () => {
		const admin = testActor();
		const organizationId = await insertOrganization(database.db, { shortName: 'ПУПИ' });
		const directionId = await insertDirection('security', 1);
		const byDirection = await insertUser(database.db, { roleId: 'manager' });
		const general = await insertUser(database.db, { roleId: 'manager' });

		await assignResponsible(admin, { organizationId, userId: byDirection, directionId });

		await expect(
			assignResponsible(admin, { organizationId, userId: general, directionId: null })
		).rejects.toBeInstanceOf(ConflictError);
	});

	it('держит на паре «вуз × направление» одного действующего ответственного', async () => {
		const admin = testActor();
		const organizationId = await insertOrganization(database.db, { shortName: 'СЗПУ' });
		const previous = await insertUser(database.db, { roleId: 'manager' });
		const successor = await insertUser(database.db, { roleId: 'manager' });

		await assignResponsible(admin, { organizationId, userId: previous, directionId: null });
		await assignResponsible(admin, { organizationId, userId: successor, directionId: null });

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

		await assignResponsible(admin, { organizationId, userId: kam, directionId: null });

		await expect(
			assignResponsible(admin, { organizationId, userId: kam, directionId: null })
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
			assignResponsible(admin, { organizationId, userId: kam, directionId: null })
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
				directionId: null
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
			scopeUserIds: [leadId, subordinate]
		});

		await assignResponsible(lead, { organizationId, userId: subordinate, directionId: null });

		expect(
			(await listResponsibles(lead, organizationId))
				.filter((row) => row.validTo === null)
				.map((row) => row.userId)
		).toStrictEqual([subordinate]);

		// Человек вне подчинения: раздавать ему вузы значило бы раздавать работу,
		// которой руководитель потом не увидит.
		await expect(
			assignResponsible(lead, { organizationId, userId: stranger, directionId: null })
		).rejects.toBeInstanceOf(ForbiddenError);
	});

	it('не даёт руководителю распоряжаться вузом вне своей области', async () => {
		const leadId = await insertUser(database.db, { roleId: 'lead' });
		const foreign = await insertOrganization(database.db, { shortName: 'Чужой вуз' });

		const lead = testActor({ roleId: 'lead', userId: leadId, scopeUserIds: [leadId] });

		// «Нет в области» и «нет вовсе» отвечаются одинаково: разный ответ выдал
		// бы существование чужого вуза.
		await expect(
			assignResponsible(lead, { organizationId: foreign, userId: leadId, directionId: null })
		).rejects.toBeInstanceOf(NotFoundError);
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
		const ownerContext = testActor({ roleId: 'manager', userId: owner, scopeUserIds: [owner] });

		expect((await getInteraction(ownerContext, interactionId)).id).toBe(interactionId);
	});

	it('не снимает назначение дважды', async () => {
		const admin = testActor();
		const organizationId = await insertOrganization(database.db, { shortName: 'СЗПУ' });
		const kam = await insertUser(database.db, { roleId: 'manager' });

		await assignResponsible(admin, { organizationId, userId: kam, directionId: null });

		const assignmentId = await activeAssignment(organizationId);
		await releaseResponsible(admin, assignmentId);

		// Закрытое назначение не закрывается заново: иначе вторая кнопка сдвинула
		// бы `valid_to` и переписала историю вуза.
		await expect(releaseResponsible(admin, assignmentId)).rejects.toBeInstanceOf(ConflictError);
	});
});
