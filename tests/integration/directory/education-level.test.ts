/**
 * Уровень образования на настоящей базе: у вуза необязателен, у остальных
 * видов запрещён.
 *
 * Правило держат и схема формы, и CHECK в базе; здесь проверяется второе —
 * запись в обход формы (импорт, обмен с сайтом, заведение из ЕГРЮЛ) упирается
 * в то же ограничение.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { organizations } from '$lib/server/db/schema';
import { createOrganization } from '$lib/server/directory/write';
import { startTestDatabase, testActor, type TestDatabase } from '../helpers/db';

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

describe('уровень образования', () => {
	it('вуз заводится без уровня', async () => {
		const created = await createOrganization(testActor(), {
			kind: 'educational_institution',
			educationLevel: null,
			legalName: 'Федеральное государственное учреждение',
			shortName: 'Вуз без уровня',
			inn: null,
			kpp: null,
			ogrn: null,
			region: null,
			website: null,
			notes: null,
			isActive: true,
			externalSource: null,
			externalId: null
		});

		const [row] = await database.db
			.select({ educationLevel: organizations.educationLevel })
			.from(organizations)
			.where(eq(organizations.id, created.id));

		expect(row.educationLevel).toBeNull();
	});

	it('у компании-заказчика уровень отвергает база', async () => {
		await expect(
			database.db.insert(organizations).values({
				kind: 'customer_company',
				educationLevel: 'vo',
				legalName: 'ООО «Заказчик»',
				shortName: 'Заказчик'
			})
		).rejects.toThrow();
	});
});
