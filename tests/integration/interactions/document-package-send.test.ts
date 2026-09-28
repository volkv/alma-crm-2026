/**
 * Пакет документов вузу письмом из карточки дела.
 *
 * Держит один инвариант: письмо уносит только текущие редакции документов
 * пакета этого дела и только контактному лицу основной стороны, а настоящая
 * отправка сама отмечает пункт «Пакет документов отправлен» — тестовое письмо
 * себе его не трогает. Почтовый сервер заменён приёмником в памяти.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	affiliations,
	documents,
	interactionChanges,
	interactionParties
} from '$lib/server/db/schema';
import { promoteBlob, stageBlob } from '$lib/server/documents/storage';
import { ValidationError } from '$lib/server/errors';
import { sendDocumentPackage } from '$lib/server/interactions/document-package-send';
import { getInteractionStatus } from '$lib/server/stages/status';
import { insertPerson, startTestDatabase, testActor, type TestDatabase } from '../helpers/db';
import {
	advanceTo,
	B2B_PROCESS,
	B2B_WORKSPACE_KEY,
	createInteractionOn,
	seedProcess
} from '../stages/fixture';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

const { sendMail } = vi.hoisted(() => ({
	sendMail: vi.fn(async () => ({ messageId: '<package@lct-test.local>' }))
}));

vi.mock('$lib/server/mail/transport', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/mail/transport')>();

	return { ...actual, mailTransport: () => ({ sendMail }) };
});

let database: TestDatabase;

beforeAll(async () => {
	process.env.SMTP_URL = 'smtp://127.0.0.1:1025';
	process.env.SMTP_FROM = 'crm@lct-test.local';

	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();
	sendMail.mockClear();
});

/** Документ пакета, как его оставила бы сборка: PDF по шаблону в хранилище. */
async function insertBuilt(interactionId: string, supersedesId: string | null = null) {
	const blob = await stageBlob(new TextEncoder().encode('%PDF-1.4\n%package'), 'application/pdf');

	await promoteBlob(blob);

	const [row] = await database.db
		.insert(documents)
		.values({
			interactionId,
			supersedesId,
			kind: 'generated',
			templateKey: 'agreement',
			title: 'Соглашение о сотрудничестве',
			filePath: blob.relativePath,
			mime: blob.mime,
			sizeBytes: blob.sizeBytes,
			sha256: blob.sha256
		})
		.returning({ id: documents.id });

	return row.id;
}

describe('пакет документов вузу', () => {
	it('уходит текущей редакцией контакту стороны и сам отмечает пункт', async () => {
		const ctx = testActor({ roleId: 'admin' });

		await seedProcess(database, B2B_WORKSPACE_KEY, B2B_PROCESS);

		const { interactionId, organizationId } = await createInteractionOn(ctx, database);
		const personId = await insertPerson(database.db, {
			lastName: 'Иванова',
			email: 'prorector@vuz.example'
		});
		const [contact] = await database.db
			.insert(affiliations)
			.values({
				personId,
				organizationId,
				position: 'Проректор',
				roleKind: 'vice_rector',
				validFrom: '2026-01-01'
			})
			.returning({ id: affiliations.id });

		await database.db
			.update(interactionParties)
			.set({ contactAffiliationId: contact.id })
			.where(eq(interactionParties.interactionId, interactionId));
		await advanceTo(ctx, database, interactionId, 'document_exchange');

		const before = (await getInteractionStatus(ctx, interactionId)).current;

		expect(before?.snapshot.key).toBe('document_exchange');
		expect(before?.facts.package_generated?.done).toBe(false);

		const first = await insertBuilt(interactionId);
		const current = await insertBuilt(interactionId, first);

		// Заменённая редакция — не пакет: отказ всей отправки, письмо не уходит.
		await expect(
			sendDocumentPackage(ctx, {
				interactionId,
				recipientIds: [contact.id],
				documentIds: [first],
				test: false
			})
		).rejects.toBeInstanceOf(ValidationError);
		expect(sendMail).not.toHaveBeenCalled();

		// Тестовое себе — пункт не трогает.
		await expect(
			sendDocumentPackage(ctx, {
				interactionId,
				recipientIds: [contact.id],
				documentIds: [current],
				test: true
			})
		).resolves.toMatchObject({ status: 'sent', test: true, checklistMarked: false });
		expect(
			(await getInteractionStatus(ctx, interactionId)).current?.checklistState.package_sent
		).not.toBe(true);

		sendMail.mockClear();

		const outcome = await sendDocumentPackage(ctx, {
			interactionId,
			recipientIds: [contact.id],
			documentIds: [current],
			test: false
		});

		expect(outcome).toStrictEqual({
			status: 'sent',
			test: false,
			sentCount: 1,
			failed: [],
			checklistMarked: true
		});

		const [mail] = sendMail.mock.calls[0] as unknown as [
			{ to: { address: string }[]; attachments: { filename: string }[] }
		];

		expect(mail.to.map((recipient) => recipient.address)).toStrictEqual(['prorector@vuz.example']);
		expect(mail.attachments.map((attachment) => attachment.filename)).toStrictEqual([
			'Соглашение о сотрудничестве.pdf'
		]);

		const [feed] = await database.db
			.select()
			.from(interactionChanges)
			.where(eq(interactionChanges.field, 'document_package'));

		// Адрес и ФИО получателя в след не попадают.
		expect(JSON.stringify(feed.newValue)).not.toContain('prorector@vuz.example');
		expect(JSON.stringify(feed.newValue)).not.toContain('Иванова');

		const after = (await getInteractionStatus(ctx, interactionId)).current;

		expect(after?.facts.package_generated?.done).toBe(true);
		expect(after?.checklistState.package_sent).toBe(true);
	});
});
