/**
 * Заведение записей справочника из форм: похожая организация находится по
 * сайту и ОГРН, а человек из формы «Новый человек» получает основание
 * обработки своих данных той же транзакцией.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { consents } from '$lib/server/db/schema';
import { findPossibleDuplicates } from '$lib/server/directory/read';
import { createOrganization, createPersonWithBasis } from '$lib/server/directory/write';
import { startTestDatabase, testActor, type TestDatabase } from '../helpers/db';

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

describe('новая организация', () => {
	it('похожая находится по сайту без схемы и www и по ОГРН, чужой сайт — нет', async () => {
		const actor = testActor();
		const existing = await createOrganization(actor, {
			kind: 'educational_institution',
			educationLevel: 'vo',
			legalName: 'Приволжский технический университет',
			shortName: 'ПрвТУ',
			inn: null,
			kpp: null,
			ogrn: '1023403446362',
			region: null,
			website: 'https://www.prvtu.example.ru/',
			notes: null,
			isActive: true,
			externalSource: null,
			externalId: null
		});

		await expect(
			findPossibleDuplicates(actor, { ogrn: null, website: 'prvtu.example.ru/sveden' })
		).resolves.toEqual([{ id: existing.id, label: 'ПрвТУ', reason: 'website' }]);
		await expect(
			findPossibleDuplicates(actor, { ogrn: '1023403446362', website: null })
		).resolves.toEqual([{ id: existing.id, label: 'ПрвТУ', reason: 'ogrn' }]);
		await expect(
			findPossibleDuplicates(actor, { ogrn: null, website: 'https://other.example.ru' })
		).resolves.toEqual([]);
	});
});

describe('новый человек', () => {
	it('заводится вместе с основанием обработки', async () => {
		const person = await createPersonWithBasis(testActor(), {
			lastName: 'Тестова',
			firstName: 'Анна',
			middleName: null,
			email: null,
			phone: null,
			notes: null,
			basis: 'contract'
		});

		const rows = await database.db
			.select({ basis: consents.basis })
			.from(consents)
			.where(eq(consents.personId, person.id));

		expect(rows).toEqual([{ basis: 'contract' }]);
	});
});
