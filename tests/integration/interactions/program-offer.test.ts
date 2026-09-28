/**
 * Описание программ вузу письмом из карточки дела.
 *
 * Держит один инвариант: письмо уходит только контактному лицу основной
 * стороны этого дела, а настоящая отправка оставляет в деле след без адресов
 * и сама закрывает пункт «Отправлено описание программ». Почтовый сервер
 * заменён приёмником в памяти: проверяется, что и кому передано, а не SMTP.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	affiliations,
	interactionChanges,
	interactionParties,
	programOfferSends
} from '$lib/server/db/schema';
import { addProgramMaterials } from '$lib/server/directory/program-materials';
import { ValidationError } from '$lib/server/errors';
import { sendProgramOffer } from '$lib/server/interactions/program-offer';
import { getInteractionStatus } from '$lib/server/stages/status';
import {
	insertOrganization,
	insertPerson,
	startTestDatabase,
	testActor,
	type TestDatabase
} from '../helpers/db';
import {
	advanceTo,
	B2B_PROCESS,
	B2B_WORKSPACE_KEY,
	createInteractionOn,
	ensureInteractionProgram,
	seedProcess
} from '../stages/fixture';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

const { sendMail } = vi.hoisted(() => ({
	sendMail: vi.fn(async () => ({ messageId: '<offer@lct-test.local>' }))
}));

vi.mock('$lib/server/mail/transport', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/mail/transport')>();

	return { ...actual, mailTransport: () => ({ sendMail }) };
});

let database: TestDatabase;

beforeAll(async () => {
	// Конфигурация читается один раз: адрес почты — раньше первого чтения.
	// Петля — узел почтовой ловушки, поэтому песочница письмо пропускает.
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

async function insertContact(organizationId: string, email: string): Promise<string> {
	const personId = await insertPerson(database.db, { lastName: 'Иванова', email });
	const [row] = await database.db
		.insert(affiliations)
		.values({
			personId,
			organizationId,
			position: 'Проректор',
			roleKind: 'vice_rector',
			validFrom: '2026-01-01'
		})
		.returning({ id: affiliations.id });

	return row.id;
}

describe('описание программ вузу', () => {
	it('уходит только контакту стороны, оставляет след без адресов и закрывает пункт', async () => {
		const ctx = testActor({ roleId: 'admin' });

		await seedProcess(database, B2B_WORKSPACE_KEY, B2B_PROCESS);

		const { interactionId, organizationId } = await createInteractionOn(ctx, database);
		const contactId = await insertContact(organizationId, 'prorector@vuz.example');
		const strangerId = await insertContact(
			await insertOrganization(database.db, { shortName: 'Чужой вуз' }),
			'stranger@other.example'
		);

		await database.db
			.update(interactionParties)
			.set({ contactAffiliationId: contactId })
			.where(eq(interactionParties.interactionId, interactionId));

		const programId = await ensureInteractionProgram(database, interactionId);

		await addProgramMaterials(ctx, programId, [
			{
				name: 'Программа курса.pdf',
				mime: 'application/pdf',
				bytes: new TextEncoder().encode('%PDF-1.4\n%offer')
			}
		]);
		await advanceTo(ctx, database, interactionId, 'communication');

		const before = (await getInteractionStatus(ctx, interactionId)).current;

		expect(before?.snapshot.key).toBe('communication');
		expect(before?.facts.offer_sent?.done).toBe(false);

		// Контакт другой организации — отказ всей отправки, письмо не уходит.
		await expect(
			sendProgramOffer(ctx, { interactionId, recipientIds: [strangerId], test: false })
		).rejects.toBeInstanceOf(ValidationError);
		expect(sendMail).not.toHaveBeenCalled();

		// Тестовое письмо себе — только журнал: в деле следа нет.
		await expect(
			sendProgramOffer(ctx, { interactionId, recipientIds: [contactId], test: true })
		).resolves.toMatchObject({ status: 'sent', test: true });
		expect(sendMail).toHaveBeenCalledTimes(1);
		expect(await database.db.select().from(programOfferSends)).toHaveLength(0);

		sendMail.mockClear();

		const outcome = await sendProgramOffer(ctx, {
			interactionId,
			recipientIds: [contactId],
			test: false
		});

		expect(outcome).toStrictEqual({ status: 'sent', test: false, sentCount: 1, failed: [] });
		expect(sendMail).toHaveBeenCalledTimes(1);

		const [mail] = sendMail.mock.calls[0] as unknown as [
			{ to: { address: string }[]; attachments: { filename: string }[]; html: string }
		];

		expect(mail.to.map((recipient) => recipient.address)).toStrictEqual(['prorector@vuz.example']);
		expect(mail.attachments.map((attachment) => attachment.filename)).toStrictEqual([
			'Программа курса.pdf'
		]);

		const [send] = await database.db.select().from(programOfferSends);

		expect(send.interactionId).toBe(interactionId);
		expect(send.stageEntryId).toBe(before?.id);
		expect(send.recipients).toStrictEqual([
			{ affiliationId: contactId, personId: expect.any(String) }
		]);
		expect(send.documents).toHaveLength(1);
		// Адрес и ФИО получателя в след не попадают: они живут только в `people`.
		expect(JSON.stringify(send)).not.toContain('prorector@vuz.example');
		expect(JSON.stringify(send)).not.toContain('Иванова');

		const feed = await database.db
			.select()
			.from(interactionChanges)
			.where(eq(interactionChanges.field, 'program_offer'));

		expect(feed).toHaveLength(1);

		const after = (await getInteractionStatus(ctx, interactionId)).current;

		expect(after?.facts.offer_sent?.done).toBe(true);
		expect(after?.facts.offer_sent?.evidence).toMatch(/^Отправлено .+ — 1 получатель$/);
	});
});
