/**
 * Справочники на настоящей базе.
 *
 * Проверяется то, что нельзя проверить на заглушке: частичная уникальность
 * ИНН, составной внешний ключ площадки, уникальность номера версии программы,
 * маскирование контактов и область доступа. Каждая проверка называет правило,
 * которое сломается, если убрать защиту.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	organizationDirectoryQuerySchema,
	peopleListQuerySchema,
	programDirectoryQuerySchema,
	type CreateOrganizationInput
} from '$lib/contracts/directory';
import { affiliations, auditEvents, programVersions, sites } from '$lib/server/db/schema';
import {
	getPerson,
	listOrganizationRows,
	listPeople,
	listPersonAffiliations,
	listProgramRows,
	listSites
} from '$lib/server/directory/read';
import {
	addProgramVersion,
	archiveOrganization,
	createAffiliation,
	createOrganization,
	createPerson,
	createProduct,
	createProgram,
	createSite,
	endAffiliation,
	restoreOrganization,
	updateOrganization,
	updatePerson,
	updateProduct,
	updateProgram
} from '$lib/server/directory/write';
import { ConflictError, ForbiddenError, ValidationError } from '$lib/server/errors';
import { failureCode, startTestDatabase, testActor, type TestDatabase } from '../helpers/db';

// См. комментарий в `schema.test.ts`: без этого сервисы пойдут в базу разработчика.
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

/** Настоящие ИНН с верной контрольной суммой: схема проверяет именно её. */
const INN = '7707083893';
const OTHER_INN = '7736207543';

function organizationInput(overrides: Partial<CreateOrganizationInput> = {}) {
	return {
		kind: 'educational_institution',
		educationLevel: 'vo',
		legalName: 'Федеральное государственное учреждение высшего образования',
		shortName: 'Тестовый вуз',
		inn: null,
		kpp: null,
		ogrn: null,
		region: 'Москва',
		website: null,
		notes: null,
		isActive: true,
		externalSource: null,
		externalId: null,
		...overrides
	} satisfies CreateOrganizationInput;
}

const firstPage = organizationDirectoryQuerySchema.parse({});
const firstPeoplePage = peopleListQuerySchema.parse({});

