/**
 * Состав карточки объявляет процесс: панели и шаблоны лежат на процессе, их
 * заполняет миграция, правит администратор, а карточка и сборка документов
 * читают их оттуда. Проверка на настоящей базе — значения держит проверка по
 * каталогу в схеме, и именно её миграция обязана пройти.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '$lib/server/errors';
import { generateDocument } from '$lib/server/documents/generate';
import { getInteraction } from '$lib/server/interactions/read';
import { B2C_PROCESS } from '$lib/server/stages/definitions';
import { getProcessCard, readInteractionCard, updateProcessCard } from '$lib/server/stages/card';
import { startTestDatabase, testActor, type TestDatabase } from '../helpers/db';
import {
	B2B_PROCESS,
	B2B_WORKSPACE_KEY,
	B2C_WORKSPACE_KEY,
	createInteractionOn,
	seedProcess
} from './fixture';

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

describe('состав карточки процесса', () => {
	it('B2C получает свою карточку без вузовских панелей, правка читается обратно и держит шаблоны', async () => {
		const ctx = testActor({ roleId: 'admin' });
		await seedProcess(database, B2B_WORKSPACE_KEY, B2B_PROCESS);
		await seedProcess(database, B2C_WORKSPACE_KEY, B2C_PROCESS);
		const { interactionId } = await createInteractionOn(ctx, database, { kind: 'legal_entity' });

		expect(await getProcessCard(ctx, 'b2b')).toEqual({
			panels: ['terms', 'contract', 'learning', 'documents'],
			templates: ['agreement']
		});

		const card = await readInteractionCard(await getInteraction(ctx, interactionId));

		expect(card).toEqual({
			panels: ['terms', 'payment', 'learners', 'learning', 'training_document', 'documents'],
			templates: [],
			counterpartyKind: 'legal_entity'
		});

		// Соглашение с вузом процесс обучения лиц не предлагает — и сервер
		// отказывает, даже если форму отправили в обход кнопки.
		await expect(
			generateDocument(ctx, {
				templateKey: 'agreement',
				interactionId,
				title: 'Соглашение',
				formats: ['docx'],
				data: {}
			})
		).rejects.toThrow('Шаблон недоступен в этом процессе');

		// Порядок задаёт каталог, а не форма; панель вне каталога — отказ.
		expect(
			await updateProcessCard(ctx, 'b2c', { panels: ['documents', 'contract'], templates: [] })
		).toEqual({ panels: ['contract', 'documents'], templates: [] });
		expect(await getProcessCard(ctx, 'b2c')).toEqual({
			panels: ['contract', 'documents'],
			templates: []
		});
		await expect(
			updateProcessCard(ctx, 'b2c', { panels: ['licenses'], templates: [] })
		).rejects.toThrow(ValidationError);
	});
});
