import { execFile } from 'node:child_process';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import PizZip from 'pizzip';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	documentListQuerySchema,
	type DocumentListQuery,
	type DocumentView
} from '$lib/contracts/documents';
import {
	auditEvents,
	documentTemplates,
	documents,
	interactionParties,
	interactions
} from '$lib/server/db/schema';
import { generateDocument } from '$lib/server/documents/generate';
import { listDocuments, readDocumentForDownload } from '$lib/server/documents/read';
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
			title: 'Соглашение с СЗПУ',
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
			title: 'Соглашение с СЗПУ',
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
			title: 'Соглашение с СЗПУ',
			file: {
				mime: 'application/pdf',
				bytes: Buffer.from('%PDF-1.7\ntrailer\n%%EOF\n', 'latin1')
			}
		});

		const download = await readDocumentForDownload(
			testActor({ roleId: 'manager', organizationIds: [organizationId] }),
			document.id
		);

		expect(download.fileName).toBe('Соглашение с СЗПУ.pdf');
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

describe('отметка активности взаимодействия', () => {
	const pdfBytes = Buffer.from('%PDF-1.7\ntrailer\n%%EOF\n', 'latin1');

	/** Отметка, отодвинутая в прошлое: иначе «двинулась» не отличить от «была». */
	async function staleInteraction(): Promise<{ interactionId: string; at: Date }> {
		const { interactionId } = await interactionWithParty();
		const at = new Date('2026-01-01T00:00:00.000Z');

		await database.db
			.update(interactions)
			.set({ lastActivityAt: at })
			.where(eq(interactions.id, interactionId));

		return { interactionId, at };
	}

	async function lastActivityAt(interactionId: string): Promise<Date> {
		const [row] = await database.db
			.select({ at: interactions.lastActivityAt })
			.from(interactions)
			.where(eq(interactions.id, interactionId));

		return row.at;
	}

	it('двигает её загрузка документа', async () => {
		const { interactionId, at } = await staleInteraction();

		await uploadDocument(testActor(), {
			interactionId,
			kind: 'agreement',
			title: 'Скан подписанного соглашения',
			file: { mime: 'application/pdf', bytes: pdfBytes }
		});

		// Протухание — про тишину вокруг записи, а работа с её документами тишиной
		// не является: иначе карточка позовёт поторопить того, кто как раз занят.
		expect((await lastActivityAt(interactionId)).getTime()).toBeGreaterThan(at.getTime());
	});

	it('двигает её генерация документа', async () => {
		const { interactionId, at } = await staleInteraction();

		await generateDocument(testActor(), {
			templateKey: 'agreement',
			interactionId,
			title: 'Соглашение',
			data: AGREEMENT,
			formats: ['docx']
		});

		expect((await lastActivityAt(interactionId)).getTime()).toBeGreaterThan(at.getTime());
	});

	it('двигает её отметка по документу', async () => {
		const { interactionId } = await interactionWithParty();

		const document = await uploadDocument(testActor(), {
			interactionId,
			kind: 'agreement',
			title: 'Соглашение',
			file: { mime: 'application/pdf', bytes: pdfBytes }
		});

		const at = new Date('2026-01-01T00:00:00.000Z');
		await database.db
			.update(interactions)
			.set({ lastActivityAt: at })
			.where(eq(interactions.id, interactionId));

		await markDocument(testActor(), document.id, 'agreed');

		expect((await lastActivityAt(interactionId)).getTime()).toBeGreaterThan(at.getTime());
	});
});