describe('организации', () => {
	it('не пускает второй ИНН и называет организацию, которая его заняла', async () => {
		const ctx = testActor();
		await createOrganization(ctx, organizationInput({ shortName: 'МГТУ', inn: INN }));

		await expect(
			createOrganization(ctx, organizationInput({ shortName: 'Двойник', inn: INN }))
		).rejects.toSatisfy(
			(error: unknown) => error instanceof ConflictError && /МГТУ/.test(error.message)
		);

		const rows = await listOrganizationRows(ctx, firstPage);
		expect(rows.total).toBe(1);
	});

	it('оставляет организации без ИНН друг другу не мешать', async () => {
		const ctx = testActor();
		await createOrganization(ctx, organizationInput({ shortName: 'Школа 1' }));
		await createOrganization(ctx, organizationInput({ shortName: 'Школа 2' }));

		expect((await listOrganizationRows(ctx, firstPage)).total).toBe(2);
	});

	it('не даёт изменением занять чужой ИНН, но своему не мешает', async () => {
		const ctx = testActor();
		const first = await createOrganization(
			ctx,
			organizationInput({ shortName: 'Первый', inn: INN })
		);
		const second = await createOrganization(
			ctx,
			organizationInput({ shortName: 'Второй', inn: OTHER_INN })
		);

		await expect(
			updateOrganization(ctx, {
				...organizationInput({ shortName: 'Второй', inn: INN }),
				id: second.id
			})
		).rejects.toBeInstanceOf(ConflictError);

		const kept = await updateOrganization(ctx, {
			...organizationInput({ shortName: 'Первый переименованный', inn: INN }),
			id: first.id
		});

		expect(kept.shortName).toBe('Первый переименованный');
	});

	it('архивирует вместо удаления и второй раз отказывает', async () => {
		const ctx = testActor();
		const organization = await createOrganization(ctx, organizationInput());

		const archived = await archiveOrganization(ctx, organization.id);
		expect(archived.isActive).toBe(false);

		await expect(archiveOrganization(ctx, organization.id)).rejects.toBeInstanceOf(ConflictError);
		expect((await listOrganizationRows(ctx, firstPage)).total).toBe(1);
	});

	it('возвращает из архива, пишет это правкой одного поля и второй раз отказывает', async () => {
		const ctx = testActor();
		const organization = await createOrganization(ctx, organizationInput());
		await archiveOrganization(ctx, organization.id);

		const restored = await restoreOrganization(ctx, organization.id);
		expect(restored.isActive).toBe(true);

		// В журнале это правка состояния, а не новая организация: по списку
		// изменённых полей видно, что вернули именно из архива.
		const updates = await database.db
			.select({ details: auditEvents.details })
			.from(auditEvents)
			.where(
				and(eq(auditEvents.eventType, 'organizations.updated'), eq(auditEvents.outcome, 'success'))
			);

		expect(updates).toEqual([{ details: { changedFields: ['isActive'] } }]);

		// Организация уже действует — возвращать нечего, и это конфликт, а не
		// молчаливый успех.
		await expect(restoreOrganization(ctx, organization.id)).rejects.toBeInstanceOf(ConflictError);

		// Возврат меняет справочник, поэтому требует того же права, что и архив.
		await expect(
			restoreOrganization(testActor({ roleId: 'viewer' }), organization.id)
		).rejects.toBeInstanceOf(ForbiddenError);
	});

	it('считает площадки в строке списка', async () => {
		const ctx = testActor();
		const organization = await createOrganization(ctx, organizationInput());

		await createSite(ctx, {
			organizationId: organization.id,
			kind: 'campus',
			name: 'Главный корпус',
			address: null,
			region: null,
			externalSource: null,
			externalId: null
		});

		const rows = await listOrganizationRows(ctx, firstPage);
		expect(rows.items[0].siteCount).toBe(1);
	});
});

describe('площадки и роли', () => {
	async function twoOrganizationsWithSite() {
		const ctx = testActor();
		const own = await createOrganization(ctx, organizationInput({ shortName: 'Своя' }));
		const other = await createOrganization(ctx, organizationInput({ shortName: 'Чужая' }));
		const site = await createSite(ctx, {
			organizationId: other.id,
			kind: 'branch',
			name: 'Филиал',
			address: null,
			region: null,
			externalSource: null,
			externalId: null
		});

		return { ctx, own, other, site };
	}

	const personInput = {
		lastName: 'Иванов',
		firstName: 'Иван',
		middleName: 'Иванович',
		email: 'ivanov@vuz.ru',
		phone: '+7 999 123-45-67',
		notes: null
	};

	it('отказывает роли с площадкой чужой организации — и в сервисе, и в базе', async () => {
		const { ctx, own, site } = await twoOrganizationsWithSite();
		const person = await createPerson(ctx, personInput);

		await expect(
			createAffiliation(ctx, {
				personId: person.id,
				organizationId: own.id,
				siteId: site.id,
				position: 'Проректор',
				roleKind: 'vice_rector',
				isPrimary: false,
				validFrom: '2026-01-01',
				validTo: null,
				channel: null
			})
		).rejects.toBeInstanceOf(ValidationError);

		// Сервис можно обойти, а составной внешний ключ — нет.
		const code = await failureCode(
			database.db.insert(affiliations).values({
				personId: person.id,
				organizationId: own.id,
				siteId: site.id,
				position: 'Проректор',
				roleKind: 'vice_rector',
				validFrom: '2026-01-01'
			})
		);

		expect(code).toBe('23503');
	});

	it('закрывает полномочия датой и второй раз отказывает', async () => {
		const ctx = testActor();
		const organization = await createOrganization(ctx, organizationInput());
		const person = await createPerson(ctx, personInput);

		const affiliation = await createAffiliation(ctx, {
			personId: person.id,
			organizationId: organization.id,
			siteId: null,
			position: 'Координатор',
			roleKind: 'coordinator',
			isPrimary: true,
			validFrom: '2026-01-01',
			validTo: null,
			channel: 'почта'
		});

		const closed = await endAffiliation(ctx, { id: affiliation.id, validTo: '2026-06-30' });
		expect(closed.validTo).toBe('2026-06-30');

		await expect(
			endAffiliation(ctx, { id: affiliation.id, validTo: '2026-07-31' })
		).rejects.toBeInstanceOf(ConflictError);

		const rows = await listPersonAffiliations(ctx, person.id);
		expect(rows).toHaveLength(1);
		expect(rows[0].affiliation.validTo).toBe('2026-06-30');
	});

	it('не закрывает полномочия днём раньше их начала', async () => {
		const ctx = testActor();
		const organization = await createOrganization(ctx, organizationInput());
		const person = await createPerson(ctx, personInput);

		const affiliation = await createAffiliation(ctx, {
			personId: person.id,
			organizationId: organization.id,
			siteId: null,
			position: 'Координатор',
			roleKind: 'coordinator',
			isPrimary: false,
			validFrom: '2026-05-01',
			validTo: null,
			channel: null
		});

		await expect(
			endAffiliation(ctx, { id: affiliation.id, validTo: '2026-04-30' })
		).rejects.toBeInstanceOf(ValidationError);
	});

	it('не заводит две площадки с одним названием в одной организации', async () => {
		const ctx = testActor();
		const organization = await createOrganization(ctx, organizationInput());
		const site = {
			organizationId: organization.id,
			kind: 'campus' as const,
			name: 'Главный корпус',
			address: null,
			region: null,
			externalSource: null,
			externalId: null
		};

		await createSite(ctx, site);
		await expect(createSite(ctx, site)).rejects.toBeInstanceOf(ConflictError);
		expect(await listSites(ctx, organization.id)).toHaveLength(1);
	});
});

