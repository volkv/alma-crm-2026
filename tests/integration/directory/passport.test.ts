/**
 * Паспорт организации на настоящей базе: без подтверждения ничего не пишется.
 *
 * Поиск по реестру отвечает паспортом, и справочник от этого не меняется —
 * ни строка организации, ни журнал. Запись случается только сохранением формы,
 * и тогда в журнале у каждого принятого поля — источник и момент ответа,
 * взятые из выданного сервером паспорта, а не из того, что прислал браузер.
 *
 * Сеть не участвует: ответ Dadata подменён.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditEvents, organizations } from '$lib/server/db/schema';
import { getOrganization } from '$lib/server/directory/read';
import { updateOrganization } from '$lib/server/directory/write';
import { lookupRegistry } from '$lib/server/enrichment';
import { resolveAcceptance } from '$lib/server/enrichment/passports';
import { setSetting } from '$lib/server/settings';
import { insertOrganization, startTestDatabase, testActor, type TestDatabase } from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

process.env.DADATA_API_KEY = 'test-key';

const INN = '7802084569';

let database: TestDatabase;

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await database.stop();
});

beforeEach(async () => {
	await database.reset();
	vi.stubGlobal(
		'fetch',
		vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						suggestions: [
							{
								value: 'ТАКОЙ-ТО ПОЛИТЕХ',
								data: {
									inn: INN,
									kpp: '780201001',
									ogrn: '1027801570540',
									okved: '85.22',
									branch_type: 'MAIN',
									name: {
										full_with_opf: 'ФГАОУ ВО «ТАКОЙ-ТО ПОЛИТЕХНИЧЕСКИЙ УНИВЕРСИТЕТ»',
										short_with_opf: 'ТАКОЙ-ТО ПОЛИТЕХ'
									},
									address: {
										value: 'г Санкт-Петербург',
										data: { region_with_type: 'г Санкт-Петербург' }
									},
									state: { status: 'ACTIVE' }
								}
							}
						]
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				)
		)
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('паспорт организации', () => {
	it('поиск ничего не пишет; сохранение пишет принятое с источником и датой', async () => {
		const admin = testActor();
		const id = await insertOrganization(database.db, { shortName: 'Политех', inn: null });

		await setSetting(admin, 'enrichment', { enabled: true, dailyQuota: 5 });

		const before = await getOrganization(admin, id);
		const issued = await lookupRegistry(admin, INN);

		// Паспорт предложил реквизиты, но справочник их не видел.
		expect(issued.passport.fields.kpp?.value).toBe('780201001');
		expect(await getOrganization(admin, id)).toEqual(before);
		expect(
			await database.db
				.select()
				.from(auditEvents)
				.where(eq(auditEvents.eventType, 'organizations.passport_applied'))
		).toHaveLength(0);

		// Сотрудник принял ИНН и КПП, а ОГРН поправил руками после приёмки.
		const { id: _id, createdAt: _created, updatedAt: _updated, ...fields } = before;
		const values = { ...fields, inn: INN, kpp: '780201001', ogrn: '1027800000000' };
		const provenance = await resolveAcceptance(
			admin,
			[
				{ token: issued.token, field: 'inn' },
				{ token: issued.token, field: 'kpp' },
				{ token: issued.token, field: 'ogrn' }
			],
			values
		);

		expect(provenance.map((entry) => entry.field)).toEqual(['inn', 'kpp']);

		await updateOrganization(admin, { ...values, id }, provenance);

		const [row] = await database.db.select().from(organizations).where(eq(organizations.id, id));
		expect(row.kpp).toBe('780201001');

		const [event] = await database.db
			.select()
			.from(auditEvents)
			.where(
				and(
					eq(auditEvents.eventType, 'organizations.passport_applied'),
					eq(auditEvents.subjectId, id)
				)
			);

		expect(event.details).toMatchObject({
			provenance: [
				{ field: 'inn', source: 'dadata', via: 'live' },
				{ field: 'kpp', source: 'dadata', via: 'live' }
			]
		});
		const fetchedAt = issued.passport.fields.inn?.fetchedAt;
		expect(event.details).toMatchObject({ provenance: [{ fetchedAt }, { fetchedAt }] });
	});
});
