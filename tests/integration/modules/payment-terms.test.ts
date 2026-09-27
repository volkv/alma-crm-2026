/**
 * Стоимость дела — коммерческое условие, которое ведёт модуль «Оплата»: она
 * сохраняется, читается и не затирает чужую правку из соседней вкладки.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatPriceRub, setInteractionTermsSchema } from '$lib/contracts/terms';
import { ConflictError } from '$lib/server/errors';
import { readModuleFact } from '$lib/server/platform/module-facts';
import {
	readInteractionTerms,
	setInteractionTerms
} from '../../../src/modules/payment/server/terms';
import { B2C_PROCESS } from '$lib/server/stages/definitions';
import { startTestDatabase, testActor, type TestDatabase } from '../helpers/db';
import { B2C_WORKSPACE_KEY, createInteractionOn, seedProcess } from '../stages/fixture';

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

describe('стоимость дела', () => {
	it('сохраняется, читается и отказывает правке по устаревшей версии', async () => {
		const ctx = testActor({ roleId: 'admin' });
		await seedProcess(database, B2C_WORKSPACE_KEY, B2C_PROCESS);
		const { interactionId } = await createInteractionOn(ctx, database, { kind: 'legal_entity' });

		expect(await readInteractionTerms(ctx, interactionId)).toMatchObject({
			priceKopecks: null,
			version: 0
		});

		const saved = await setInteractionTerms(
			ctx,
			setInteractionTermsSchema.parse({ interactionId, version: '0', price: '45 000,50 ₽' })
		);
		expect(saved).toMatchObject({ priceKopecks: 4_500_050, version: 1 });
		expect(await readInteractionTerms(ctx, interactionId)).toMatchObject({
			priceKopecks: 4_500_050,
			version: 1
		});

		// Форма, открытая до сохранения, несёт версию 0 — её правка не проходит.
		await expect(
			setInteractionTerms(
				ctx,
				setInteractionTermsSchema.parse({ interactionId, version: '0', price: '1' })
			)
		).rejects.toBeInstanceOf(ConflictError);

		const cleared = await setInteractionTerms(
			ctx,
			setInteractionTermsSchema.parse({ interactionId, version: '1', price: '' })
		);
		expect(cleared).toMatchObject({ priceKopecks: null, version: 2 });

		// Каждая правка стоимости — строка ленты с прежним значением.
		const fact = await readModuleFact(database.db, interactionId, 'payment', 'price');
		expect(fact?.text).toBe(`Стоимость: — (было: ${formatPriceRub(4_500_050)})`);
	}, 60_000);
});
