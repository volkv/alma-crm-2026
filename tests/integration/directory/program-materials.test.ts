/**
 * Материалы образовательной программы: файлы с полным описанием, которые
 * уходят вузу вложением.
 *
 * Держит один инвариант: `listProgramMaterials` отдаёт ровно то, что приложено
 * к программе, в порядке загрузки, и снятие связи убирает материал из списка,
 * не трогая сам документ и файл в хранилище.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { documents, programs } from '$lib/server/db/schema';
import {
	addProgramMaterials,
	listProgramMaterials,
	removeProgramMaterial
} from '$lib/server/directory/program-materials';
import { ForbiddenError, ValidationError } from '$lib/server/errors';
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

function pdf(marker: string) {
	return new TextEncoder().encode(`%PDF-1.4\n%${marker}`);
}

async function insertProgram(code: string): Promise<string> {
	const [row] = await database.db
		.insert(programs)
		.values({ code, name: `Программа ${code}`, level: 'dpo', description: 'Коротко о курсе' })
		.returning({ id: programs.id });

	return row.id;
}

describe('материалы программы', () => {
	it('загрузка попадает в listProgramMaterials, снятие связи убирает её оттуда', async () => {
		const ctx = testActor({ roleId: 'admin' });
		const programId = await insertProgram('DEVOPS-1');
		const otherId = await insertProgram('QA-1');

		const added = await addProgramMaterials(ctx, programId, [
			{ name: 'Программа курса.pdf', mime: 'application/pdf', bytes: pdf('course') },
			{ name: 'Учебный план.PDF', mime: 'application/pdf', bytes: pdf('plan') }
		]);
		await addProgramMaterials(ctx, otherId, [
			{ name: 'Чужая программа.pdf', mime: 'application/pdf', bytes: pdf('other') }
		]);

		const listed = await listProgramMaterials([programId]);

		expect(listed.map((material) => material.fileName)).toStrictEqual([
			'Программа курса.pdf',
			'Учебный план.pdf'
		]);
		expect(listed).toStrictEqual(added);
		expect(listed.every((material) => material.programId === programId)).toBe(true);
		expect(await database.storage.read(listed[0].filePath)).toStrictEqual(
			Buffer.from(pdf('course'))
		);
		expect(await listProgramMaterials([programId, otherId])).toHaveLength(3);

		await removeProgramMaterial(ctx, programId, listed[0].documentId);

		expect(
			(await listProgramMaterials([programId])).map((material) => material.documentId)
		).toStrictEqual([listed[1].documentId]);

		// Снята только связь: документ и его файл остаются.
		const [kept] = await database.db
			.select({ id: documents.id })
			.from(documents)
			.where(eq(documents.id, listed[0].documentId));
		expect(kept?.id).toBe(listed[0].documentId);
		expect(await database.storage.keys('files/')).toContain(listed[0].filePath);
	});

	it('отказ по типу или правам не оставляет ни строк, ни файлов', async () => {
		const programId = await insertProgram('DEVOPS-2');
		// Бакет файла тестов между тестами не чистится: сверяем с тем, что было.
		const objectsBefore = await database.storage.keys('');

		await expect(
			addProgramMaterials(testActor({ roleId: 'admin' }), programId, [
				{ name: 'Программа.pdf', mime: 'application/pdf', bytes: pdf('ok') },
				{ name: 'Заметки.txt', mime: 'text/plain', bytes: new TextEncoder().encode('текст') }
			])
		).rejects.toBeInstanceOf(ValidationError);

		await expect(
			addProgramMaterials(testActor({ roleId: 'manager' }), programId, [
				{ name: 'Программа.pdf', mime: 'application/pdf', bytes: pdf('ok') }
			])
		).rejects.toBeInstanceOf(ForbiddenError);

		expect(await listProgramMaterials([programId])).toStrictEqual([]);
		expect(await database.db.select({ id: documents.id }).from(documents)).toStrictEqual([]);
		expect(await database.storage.keys('')).toStrictEqual(objectsBefore);
	});
});