describe('программы и продукты', () => {
	const programInput = {
		code: 'DPO-01',
		name: 'Цифровые кафедры',
		level: 'dpo' as const,
		directionCode: null,
		status: 'active' as const,
		externalSource: null,
		externalId: null
	};

	it('нумерует версии подряд и не допускает двух с одним номером', async () => {
		const ctx = testActor();
		const program = await createProgram(ctx, programInput);

		const first = await addProgramVersion(ctx, {
			programId: program.id,
			summary: 'Первая редакция',
			effectiveFrom: '2026-09-01'
		});
		const second = await addProgramVersion(ctx, {
			programId: program.id,
			summary: 'Уточнили часы',
			effectiveFrom: '2026-10-01'
		});

		expect([first.version, second.version]).toEqual([1, 2]);

		const code = await failureCode(
			database.db.insert(programVersions).values({
				programId: program.id,
				version: 2,
				summary: 'Повтор номера',
				effectiveFrom: '2026-11-01'
			})
		);

		expect(code).toBe('23505');
	});

	it('показывает в списке номер последней версии программы', async () => {
		const ctx = testActor();
		const withVersions = await createProgram(ctx, programInput);
		const without = await createProgram(ctx, {
			...programInput,
			code: 'DPO-02',
			name: 'Без версий'
		});

		await addProgramVersion(ctx, {
			programId: withVersions.id,
			summary: 'Первая редакция',
			effectiveFrom: '2026-09-01'
		});
		await addProgramVersion(ctx, {
			programId: withVersions.id,
			summary: 'Вторая редакция',
			effectiveFrom: '2026-10-01'
		});

		const rows = await listProgramRows(ctx, programDirectoryQuerySchema.parse({}));
		const byId = new Map(rows.items.map((item) => [item.program.id, item.latestVersion]));

		expect(rows.total).toBe(2);
		expect(byId.get(withVersions.id)).toBe(2);
		expect(byId.get(without.id)).toBeNull();
	});

	it('переводит уход программы и продукта в архив в отдельное событие журнала', async () => {
		const ctx = testActor();
		const program = await createProgram(ctx, programInput);
		await updateProgram(ctx, { ...programInput, status: 'archived', id: program.id });

		const product = await createProduct(ctx, {
			code: 'PRD-01',
			name: 'Платформа обучения',
			vendorOrganizationId: null,
			description: null,
			status: 'active',
			externalSource: null,
			externalId: null
		});
		await updateProduct(ctx, {
			code: 'PRD-01',
			name: 'Платформа обучения',
			vendorOrganizationId: null,
			description: null,
			status: 'archived',
			externalSource: null,
			externalId: null,
			id: product.id
		});

		const events = await database.db
			.select({ type: auditEvents.eventType })
			.from(auditEvents)
			.where(eq(auditEvents.outcome, 'success'));

		const types = events.map((event) => event.type);
		expect(types).toContain('programs.archived');
		expect(types).toContain('products.archived');
	});

	it('не заводит два продукта с одним кодом', async () => {
		const ctx = testActor();
		const product = {
			code: 'PRD-01',
			name: 'Платформа обучения',
			vendorOrganizationId: null,
			description: null,
			status: 'draft' as const,
			externalSource: null,
			externalId: null
		};

		await createProduct(ctx, product);
		await expect(createProduct(ctx, product)).rejects.toBeInstanceOf(ConflictError);
	});
});

