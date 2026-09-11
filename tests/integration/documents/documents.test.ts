import { execFile } from 'node:child_process';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import PizZip from 'pizzip';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	auditEvents,
	documentTemplates,
	documents,
	interactionParties
} from '$lib/server/db/schema';
import { generateDocument } from '$lib/server/documents/generate';
import { readDocumentForDownload } from '$lib/server/documents/read';
import { markDocument } from '$lib/server/documents/status';
import { resolveStoredPath } from '$lib/server/documents/storage';
import { ensureTemplateRegistered } from '$lib/server/documents/templates';
import { uploadDocument } from '$lib/server/documents/upload';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '$lib/server/errors';
import {
	insertInteractionWithStage,
	insertOrganization,
	startTestDatabase,
	testActor,
	TEST_USER_IDS,
	type TestDatabase
} from '../helpers/db';

// См. комментарий в `schema.test.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

const run = promisify(execFile);

let database: TestDatabase;
/** Каталог данных, который `startTestDatabase` прописывает в окружение. */
let dataDir: string;

beforeAll(async () => {
	database = await startTestDatabase();
	dataDir = resolve(process.env.DATA_DIR ?? './.test-data');

	// Предыдущий прогон мог упасть и оставить файлы; хранилище должно начинаться пустым.
	await rm(dataDir, { recursive: true, force: true });
}, 300_000);

