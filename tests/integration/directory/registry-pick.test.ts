/**
 * Сторона взаимодействия из ЕГРЮЛ на настоящей базе.
 *
 * Поле формы взаимодействия ищет в реестре, когда справочник ничего не нашёл.
 * Строки реестра сверяются со справочником по ИНН: уже заведённая и доступная
 * выбирается как есть, заведённая вне области или в архиве — не выбирается
 * вовсе, остальные заводятся по номеру выданного паспорта — с видом по полю,
 * реквизитами из выписки и происхождением в журнале.
 *
 * Сеть не участвует: ответ Dadata подменён.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditEvents, organizations } from '$lib/server/db/schema';
import { createFromRegistry, searchRegistryCandidates } from '$lib/server/enrichment/pick';
import { ValidationError } from '$lib/server/errors';
import { setSetting } from '$lib/server/settings';
import { insertOrganization, startTestDatabase, testActor, type TestDatabase } from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

process.env.DADATA_API_KEY = 'test-key';

const UNIVERSITY_INN = '7802084569';
const COMPANY_INN = '7736207543';
const EXISTING_INN = '7707083893';
const ARCHIVED_INN = '5000000001';
const LIQUIDATED_INN = '5000000002';

function party(inn: string, name: string, okved: string, status = 'ACTIVE') {
	return {
		value: name,
		data: {
			inn,
			kpp: '780201001',
			ogrn: '1027802505279',
			okved,
			branch_type: 'MAIN',
			emails: [{ value: 'info@politech.example' }],
			name: { full_with_opf: `ФГАОУ ВО «${name}»`, short_with_opf: name },
			address: { value: 'г Санкт-Петербург', data: { region_with_type: 'г Санкт-Петербург' } },
			state: { status }
		}
	};
}

let database: TestDatabase;
let fetchMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await database.stop();
});

beforeEach(async () => {
	await database.reset();
	fetchMock = vi.fn(
		async () =>
			new Response(
				JSON.stringify({
					suggestions: [
						party(UNIVERSITY_INN, 'ТАКОЙ-ТО ПОЛИТЕХНИЧЕСКИЙ УНИВЕРСИТЕТ', '85.22'),
						party(COMPANY_INN, 'ТАКОЙ-ТО ЗАВОД', '25.11'),
						party(EXISTING_INN, 'ТАКОЙ-ТО ИНСТИТУТ', '85.22'),
						party(ARCHIVED_INN, 'ТАКОЙ-ТО КОЛЛЕДЖ', '85.21'),
						party(LIQUIDATED_INN, 'ТАКОЙ-ТО ТЕХНИКУМ', '85.21', 'LIQUIDATED')
					]
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			)
	);
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('сторона взаимодействия из ЕГРЮЛ', () => {
	it('сверяет строки реестра со справочником и заводит выбранную вузом', async () => {
		const admin = testActor();
		await setSetting(admin, 'enrichment', { enabled: true, dailyQuota: 5 });

		const existingId = await insertOrganization(database.db, {
			shortName: 'Институт',
			inn: EXISTING_INN
		});
		const archivedId = await insertOrganization(database.db, { inn: ARCHIVED_INN });
		await database.db
			.update(organizations)
			.set({ isActive: false })
			.where(eq(organizations.id, archivedId));

		const candidates = await searchRegistryCandidates(admin, 'такой-то');
		const byInn = new Map(candidates.map((candidate) => [candidate.inn, candidate]));

		// Уже заведённая выбирается как есть, заводить её нечем.
		expect(byInn.get(EXISTING_INN)).toMatchObject({
			token: null,
			existing: { id: existingId, label: 'Институт' },
			unavailable: null
		});
		// Архивная и ликвидированная не выбираются.
		expect(byInn.get(ARCHIVED_INN)?.token).toBeNull();
		expect(byInn.get(ARCHIVED_INN)?.unavailable).toMatch(/вне вашей области доступа или в архиве/);
		expect(byInn.get(LIQUIDATED_INN)?.unavailable).toMatch(/ликвидирована/);
		// Завод на вуз не похож, и уровень у него не угадан.
		expect(byInn.get(COMPANY_INN)).toMatchObject({ looksEducational: false, educationLevel: null });

		const university = byInn.get(UNIVERSITY_INN);
		expect(university).toMatchObject({ looksEducational: true, educationLevel: 'vo' });
		expect(university?.token).toEqual(expect.any(String));

		const created = await createFromRegistry(
			admin,
			university?.token as string,
			'educational_institution'
		);
		const [row] = await database.db
			.select()
			.from(organizations)
			.where(eq(organizations.id, created.id));

		expect(row).toMatchObject({
			kind: 'educational_institution',
			educationLevel: 'vo',
			legalName: 'ФГАОУ ВО «ТАКОЙ-ТО ПОЛИТЕХНИЧЕСКИЙ УНИВЕРСИТЕТ»',
			shortName: 'ТАКОЙ-ТО ПОЛИТЕХНИЧЕСКИЙ УНИВЕРСИТЕТ',
			inn: UNIVERSITY_INN,
			kpp: '780201001',
			ogrn: '1027802505279',
			region: 'г Санкт-Петербург',
			website: 'https://politech.example'
		});
		expect(created.label).toBe('ТАКОЙ-ТО ПОЛИТЕХНИЧЕСКИЙ УНИВЕРСИТЕТ');

		const [event] = await database.db
			.select()
			.from(auditEvents)
			.where(
				and(
					eq(auditEvents.eventType, 'organizations.passport_applied'),
					eq(auditEvents.subjectId, created.id)
				)
			);
		const details = event.details as { provenance: { field: string; source: string }[] };

		expect(details.provenance).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ field: 'inn', source: 'dadata' }),
				expect.objectContaining({ field: 'educationLevel', source: 'guess' }),
				expect.objectContaining({ field: 'website', source: 'guess' })
			])
		);
		expect(details.provenance.map((entry) => entry.field)).not.toContain('kind');

		// Двойной щелчок не заводит вторую: выбирается уже заведённая.
		const again = await createFromRegistry(
			admin,
			university?.token as string,
			'educational_institution'
		);
		expect(again).toMatchObject({ id: created.id, created: false });
		expect(created.created).toBe(true);

		// Реестр спрашивали один раз: заведение идёт по копии сервера.
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('поле компании-заказчика заводит компанию без уровня образования', async () => {
		const admin = testActor();
		await setSetting(admin, 'enrichment', { enabled: true, dailyQuota: 5 });

		const candidates = await searchRegistryCandidates(admin, 'такой-то');
		const company = candidates.find((candidate) => candidate.inn === COMPANY_INN);

		expect(company?.educationLevel).toBeNull();

		const created = await createFromRegistry(admin, company?.token as string, 'customer_company');
		const [row] = await database.db
			.select()
			.from(organizations)
			.where(eq(organizations.id, created.id));

		expect(row).toMatchObject({ kind: 'customer_company', educationLevel: null });
	});

	it('чужой номер строки неотличим от истёкшего', async () => {
		const admin = testActor();
		await setSetting(admin, 'enrichment', { enabled: true, dailyQuota: 5 });

		const candidates = await searchRegistryCandidates(admin, 'такой-то');
		const token = candidates.find((candidate) => candidate.inn === COMPANY_INN)?.token as string;
		const stranger = testActor({ userId: '00000000-0000-4000-8000-0000000000aa' });

		await expect(createFromRegistry(stranger, token, 'customer_company')).rejects.toBeInstanceOf(
			ValidationError
		);
	});
});