describe('список документов', () => {
	const pdfBytes = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n', 'latin1');

	/** Полный запрос списка: значения по умолчанию плюс то, что проверяет тест. */
	function listQuery(overrides: Partial<DocumentListQuery> = {}): DocumentListQuery {
		return { ...documentListQuerySchema.parse({}), ...overrides };
	}

	/**
	 * Три документа: загруженный и собранный по шаблону — по взаимодействию,
	 * третий — вне его. На этом наборе видно и вид, и формат, и область доступа.
	 */
	async function threeDocuments(): Promise<{
		interactionId: string;
		organizationId: string;
		scan: DocumentView;
		built: DocumentView;
		form: DocumentView;
	}> {
		const ctx = testActor();
		const { interactionId, organizationId } = await interactionWithParty();

		const scan = await uploadDocument(ctx, {
			interactionId,
			kind: 'agreement',
			title: 'Скан соглашения',
			file: { mime: 'application/pdf', bytes: pdfBytes }
		});

		// Только DOCX: он собирается в памяти, PDF ушёл бы в Gotenberg, а
		// проверяется здесь список, а не конвертация.
		const [built] = await generateDocument(ctx, {
			templateKey: 'agreement',
			interactionId,
			title: 'Соглашение по шаблону',
			data: AGREEMENT,
			formats: ['docx']
		});

		const form = await uploadDocument(ctx, {
			kind: 'report_form',
			title: 'Типовая форма отчёта',
			file: { mime: 'application/pdf', bytes: pdfBytes }
		});

		return { interactionId, organizationId, scan, built, form };
	}

	it('отдаёт строки с видом, взаимодействием и автором', async () => {
		const { interactionId, scan, built, form } = await threeDocuments();

		const page = await listDocuments(testActor(), listQuery());

		expect(page.total).toBe(3);
		expect(page.page).toBe(1);
		expect(page.items).toHaveLength(3);

		const uploaded = page.items.find((item) => item.id === scan.id);

		expect(uploaded?.kind).toBe('uploaded');
		// Вид, названный человеком, из списка не пропадает: он единственный,
		// кто отличает акт от отчёта.
		expect(uploaded?.uploadedKind).toBe('agreement');
		expect(uploaded?.interaction).toEqual({
			id: interactionId,
			title: 'Тестовое взаимодействие'
		});
		expect(uploaded?.authorName).toBe('Тестовый Администратор');
		expect(uploaded?.sizeBytes).toBe(pdfBytes.byteLength);

		const generated = page.items.find((item) => item.id === built.id);

		expect(generated?.kind).toBe('generated');
		expect(generated?.uploadedKind).toBeNull();

		// Документ вне взаимодействия ссылки на карточку не получает.
		expect(page.items.find((item) => item.id === form.id)?.interaction).toBeNull();
	});

	it('не показывает документы чужих взаимодействий, а документ вне взаимодействия показывает', async () => {
		const { organizationId, scan, built, form } = await threeDocuments();

		const own = await listDocuments(
			testActor({ roleId: 'manager', organizationIds: [organizationId] }),
			listQuery()
		);

		expect(own.total).toBe(3);
		expect(own.items.map((item) => item.id).sort()).toEqual([scan.id, built.id, form.id].sort());

		const stranger = await insertOrganization(database.db, { shortName: 'Чужой вуз' });
		const outside = await listDocuments(
			testActor({ roleId: 'manager', organizationIds: [stranger] }),
			listQuery()
		);

		// Область доступа не применяется только к документу без взаимодействия:
		// это типовая форма оператора, а не имущество организации.
		expect(outside.total).toBe(1);
		expect(outside.items.map((item) => item.id)).toEqual([form.id]);
	});

	it('отбирает по виду, формату и отметкам', async () => {
		const ctx = testActor();
		const { scan, built, form } = await threeDocuments();

		await markDocument(ctx, scan.id, 'agreed');

		const uploaded = await listDocuments(ctx, listQuery({ kind: 'uploaded' }));
		expect(uploaded.items.map((item) => item.id).sort()).toEqual([scan.id, form.id].sort());

		const generated = await listDocuments(ctx, listQuery({ kind: 'generated' }));
		expect(generated.items.map((item) => item.id)).toEqual([built.id]);

		const docx = await listDocuments(ctx, listQuery({ format: 'docx' }));
		expect(docx.items.map((item) => item.id)).toEqual([built.id]);

		const pdf = await listDocuments(ctx, listQuery({ format: 'pdf' }));
		expect(pdf.items.map((item) => item.id).sort()).toEqual([scan.id, form.id].sort());

		const agreed = await listDocuments(ctx, listQuery({ fact: 'agreed' }));
		expect(agreed.items.map((item) => item.id)).toEqual([scan.id]);

		const untouched = await listDocuments(ctx, listQuery({ fact: 'none' }));
		expect(untouched.items.map((item) => item.id).sort()).toEqual([built.id, form.id].sort());
	});

	it('сортирует по названию в обе стороны и ищет по названию взаимодействия', async () => {
		await threeDocuments();
		const ctx = testActor();

		const ascending = await listDocuments(
			ctx,
			listQuery({ sortBy: 'title', sortDirection: 'asc' })
		);

		expect(ascending.items.map((item) => item.title)).toEqual([
			'Скан соглашения',
			'Соглашение по шаблону',
			'Типовая форма отчёта'
		]);

		const descending = await listDocuments(
			ctx,
			listQuery({ sortBy: 'title', sortDirection: 'desc' })
		);

		expect(descending.items.map((item) => item.title)).toEqual([
			'Типовая форма отчёта',
			'Соглашение по шаблону',
			'Скан соглашения'
		]);

		// Файл ищут по делу, к которому он приложен, не реже, чем по названию.
		const byInteraction = await listDocuments(ctx, listQuery({ q: 'Тестовое взаимодействие' }));

		expect(byInteraction.total).toBe(2);
		expect(byInteraction.items.map((item) => item.title).sort()).toEqual([
			'Скан соглашения',
			'Соглашение по шаблону'
		]);
	});

	it('требует право на чтение документов', async () => {
		await expect(listDocuments(testActor({ permissions: [] }), listQuery())).rejects.toBeInstanceOf(
			ForbiddenError
		);
	});
});