afterAll(async () => {
	await database?.stop();
	await rm(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
	await database.reset();
});

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Данные соглашения — с кириллицей, кавычками-ёлочками и списком программ. */
const AGREEMENT = {
	city: 'Москва',
	date: '12 сентября 2026 г.',
	operatorName: 'ООО «Оператор образовательных программ»',
	operatorSigner: 'генерального директора Петрова П. П.',
	institutionName: 'ФГБОУ ВО «Московский технический университет»',
	institutionSigner: 'ректора Сидорова С. С.',
	customerName: 'ПАО «Отраслевой заказчик»',
	periodStart: '01.09.2026',
	periodEnd: '31.08.2027',
	programs: [{ name: 'Разработка программного обеспечения' }, { name: 'Анализ данных' }]
};

/** Взаимодействие с одной стороной-вузом: на нём проверяется область доступа. */
async function interactionWithParty(): Promise<{
	interactionId: string;
	organizationId: string;
}> {
	const organizationId = await insertOrganization(database.db);
	const { interactionId } = await insertInteractionWithStage(database.db, {
		ownerUserId: TEST_USER_IDS.admin
	});

	await database.db.insert(interactionParties).values({
		interactionId,
		organizationId,
		partyRole: 'educational_institution',
		isPrimary: true
	});

	return { interactionId, organizationId };
}

/** Сколько файлов лежит в хранилище и сколько осталось во временном каталоге. */
async function storageCounts(): Promise<{ files: number; tmp: number }> {
	const count = async (directory: string): Promise<number> => {
		try {
			return (await readdir(join(dataDir, directory))).length;
		} catch {
			// Каталога ещё нет — значит, в нём ноль файлов.
			return 0;
		}
	};

	return { files: await count('files'), tmp: await count('tmp') };
}

/** Текст документа Word без разметки: подстановки видно как есть. */
function docxText(content: Buffer): string {
	const part = new PizZip(content).file('word/document.xml');

	if (part === null) {
		throw new Error('В пакете нет word/document.xml');
	}

	return part.asText().replace(/<[^>]*>/g, '');
}

async function readStoredDocument(documentId: string): Promise<Buffer> {
	const [row] = await database.db
		.select({ filePath: documents.filePath })
		.from(documents)
		.where(eq(documents.id, documentId));

	return readFile(resolveStoredPath(row.filePath));
}

describe('регистрация шаблона', () => {
	it('переносит файл из поставки в хранилище и второй раз ничего не пишет', async () => {
		const ctx = testActor();

		const first = await ensureTemplateRegistered(ctx, 'agreement');

		expect(first.key).toBe('agreement');
		expect(first.version).toBe(1);
		expect(first.filePath).toMatch(/^files\//);
		expect(first.variables.map((variable) => variable.key)).toContain('programs');

		const second = await ensureTemplateRegistered(ctx, 'agreement');

		expect(second.id).toBe(first.id);
		expect(second.version).toBe(1);

		const rows = await database.db.select().from(documentTemplates);
		expect(rows).toHaveLength(1);
	});

	it('перерегистрирует шаблон, если файла в хранилище не стало', async () => {
		const ctx = testActor();
		const first = await ensureTemplateRegistered(ctx, 'agreement');

		await rm(resolveStoredPath(first.filePath));

		const second = await ensureTemplateRegistered(ctx, 'agreement');

		expect(second.id).toBe(first.id);
		expect(second.version).toBe(2);
		expect(second.filePath).not.toBe(first.filePath);
	});
});

describe('генерация документа', () => {
	it('делает DOCX с русскими данными, списком программ и записью в журнале', async () => {
		const ctx = testActor();
		const { interactionId } = await interactionWithParty();

		const [document] = await generateDocument(ctx, {
			templateKey: 'agreement',
			interactionId,
			title: 'Соглашение с МГТУ',
			data: AGREEMENT,
			formats: ['docx']
		});

		expect(document.mime).toBe(DOCX_MIME);
		expect(document.kind).toBe('generated');
		expect(document.interactionId).toBe(interactionId);
		expect(document.sizeBytes).toBeGreaterThan(0);
		expect(document.sha256).toMatch(/^[0-9a-f]{64}$/);

		const text = docxText(await readStoredDocument(document.id));

		expect(text).toContain('ФГБОУ ВО «Московский технический университет»');
		expect(text).toContain('Разработка программного обеспечения');
		expect(text).toContain('Анализ данных');
		expect(text).toContain('01.09.2026');
		// Ни одного незаполненного тега в готовом документе.
		expect(text).not.toMatch(/\{[^}]+\}/);

		const [event] = await database.db
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'documents.generated'));

		expect(event.subjectId).toBe(document.id);
		expect(event.details).toMatchObject({ documentId: document.id, interactionId });
	});

	it('печатает PDF, и кириллица в нём читается', async () => {
		const ctx = testActor();

		const created = await generateDocument(ctx, {
			templateKey: 'agreement',
			title: 'Соглашение с МГТУ',
			data: AGREEMENT,
			formats: ['pdf', 'docx']
		});

		// Порядок ответа задан самим перечнем форматов, а не порядком в запросе.
		expect(created.map((document) => document.mime)).toEqual([DOCX_MIME, 'application/pdf']);

		const pdf = created[1];
		const [row] = await database.db
			.select({ filePath: documents.filePath })
			.from(documents)
			.where(eq(documents.id, pdf.id));

		const { stdout } = await run('pdftotext', ['-layout', resolveStoredPath(row.filePath), '-'], {
			maxBuffer: 8 * 1024 * 1024
		});

		expect(stdout).toContain('СОГЛАШЕНИЕ О СОТРУДНИЧЕСТВЕ');
		expect(stdout).toContain('Московский технический университет');
		expect(stdout).toContain('Разработка программного обеспечения');

		expect(
			await database.db
				.select()
				.from(auditEvents)
				.where(eq(auditEvents.eventType, 'documents.generated'))
		).toHaveLength(2);
	});

	it('не заполняет шаблон, когда тегу нечего подставить', async () => {
		const ctx = testActor();

		// Обязательное поле не передали вовсе.
		const { city: _city, ...withoutCity } = AGREEMENT;

		await expect(
			generateDocument(ctx, {
				templateKey: 'agreement',
				title: 'Соглашение',
				data: withoutCity,
				formats: ['docx']
			})
		).rejects.toSatisfy(
			(error: unknown) => error instanceof ValidationError && error.issues.includes('city')
		);

		// Тег внутри цикла: объявленных переменных он не нарушает, но значения нет.
		await expect(
			generateDocument(ctx, {
				templateKey: 'agreement',
				title: 'Соглашение',
				data: { ...AGREEMENT, programs: [{}] },
				formats: ['docx']
			})
		).rejects.toSatisfy(
			(error: unknown) => error instanceof ValidationError && error.issues.includes('name')
		);

		expect(await database.db.select().from(documents)).toEqual([]);
		expect((await storageCounts()).tmp).toBe(0);
	});

	it('не оставляет файлов, если запись в базу не удалась', async () => {
		const ctx = testActor();

		// Шаблон регистрируется первым же обращением и тоже кладёт файл в
		// хранилище; считаем от состояния, в котором он уже там.
		await ensureTemplateRegistered(ctx, 'agreement');
		const before = await storageCounts();

		await database.raw.unsafe(
			"alter table documents add constraint tmp_reject_writes check (kind <> 'generated')"
		);

		try {
			await expect(
				generateDocument(ctx, {
					templateKey: 'agreement',
					title: 'Соглашение',
					data: AGREEMENT,
					formats: ['docx', 'pdf']
				})
			).rejects.toThrow();
		} finally {
			await database.raw.unsafe('alter table documents drop constraint tmp_reject_writes');
		}

		expect(await database.db.select().from(documents)).toEqual([]);
		expect(await storageCounts()).toEqual(before);
	});

	it('требует право на генерацию и не пускает в чужое взаимодействие', async () => {
		const { interactionId, organizationId } = await interactionWithParty();

		await expect(
			generateDocument(testActor({ roleId: 'viewer' }), {
				templateKey: 'agreement',
				title: 'Соглашение',
				data: AGREEMENT,
				formats: ['docx']
			})
		).rejects.toBeInstanceOf(ForbiddenError);

		const other = await insertOrganization(database.db, { shortName: 'Чужой вуз' });

		await expect(
			generateDocument(testActor({ roleId: 'manager', organizationIds: [other] }), {
				templateKey: 'agreement',
				interactionId,
				title: 'Соглашение',
				data: AGREEMENT,
				formats: ['docx']
			})
		).rejects.toBeInstanceOf(NotFoundError);

		await expect(
			generateDocument(testActor({ roleId: 'manager', organizationIds: [organizationId] }), {
				templateKey: 'agreement',
				interactionId,
				title: 'Соглашение',
				data: AGREEMENT,
				formats: ['docx']
			})
		).resolves.toHaveLength(1);
	});
});

