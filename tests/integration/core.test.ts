import { asc } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditFilterSchema } from '$lib/contracts/audit';
import { pageQuerySchema } from '$lib/contracts/common';
import { organizationListQuerySchema } from '$lib/contracts/directory';
import { exportAuditEvents, listAuditEvents, recordAuditEvent } from '$lib/server/audit';
import { auditEvents } from '$lib/server/db/schema';
import { withTransaction } from '$lib/server/db/transaction';
import { getOrganization, listOrganizations } from '$lib/server/directory/read';
import { ForbiddenError, NotFoundError, ValidationError } from '$lib/server/errors';
import { toPersonView } from '$lib/server/people/serialize';
import { can, loadRolePermissions, requirePermission } from '$lib/server/rbac';
import { defaultRolePermissions } from '$lib/server/rbac/seed';
import { getSetting, setSetting } from '$lib/server/settings';
import { insertOrganization, startTestDatabase, testActor, type TestDatabase } from './helpers/db';

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

const emptyFilter = auditFilterSchema.parse({});
const firstPage = pageQuerySchema.parse({});

describe('запись в журнал', () => {
	it('сохраняет отказ и теряет успех, если транзакция откатилась', async () => {
		const ctx = testActor();

		await expect(
			withTransaction(ctx, async (tx) => {
				await recordAuditEvent(ctx, { type: 'organizations.created', outcome: 'success' }, tx);
				await recordAuditEvent(ctx, { type: 'organizations.created', outcome: 'denied' }, tx);

				throw new Error('операция не удалась');
			})
		).rejects.toThrow('операция не удалась');

		const rows = await database.db
			.select({ outcome: auditEvents.outcome })
			.from(auditEvents)
			.orderBy(asc(auditEvents.occurredAt));

		expect(rows).toEqual([{ outcome: 'denied' }]);
	});

	it('отвергает подробности с персональными данными', async () => {
		const ctx = testActor();

		await expect(
			recordAuditEvent(ctx, {
				type: 'people.updated',
				outcome: 'success',
				// @ts-expect-error — тип запрещает такой ключ, проверяем и защиту во время работы
				details: { email: 'ivanov@vuz.ru' }
			})
		).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof ValidationError &&
				error.issues.some((issue) => /персональные данные/.test(issue))
		);

		const rows = await database.db.select({ id: auditEvents.id }).from(auditEvents);
		expect(rows).toEqual([]);
	});

	it('отдаёт журнал только с правом на чтение и выгружает его с правом на выгрузку', async () => {
		const admin = testActor();
		await recordAuditEvent(admin, { type: 'auth.login', outcome: 'success' });

		const viewer = testActor({ roleId: 'viewer' });
		await expect(listAuditEvents(viewer, emptyFilter, firstPage)).rejects.toBeInstanceOf(
			ForbiddenError
		);

		const page = await listAuditEvents(admin, emptyFilter, firstPage);
		expect(page.total).toBe(1);
		expect(page.items[0]?.eventType).toBe('auth.login');

		const exported = await exportAuditEvents(admin, emptyFilter, 'csv');
		expect(exported.fileName).toMatch(/^audit-\d{4}-\d{2}-\d{2}\.csv$/);
		expect(exported.body).toContain('auth.login');
		// Сама выгрузка тоже событие журнала.
		expect((await listAuditEvents(admin, emptyFilter, firstPage)).total).toBe(2);
	});
});