describe('права и область доступа', () => {
	it('отказывает наблюдателю в записи и оставляет отказ в журнале', async () => {
		const viewer = testActor({ roleId: 'viewer' });

		await expect(createOrganization(viewer, organizationInput())).rejects.toBeInstanceOf(
			ForbiddenError
		);

		const denied = await database.db
			.select({ type: auditEvents.eventType, outcome: auditEvents.outcome })
			.from(auditEvents)
			.where(
				and(eq(auditEvents.outcome, 'denied'), eq(auditEvents.eventType, 'organizations.created'))
			);

		expect(denied).toHaveLength(1);
		expect((await listOrganizationRows(testActor(), firstPage)).total).toBe(0);
	});

	it('не даёт переписать человека тому, кто видит контакты замаскированными', async () => {
		const admin = testActor();
		const person = await createPerson(admin, {
			lastName: 'Петров',
			firstName: 'Пётр',
			middleName: null,
			email: 'petrov@vuz.ru',
			phone: null,
			notes: null
		});

		const blind = testActor({ permissions: ['people.read', 'people.write'] });

		await expect(
			updatePerson(blind, {
				id: person.id,
				lastName: 'Петров',
				firstName: 'Пётр',
				middleName: null,
				email: 'p***@vuz.ru',
				phone: null,
				notes: null
			})
		).rejects.toBeInstanceOf(ForbiddenError);

		expect((await getPerson(admin, person.id)).email).toBe('petrov@vuz.ru');
	});

	it('маскирует контакты в списке людей без права на них', async () => {
		const admin = testActor();
		await createPerson(admin, {
			lastName: 'Сидорова',
			firstName: 'Анна',
			middleName: null,
			email: 'sidorova@vuz.ru',
			phone: '+7 999 123-45-67',
			notes: null
		});

		const full = await listPeople(admin, firstPeoplePage);
		expect(full.items[0].person.email).toBe('sidorova@vuz.ru');
		expect(full.items[0].person.contactsMasked).toBe(false);

		const limited = testActor({ roleId: 'viewer' });
		const masked = await listPeople(limited, firstPeoplePage);

		expect(masked.items[0].person.email).toBe('s***@vuz.ru');
		expect(masked.items[0].person.phone).toBe('+7 *** *** 45 67');
		expect(masked.items[0].person.contactsMasked).toBe(true);
	});

	it('ограничивает список организаций областью доступа', async () => {
		const admin = testActor();
		const mine = await createOrganization(admin, organizationInput({ shortName: 'Своя' }));
		await createOrganization(admin, organizationInput({ shortName: 'Чужая' }));

		const scoped = testActor({ organizationIds: [mine.id] });
		const rows = await listOrganizationRows(scoped, firstPage);

		expect(rows.total).toBe(1);
		expect(rows.items[0].organization.shortName).toBe('Своя');
	});

	it('не показывает занятый ИНН чужой организации по имени', async () => {
		const admin = testActor();
		const hidden = await createOrganization(
			admin,
			organizationInput({ shortName: 'Секретный вуз', inn: INN })
		);
		const visible = await createOrganization(admin, organizationInput({ shortName: 'Свой вуз' }));

		const scoped = testActor({ organizationIds: [visible.id] });

		await expect(
			createOrganization(scoped, organizationInput({ shortName: 'Новый', inn: INN }))
		).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof ConflictError &&
				/уже занят другой организацией/.test(error.message) &&
				!error.message.includes('Секретный')
		);

		expect(hidden.inn).toBe(INN);
	});

	it('ищет людей и по названию организации', async () => {
		const ctx = testActor();
		const organization = await createOrganization(
			ctx,
			organizationInput({ shortName: 'Бауманка' })
		);
		const person = await createPerson(ctx, {
			lastName: 'Кузнецов',
			firstName: 'Олег',
			middleName: null,
			email: null,
			phone: null,
			notes: null
		});

		await createAffiliation(ctx, {
			personId: person.id,
			organizationId: organization.id,
			siteId: null,
			position: 'Декан',
			roleKind: 'dean',
			isPrimary: false,
			validFrom: '2026-01-01',
			validTo: null,
			channel: null
		});

		await createPerson(ctx, {
			lastName: 'Никитин',
			firstName: 'Никита',
			middleName: null,
			email: null,
			phone: null,
			notes: null
		});

		const found = await listPeople(ctx, peopleListQuerySchema.parse({ q: 'Бауманка' }));
		expect(found.items.map((item) => item.person.lastName)).toEqual(['Кузнецов']);
		expect(found.items[0].organizations.map((item) => item.label)).toEqual(['Бауманка']);
	});

	it('показывает людей чужой организации только тем, кто её видит', async () => {
		const admin = testActor();
		const mine = await createOrganization(admin, organizationInput({ shortName: 'Своя' }));
		const other = await createOrganization(admin, organizationInput({ shortName: 'Чужая' }));

		const ours = await createPerson(admin, {
			lastName: 'Наш',
			firstName: 'Пётр',
			middleName: null,
			email: null,
			phone: null,
			notes: null
		});
		const theirs = await createPerson(admin, {
			lastName: 'Чужой',
			firstName: 'Павел',
			middleName: null,
			email: null,
			phone: null,
			notes: null
		});
		await createPerson(admin, {
			lastName: 'Ничей',
			firstName: 'Нил',
			middleName: null,
			email: null,
			phone: null,
			notes: null
		});

		for (const [person, organization] of [
			[ours, mine],
			[theirs, other]
		] as const) {
			await createAffiliation(admin, {
				personId: person.id,
				organizationId: organization.id,
				siteId: null,
				position: 'Координатор',
				roleKind: 'coordinator',
				isPrimary: false,
				validFrom: '2026-01-01',
				validTo: null,
				channel: null
			});
		}

		const scoped = testActor({ organizationIds: [mine.id] });
		const rows = await listPeople(scoped, firstPeoplePage);

		// Человек без ролей ещё ничей — его прячет не область доступа, а её
		// отсутствие: закрывать его значило бы потерять только что заведённого.
		expect(rows.items.map((item) => item.person.lastName).sort()).toEqual(['Наш', 'Ничей']);
		expect(await getPerson(scoped, theirs.id).catch((error: Error) => error.name)).toBe(
			'NotFoundError'
		);
	});

	it('не показывает площадки чужой организации', async () => {
		const admin = testActor();
		const mine = await createOrganization(admin, organizationInput({ shortName: 'Своя' }));
		const other = await createOrganization(admin, organizationInput({ shortName: 'Чужая' }));

		await createSite(admin, {
			organizationId: other.id,
			kind: 'campus',
			name: 'Чужой корпус',
			address: null,
			region: null,
			externalSource: null,
			externalId: null
		});

		const scoped = testActor({ organizationIds: [mine.id] });
		expect(await listSites(scoped, other.id)).toEqual([]);

		const rows = await database.db.select({ id: sites.id }).from(sites);
		expect(rows).toHaveLength(1);
	});
});