describe('загрузка файла', () => {
	const pdfBytes = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n', 'latin1');

	it('кладёт файл в хранилище и пишет событие журнала', async () => {
		const ctx = testActor();
		const { interactionId } = await interactionWithParty();

		const document = await uploadDocument(ctx, {
			interactionId,
			kind: 'agreement',
			title: 'Скан подписанного соглашения',
			file: { mime: 'application/pdf', bytes: pdfBytes }
		});

		expect(document.sizeBytes).toBe(pdfBytes.byteLength);
		expect(document.uploadedBy).toBe(TEST_USER_IDS.admin);
		expect(await readStoredDocument(document.id)).toEqual(pdfBytes);

		const [event] = await database.db
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'documents.uploaded'));

		expect(event.subjectId).toBe(document.id);
	});

	it('отвергает переименованный HTML и не оставляет файла', async () => {
		const ctx = testActor();
		const before = await storageCounts();

		await expect(
			uploadDocument(ctx, {
				kind: 'agreement',
				title: 'Соглашение',
				file: {
					mime: 'application/pdf',
					bytes: Buffer.from('<html><body>Соглашение</body></html>', 'utf8')
				}
			})
		).rejects.toBeInstanceOf(ValidationError);

		expect(await database.db.select().from(documents)).toEqual([]);
		expect(await storageCounts()).toEqual(before);
	});

	it('требует право на запись', async () => {
		await expect(
			uploadDocument(testActor({ roleId: 'viewer' }), {
				kind: 'agreement',
				title: 'Соглашение',
				file: { mime: 'application/pdf', bytes: pdfBytes }
			})
		).rejects.toBeInstanceOf(ForbiddenError);
	});
});

describe('скачивание', () => {
	it('отдаёт имя файла и пишет событие, а чужой документ не находит', async () => {
		const { interactionId, organizationId } = await interactionWithParty();

		const document = await uploadDocument(testActor(), {
			interactionId,
			kind: 'agreement',
			title: 'Соглашение с МГТУ',
			file: {
				mime: 'application/pdf',
				bytes: Buffer.from('%PDF-1.7\ntrailer\n%%EOF\n', 'latin1')
			}
		});

		const download = await readDocumentForDownload(
			testActor({ roleId: 'manager', organizationIds: [organizationId] }),
			document.id
		);

		expect(download.fileName).toBe('Соглашение с МГТУ.pdf');
		expect(download.sizeBytes).toBe(document.sizeBytes);

		const [event] = await database.db
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'documents.downloaded'));

		expect(event.subjectId).toBe(document.id);

		const stranger = await insertOrganization(database.db, { shortName: 'Чужой вуз' });

		await expect(
			readDocumentForDownload(
				testActor({ roleId: 'manager', organizationIds: [stranger] }),
				document.id
			)
		).rejects.toBeInstanceOf(NotFoundError);

		await expect(readDocumentForDownload(testActor(), crypto.randomUUID())).rejects.toBeInstanceOf(
			NotFoundError
		);
	});
});

describe('отметки по документу', () => {
	it('ставятся один раз, повторная попытка — конфликт', async () => {
		const ctx = testActor();

		const document = await uploadDocument(ctx, {
			kind: 'agreement',
			title: 'Соглашение',
			file: {
				mime: 'application/pdf',
				bytes: Buffer.from('%PDF-1.7\ntrailer\n%%EOF\n', 'latin1')
			}
		});

		const agreedAt = new Date('2026-09-01T10:00:00.000Z');
		const marked = await markDocument(ctx, document.id, 'agreed', agreedAt);

		expect(marked.agreedAt).toEqual(agreedAt);
		expect(marked.approvedAt).toBeNull();

		await expect(markDocument(ctx, document.id, 'agreed')).rejects.toBeInstanceOf(ConflictError);

		// Другой факт по тому же документу ставится независимо.
		const approved = await markDocument(ctx, document.id, 'approved');

		expect(approved.agreedAt).toEqual(agreedAt);
		expect(approved.approvedAt).not.toBeNull();

		const [event] = await database.db
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'documents.status_changed'));

		expect(event.details).toMatchObject({ changedFields: ['agreedAt', 'agreedBy'] });
	});

	it('требует право на запись', async () => {
		const document = await uploadDocument(testActor(), {
			kind: 'agreement',
			title: 'Соглашение',
			file: {
				mime: 'application/pdf',
				bytes: Buffer.from('%PDF-1.7\ntrailer\n%%EOF\n', 'latin1')
			}
		});

		await expect(
			markDocument(testActor({ roleId: 'viewer' }), document.id, 'agreed')
		).rejects.toBeInstanceOf(ForbiddenError);
	});
});
