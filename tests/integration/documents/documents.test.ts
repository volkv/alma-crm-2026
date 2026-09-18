import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import PizZip from 'pizzip';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { moscowDay, moscowDayStart } from '$lib/contracts/calendar';
import {
	documentListQuerySchema,
	markDayBounds,
	markMomentFromDay,
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
import {
	listDocumentRevisions,
	listDocuments,
	listInteractionSupersessions,
	readDocumentForDownload
} from '$lib/server/documents/read';
import { markDocument } from '$lib/server/documents/status';
import { ensureTemplateRegistered } from '$lib/server/documents/templates';
import { uploadDocument, uploadDocumentRevision } from '$lib/server/documents/upload';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '$lib/server/errors';
import type { SessionUser } from '$lib/server/auth/types';
import {
	insertInteractionWithStage,
	insertOrganization,
	startTestDatabase,
	scopedActor,
	testActor,
	TEST_USER_IDS,
	type TestDatabase
} from '../helpers/db';
import { pageEvent, sessionUser } from '../helpers/event';

// См. комментарий в `schema.test.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

const run = promisify(execFile);

/**
 * Маршрут скачивания: проверять его иначе нечем. Право на документ, заголовки
 * ответа и сам поток байтов живут в нём, а не в сервисе.
 */
const downloadEndpoint =
	await import('../../../src/routes/(app)/documents/[id=uuid]/download/+server');
const downloadRoute = downloadEndpoint.GET as unknown as (event: RequestEvent) => Promise<Response>;

/**
 * Действие отметки с карточки документа: разбор формы, перевод дня в момент и
 * перевод предметной ошибки в отказ формы живут в нём, а не в сервисе.
 */
const documentPage = await import('../../../src/routes/(app)/documents/[id=uuid]/+page.server');
const markAction = documentPage.actions.mark as unknown as (
	event: RequestEvent
) => Promise<unknown>;

/** Календарный день, сдвинутый на сутки вперёд или назад. */
function shiftDay(day: string, days: number): string {
	return moscowDay(new Date(moscowDayStart(day).getTime() + days * 24 * 60 * 60 * 1000));
}

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

/** Сколько объектов лежит в хранилище и сколько осталось под временным ключом. */
async function storageCounts(): Promise<{ files: number; tmp: number }> {
	const [files, tmp] = await Promise.all([
		database.storage.keys('files/'),
		database.storage.keys('tmp/')
	]);

	return { files: files.length, tmp: tmp.length };
}

/**
 * Временный файл на диске: `pdftotext` читает файл, а не поток, и хранилище
 * ему не указ.
 */
async function withTempFile<TResult>(
	bytes: Buffer,
	use: (path: string) => Promise<TResult>
): Promise<TResult> {
	const directory = await mkdtemp(join(tmpdir(), 'lct-documents-'));

	try {
		const path = join(directory, 'document.pdf');
		await writeFile(path, bytes);

		return await use(path);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/** Вошедший, у которого нет ни одного права: раздел документов ему не принадлежит. */
function userWithoutPermissions(): SessionUser {
	const user = testActor({ roleId: 'manager', permissions: [] }).user;

	if (user === null) {
		throw new Error('testActor обязан вернуть пользователя');
	}

	return user;
}

/** Событие маршрута скачивания для документа. */
function downloadEvent(documentId: string, user?: SessionUser): RequestEvent {
	return pageEvent({
		path: `/documents/${documentId}/download`,
		routeId: '/(app)/documents/[id=uuid]/download',
		params: { id: documentId },
		user
	});
}

/** Текст документа Word без разметки: подстановки видно как есть. */
function docxText(content: Buffer): string {
	const part = new PizZip(content).file('word/document.xml');

	if (part === null) {
		throw new Error('В пакете нет word/document.xml');
	}

	return part.asText().replace(/<[^>]*>/g, '');
}

/** Ключ объекта, под которым лежит файл документа. */
async function storedKeyOf(documentId: string): Promise<string> {
	const [row] = await database.db
		.select({ filePath: documents.filePath })
		.from(documents)
		.where(eq(documents.id, documentId));

	return row.filePath;
}

async function readStoredDocument(documentId: string): Promise<Buffer> {
	return database.storage.read(await storedKeyOf(documentId));
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

		await database.storage.remove(first.filePath);

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
		const { stdout } = await withTempFile(await readStoredDocument(pdf.id), (path) =>
			run('pdftotext', ['-layout', path, '-'], { maxBuffer: 8 * 1024 * 1024 })
		);

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
			generateDocument(testActor({ roleId: 'manager', permissions: [] }), {
				templateKey: 'agreement',
				title: 'Соглашение',
				data: AGREEMENT,
				formats: ['docx']
			})
		).rejects.toBeInstanceOf(ForbiddenError);

		const other = await insertOrganization(database.db, { shortName: 'Чужой вуз' });

		await expect(
			generateDocument(
				await scopedActor(database.db, { roleId: 'manager', organizationIds: [other] }),
				{
					templateKey: 'agreement',
					interactionId,
					title: 'Соглашение',
					data: AGREEMENT,
					formats: ['docx']
				}
			)
		).rejects.toBeInstanceOf(NotFoundError);

		await expect(
			generateDocument(
				await scopedActor(database.db, { roleId: 'manager', organizationIds: [organizationId] }),
				{
					templateKey: 'agreement',
					interactionId,
					title: 'Соглашение',
					data: AGREEMENT,
					formats: ['docx']
				}
			)
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

	it('кладёт два одинаковых файла в разные объекты', async () => {
		const ctx = testActor();
		const before = await storageCounts();

		const first = await uploadDocument(ctx, {
			kind: 'agreement',
			title: 'Соглашение, экземпляр вуза',
			file: { mime: 'application/pdf', bytes: pdfBytes }
		});
		const second = await uploadDocument(ctx, {
			kind: 'agreement',
			title: 'Соглашение, экземпляр оператора',
			file: { mime: 'application/pdf', bytes: pdfBytes }
		});

		// Хеш у файлов один, а объекты разные: дедупликации по содержимому здесь
		// нет и быть не должно — документы живут своей жизнью, и отметка на одном
		// не относится ко второму.
		expect(second.sha256).toBe(first.sha256);

		const keys = [await storedKeyOf(first.id), await storedKeyOf(second.id)];

		expect(new Set(keys).size).toBe(2);
		// Ключ — случайный идентификатор: ни названия документа, ни имени файла в
		// нём нет, иначе ключи угадывались бы по списку вузов.
		for (const key of keys) {
			expect(key).toMatch(
				/^files\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
			);
		}

		expect(await database.storage.read(keys[0])).toEqual(pdfBytes);
		expect(await database.storage.read(keys[1])).toEqual(pdfBytes);

		const after = await storageCounts();

		expect(after.files).toBe(before.files + 2);
		// Временный объект — это шаг протокола записи, а не след: после удачной
		// записи под временным ключом не остаётся ничего.
		expect(after.tmp).toBe(0);
	});

	it('требует право на запись', async () => {
		await expect(
			uploadDocument(testActor({ roleId: 'manager', permissions: [] }), {
				kind: 'agreement',
				title: 'Соглашение',
				file: { mime: 'application/pdf', bytes: pdfBytes }
			})
		).rejects.toBeInstanceOf(ForbiddenError);
	});
});

describe('редакции документа', () => {
	const pdfBytes = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n', 'latin1');
	const nextBytes = Buffer.from('%PDF-1.7\n2 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n', 'latin1');

	/** Документ взаимодействия и его вторая редакция. */
	async function withRevision() {
		const ctx = testActor();
		const { interactionId, organizationId } = await interactionWithParty();

		const first = await uploadDocument(ctx, {
			interactionId,
			kind: 'agreement',
			title: 'Скан подписанного соглашения',
			file: { mime: 'application/pdf', bytes: pdfBytes }
		});

		const second = await uploadDocumentRevision(ctx, {
			supersedesId: first.id,
			file: { mime: 'application/pdf', bytes: nextBytes }
		});

		return { ctx, interactionId, organizationId, first, second };
	}

	it('наследует название, вид и взаимодействие и пишет отдельное событие', async () => {
		const { first, second, interactionId } = await withRevision();

		expect(second.id).not.toBe(first.id);
		expect(second.supersedesId).toBe(first.id);
		expect(second.title).toBe(first.title);
		expect(second.kind).toBe(first.kind);
		expect(second.interactionId).toBe(interactionId);
		// Файл неизменяем: у редакции свой хеш и свой файл в хранилище.
		expect(second.sha256).not.toBe(first.sha256);
		expect(await readStoredDocument(first.id)).toEqual(pdfBytes);
		expect(await readStoredDocument(second.id)).toEqual(nextBytes);

		const [event] = await database.db
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'documents.version_uploaded'));

		expect(event.subjectId).toBe(second.id);
		expect(event.details).toEqual({
			interactionId,
			documentId: second.id,
			supersededDocumentId: first.id
		});
	});

	it('не даёт заменить одну редакцию дважды', async () => {
		const { ctx, first } = await withRevision();

		await expect(
			uploadDocumentRevision(ctx, {
				supersedesId: first.id,
				file: { mime: 'application/pdf', bytes: nextBytes }
			})
		).rejects.toBeInstanceOf(ConflictError);
	});

	it('отдаёт цепочку от первой редакции к действующей', async () => {
		const { ctx, first, second } = await withRevision();

		const third = await uploadDocumentRevision(ctx, {
			supersedesId: second.id,
			file: { mime: 'application/pdf', bytes: Buffer.from('%PDF-1.7\n3\n%%EOF\n', 'latin1') }
		});

		// Цепочка одна и та же, с какой бы редакции её ни спросили.
		for (const id of [first.id, second.id, third.id]) {
			const chain = await listDocumentRevisions(ctx, id);

			expect(chain.map((item) => item.id)).toEqual([first.id, second.id, third.id]);
			expect(chain.map((item) => item.isCurrent)).toEqual([false, false, true]);
			expect(chain.at(-1)?.authorName).toBe('Тестовый Администратор');
		}
	});

	it('оставляет в списке действующую редакцию, а по запросу показывает обе', async () => {
		const { first, second } = await withRevision();
		const query = documentListQuerySchema.parse({});

		const current = await listDocuments(testActor(), query);
		expect(current.total).toBe(1);
		expect(current.items.map((item) => item.id)).toEqual([second.id]);

		const all = await listDocuments(testActor(), { ...query, revisions: 'all' });
		expect(all.total).toBe(2);

		const replaced = all.items.find((item) => item.id === first.id);
		expect(replaced?.supersededBy?.id).toBe(second.id);
		expect(all.items.find((item) => item.id === second.id)?.supersededBy).toBeNull();
	});

	it('называет замены среди документов взаимодействия', async () => {
		const { ctx, interactionId, first, second } = await withRevision();

		const supersessions = await listInteractionSupersessions(ctx, interactionId);

		expect(supersessions).toHaveLength(1);
		expect(supersessions[0].documentId).toBe(first.id);
		expect(supersessions[0].supersededById).toBe(second.id);
	});

	it('не даёт заменить документ чужого взаимодействия', async () => {
		const { first } = await withRevision();
		const other = await insertOrganization(database.db);

		await expect(
			uploadDocumentRevision(
				await scopedActor(database.db, { roleId: 'manager', organizationIds: [other] }),
				{
					supersedesId: first.id,
					file: { mime: 'application/pdf', bytes: nextBytes }
				}
			)
		).rejects.toBeInstanceOf(NotFoundError);
	});

	it('требует право на запись', async () => {
		const { first } = await withRevision();

		await expect(
			uploadDocumentRevision(testActor({ roleId: 'manager', permissions: [] }), {
				supersedesId: first.id,
				file: { mime: 'application/pdf', bytes: nextBytes }
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
			await scopedActor(database.db, { roleId: 'manager', organizationIds: [organizationId] }),
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
				await scopedActor(database.db, { roleId: 'manager', organizationIds: [stranger] }),
				document.id
			)
		).rejects.toBeInstanceOf(NotFoundError);

		await expect(readDocumentForDownload(testActor(), crypto.randomUUID())).rejects.toBeInstanceOf(
			NotFoundError
		);
	});

	it('отказывается отдавать документ, файла которого нет в хранилище', async () => {
		const ctx = testActor();

		const document = await uploadDocument(ctx, {
			kind: 'agreement',
			title: 'Соглашение без файла',
			file: {
				mime: 'application/pdf',
				bytes: Buffer.from('%PDF-1.7\ntrailer\n%%EOF\n', 'latin1')
			}
		});

		// Так выглядит стенд, которому подменили бакет: строки остались, объектов
		// нет. Молча отдать пустой ответ нельзя — это выглядело бы как пустой файл.
		await database.storage.remove(await storedKeyOf(document.id));

		await expect(readDocumentForDownload(ctx, document.id)).rejects.toThrowError(
			/отсутствует в хранилище/
		);
	});
});

describe('маршрут скачивания', () => {
	const pdfBytes = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n', 'latin1');

	/** Документ вне взаимодействия: проверяется право на раздел, а не область. */
	async function uploadedDocument(): Promise<string> {
		const document = await uploadDocument(testActor(), {
			kind: 'agreement',
			title: 'Соглашение с СЗПУ',
			file: { mime: 'application/pdf', bytes: pdfBytes }
		});

		return document.id;
	}

	it('отдаёт байты и заголовки тому, у кого есть право', async () => {
		const documentId = await uploadedDocument();

		const response = await downloadRoute(downloadEvent(documentId));

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/pdf');
		expect(response.headers.get('content-length')).toBe(String(pdfBytes.byteLength));
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('content-disposition')).toContain(
			`filename*=UTF-8''${encodeURIComponent('Соглашение с СЗПУ.pdf')}`
		);

		// Файл доезжает целиком и ровно тот, который загрузили: ссылки наружу
		// хранилище не выдаёт, байты идут через приложение.
		expect(Buffer.from(await response.arrayBuffer())).toEqual(pdfBytes);
	});

	it('не отдаёт файл тому, у кого нет права на документы', async () => {
		const documentId = await uploadedDocument();

		// Отказ — до хранилища: право проверяется раньше, чем берётся объект.
		await expect(
			downloadRoute(downloadEvent(documentId, userWithoutPermissions()))
		).rejects.toMatchObject({ status: 403 });
	});
});