describe('права ролей', () => {
	it('совпадают в базе и в коде для всех системных ролей', async () => {
		for (const roleId of ['admin', 'lead', 'manager', 'viewer', 'service']) {
			const fromDatabase = await loadRolePermissions(roleId);

			expect(new Set(fromDatabase)).toEqual(new Set(defaultRolePermissions(roleId)));
		}
	});

	it('разделяют чтение, запись и контакты людей', async () => {
		const admin = testActor({ roleId: 'admin' });
		const lead = testActor({ roleId: 'lead' });
		const manager = testActor({ roleId: 'manager' });
		const viewer = testActor({ roleId: 'viewer' });

		expect(can(admin, 'settings.write')).toBe(true);
		expect(can(manager, 'settings.write')).toBe(false);
		expect(can(manager, 'interactions.write')).toBe(true);
		expect(can(manager, 'people.read_pii')).toBe(true);
		expect(can(viewer, 'organizations.read')).toBe(true);
		expect(can(viewer, 'organizations.write')).toBe(false);
		expect(can(viewer, 'people.read_pii')).toBe(false);

		// Руководитель отличается от менеджера ровно распределением нагрузки и
		// журналом — настройки и процесс остаются за администратором.
		expect(can(lead, 'responsibles.manage')).toBe(true);
		expect(can(lead, 'interactions.reassign')).toBe(true);
		expect(can(lead, 'audit.read')).toBe(true);
		expect(can(lead, 'stages.configure')).toBe(false);
		expect(can(manager, 'responsibles.manage')).toBe(false);
		expect(can(manager, 'audit.read')).toBe(false);

		expect(() => requirePermission(viewer, 'organizations.write')).toThrow(ForbiddenError);
		expect(() => requirePermission(admin, 'organizations.write')).not.toThrow();
	});

	it('оставляют машинному субъекту ровно три права обмена', () => {
		const service = testActor({ roleId: 'service' });

		expect([...defaultRolePermissions('service')].sort()).toStrictEqual([
			'exchange.intake',
			'exchange.results',
			'stages.confirm'
		]);

		// Подтвердить стадию и двигать взаимодействие — разные полномочия, и
		// внешняя система имеет только первое.
		expect(can(service, 'stages.confirm')).toBe(true);
		expect(can(service, 'stages.transition')).toBe(false);
		expect(can(service, 'interactions.write')).toBe(false);
		expect(can(service, 'interactions.read')).toBe(false);
	});

	it('отказ с описанием события оставляет след в журнале, а разрешение — нет', async () => {
		const viewer = testActor({ roleId: 'viewer' });
		const admin = testActor({ roleId: 'admin' });
		const subjectId = '00000000-0000-4000-8000-0000000000bb';

		await expect(
			requirePermission(viewer, 'organizations.write', {
				type: 'organizations.created',
				subject: { type: 'organization', id: subjectId }
			})
		).rejects.toBeInstanceOf(ForbiddenError);

		await expect(
			requirePermission(admin, 'organizations.write', { type: 'organizations.created' })
		).resolves.toBeUndefined();

		// Ровно одна строка: запись об отказе, и только о нём. Проверка, которая
		// прошла, — это не событие: её следом будет само действие.
		const rows = await database.db
			.select({
				outcome: auditEvents.outcome,
				eventType: auditEvents.eventType,
				subjectId: auditEvents.subjectId
			})
			.from(auditEvents);

		expect(rows).toEqual([{ outcome: 'denied', eventType: 'organizations.created', subjectId }]);
	});
});

describe('область доступа', () => {
	it('отсекает чужие организации в списке и в карточке', async () => {
		const mine = await insertOrganization(database.db, { shortName: 'Свой вуз' });
		const alsoMine = await insertOrganization(database.db, { shortName: 'Тоже свой' });
		const foreign = await insertOrganization(database.db, { shortName: 'Чужой вуз' });

		const scoped = testActor({ organizationIds: [mine, alsoMine] });
		const query = organizationListQuerySchema.parse({});

		const page = await listOrganizations(scoped, query);
		expect(page.total).toBe(2);
		expect(page.items.map((item) => item.id).sort()).toEqual([mine, alsoMine].sort());

		await expect(getOrganization(scoped, foreign)).rejects.toBeInstanceOf(NotFoundError);
		await expect(getOrganization(scoped, mine)).resolves.toMatchObject({ id: mine });

		// Полный доступ видит всё; пустая область — ничего.
		expect((await listOrganizations(testActor(), query)).total).toBe(3);
		expect((await listOrganizations(testActor({ organizationIds: [] }), query)).total).toBe(0);
	});
});

describe('сериализатор человека', () => {
	const person = {
		id: '00000000-0000-4000-8000-0000000000aa',
		lastName: 'Иванов',
		firstName: 'Иван',
		middleName: 'Иванович',
		email: 'ivanov@vuz.ru',
		phone: '+7 (999) 123-45-67',
		notes: null,
		retentionUntil: null,
		anonymizedAt: null
	};

	it('маскирует контакты без права и показывает их с правом', () => {
		const masked = toPersonView(testActor({ roleId: 'viewer' }), person);

		expect(masked.email).toBe('i***@vuz.ru');
		expect(masked.phone).toBe('+7 *** *** 45 67');
		expect(masked.contactsMasked).toBe(true);
		expect(masked.lastName).toBe('Иванов');

		const full = toPersonView(testActor({ roleId: 'manager' }), person);

		expect(full.email).toBe('ivanov@vuz.ru');
		expect(full.phone).toBe('+7 (999) 123-45-67');
		expect(full.contactsMasked).toBe(false);
	});

	it('оставляет пустые контакты пустыми', () => {
		const view = toPersonView(testActor({ roleId: 'viewer' }), {
			...person,
			email: null,
			phone: null
		});

		expect(view.email).toBeNull();
		expect(view.phone).toBeNull();
	});
});

describe('настройки', () => {
	it('подставляют значение по умолчанию и запоминают заданное', async () => {
		expect(await getSetting('session_idle_minutes')).toBe(30);
		expect(await getSetting('password_policy')).toEqual({ minLength: 12, minClasses: 3 });

		const admin = testActor();
		await setSetting(admin, 'session_idle_minutes', 45);

		expect(await getSetting('session_idle_minutes')).toBe(45);
	});

	it('не пускают чужую руку и недопустимое значение', async () => {
		const viewer = testActor({ roleId: 'viewer' });
		await expect(setSetting(viewer, 'session_idle_minutes', 45)).rejects.toBeInstanceOf(
			ForbiddenError
		);

		const admin = testActor();
		await expect(setSetting(admin, 'session_idle_minutes', 1)).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof ValidationError && error.issues.some((issue) => /5 минут/.test(issue))
		);
	});
});