describe('отметки по документу', () => {
	const markPdf = Buffer.from('%PDF-1.7\ntrailer\n%%EOF\n', 'latin1');

	/** Документ дела, «появившийся в системе» названное число дней назад. */
	async function markable(options: { interactionId?: string; agedDays?: number } = {}) {
		const document = await uploadDocument(testActor(), {
			interactionId: options.interactionId,
			kind: 'agreement',
			title: 'Соглашение',
			file: { mime: 'application/pdf', bytes: markPdf }
		});

		if (options.agedDays !== undefined) {
			// Задним числом отмечают то, что лежит в системе не первый день:
			// документ, загруженный минуту назад, нечем датировать в прошлое.
			const createdAt = new Date(Date.now() - options.agedDays * 24 * 60 * 60 * 1000);

			await database.db.update(documents).set({ createdAt }).where(eq(documents.id, document.id));

			return { id: document.id, createdAt };
		}

		return { id: document.id, createdAt: document.createdAt };
	}

	it('ставятся один раз, повторная попытка — конфликт', async () => {
		const ctx = testActor();
		const document = await markable({ agedDays: 10 });

		const agreedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
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

		expect(event.details).toMatchObject({
			changedFields: ['agreedAt', 'agreedBy', 'agreedNote']
		});
	});

	it('принимает комментарий, показывает его рядом с отметкой и не пишет в журнал', async () => {
		const { interactionId } = await interactionWithParty();
		const document = await markable({ interactionId, agedDays: 3 });
		const day = markDayBounds(document.createdAt).max;
		const note = 'Протокол учёного совета № 14, подписан проректором';

		const result = await markAction(
			pageEvent({
				path: `/documents/${document.id}`,
				params: { id: document.id },
				user: sessionUser('admin'),
				form: { fact: 'approved', at: day, note }
			})
		);

		expect(result).toMatchObject({ ok: true });

		const [row] = await database.db.select().from(documents).where(eq(documents.id, document.id));

		expect(row.approvedNote).toBe(note);
		// Комментарий — текст, который писал человек, и в подробностях события
		// ему места нет: там только имена полей и ссылки на записи.
		const [event] = await database.db
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'documents.status_changed'));

		expect(JSON.stringify(event.details)).not.toContain('учёного совета');
		expect(event.details).toMatchObject({
			changedFields: ['approvedAt', 'approvedBy', 'approvedNote']
		});
	});

	it('принимает день задним числом и отвергает завтрашний и день до документа', async () => {
		const ctx = testActor();
		const document = await markable({ agedDays: 10 });
		const bounds = markDayBounds(document.createdAt);

		// Днём раньше, чем документ появился в системе, согласовывать было нечего.
		await expect(
			markDocument(ctx, document.id, 'agreed', moscowDayStart(shiftDay(bounds.min, -1)))
		).rejects.toBeInstanceOf(ValidationError);

		// Завтрашнего факта не бывает — ни у формы, ни у ключа API.
		await expect(
			markDocument(ctx, document.id, 'agreed', moscowDayStart(shiftDay(bounds.max, 1)))
		).rejects.toBeInstanceOf(ValidationError);

		const marked = await markDocument(
			ctx,
			document.id,
			'agreed',
			markMomentFromDay(bounds.min, new Date())
		);

		expect(marked.agreedAt).not.toBeNull();
		expect(moscowDay(marked.agreedAt ?? new Date())).toBe(bounds.min);
	});

	it('ставится с карточки документа и попадает в журнал', async () => {
		const { interactionId } = await interactionWithParty();
		const document = await markable({ interactionId, agedDays: 3 });
		const day = markDayBounds(document.createdAt).max;

		const result = await markAction(
			pageEvent({
				path: `/documents/${document.id}`,
				params: { id: document.id },
				user: sessionUser('admin'),
				form: { fact: 'approved', at: day }
			})
		);

		expect(result).toMatchObject({ ok: true });

		const [row] = await database.db.select().from(documents).where(eq(documents.id, document.id));

		expect(row.approvedAt).not.toBeNull();
		expect(row.approvedBy).toBe(TEST_USER_IDS.admin);

		// Событие журнала называет и документ, и дело: «в каком взаимодействии
		// это было» спрашивают сразу после «кто отметил».
		const [event] = await database.db
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'documents.status_changed'));

		expect(event.subjectId).toBe(document.id);
		expect(event.details).toMatchObject({ interactionId });
	});

	it('не ставится на документ чужого взаимодействия', async () => {
		const { interactionId } = await interactionWithParty();
		const document = await markable({ interactionId });
		const stranger = await insertOrganization(database.db, { shortName: 'Чужой вуз' });

		await expect(
			markDocument(
				await scopedActor(database.db, { roleId: 'manager', organizationIds: [stranger] }),
				document.id,
				'agreed'
			)
		).rejects.toBeInstanceOf(NotFoundError);
	});

	it('требует право на запись', async () => {
		const document = await markable();

		await expect(
			markDocument(testActor({ roleId: 'manager', permissions: [] }), document.id, 'agreed')
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

	it('не показывает ни чужих взаимодействий, ни документа без взаимодействия', async () => {
		const { organizationId, scan, built, form } = await threeDocuments();

		const own = await listDocuments(
			await scopedActor(database.db, { roleId: 'manager', organizationIds: [organizationId] }),
			listQuery()
		);

		// Документ без взаимодействия виден только полному доступу: один такой
		// файл смешивает строки нескольких вузов, и отдавать его всякому, у кого
		// есть `documents.read`, — утечка.
		expect(own.total).toBe(2);
		expect(own.items.map((item) => item.id).sort()).toEqual([scan.id, built.id].sort());

		const everything = await listDocuments(testActor(), listQuery());
		expect(everything.items.map((item) => item.id)).toContain(form.id);

		const stranger = await insertOrganization(database.db, { shortName: 'Чужой вуз' });
		const outside = await listDocuments(
			await scopedActor(database.db, { roleId: 'manager', organizationIds: [stranger] }),
			listQuery()
		);

		// Ни чужого взаимодействия, ни документа без привязки: последний виден
		// только полному доступу.
		expect(outside.total).toBe(0);
		expect(outside.items).toEqual([]);
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
